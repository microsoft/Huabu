/**
 * `AcpAgentHandle` — the {@link AgentHandle} implementation for the
 * external, ACP-connected backend (the "Deployment" driver).
 *
 * This is the canonical home for the external agent's *execution* logic:
 * the per-update callback → queue bridge, the `session/update` →
 * `AgentStreamEvent` translation, the wire-ordered content-block assembly
 * that becomes the persisted assistant message, and the terminal
 * done/error frame. `runAcpAgent` (acp/service.ts) is now a thin
 * composition shell that opens/reuses the session, builds the render
 * closure, and drives one `run(...)` against the long-lived handle.
 *
 * Lifecycle (§3.2 / M2.6): the ACP path is a **Deployment** — a
 * long-lived, stateful session that hosts *many* turns, carries
 * cross-turn `control`, and has a liveness dimension a Job never has. So
 * the handle itself is long-lived: `AgentRuntime` holds it across turns
 * keyed by `threadId`, and it is addressable out-of-turn for `control()`
 * / `close()`. Its backing {@link AcpSessionEntry} is re-resolved *per
 * turn* (the shell's `ensureAcpSession` get-or-create) and handed in on
 * the {@link AcpTurnCtx} — so the handle never captures a stale entry.
 * Out-of-turn (`control` / `close`) it resolves the live entry from the
 * host `acpSessionRegistry` by `threadId` (a precondition failure when no
 * session is live — we do not lazily spawn one just to, e.g., set a mode).
 *
 * The heavy session-open logic (`ensureAcpSession`'s ~11 host imports)
 * stays in the composition shell; this class only touches the ready entry
 * (via the turn ctx) and the registry lookup. Two session-lifecycle side
 * effects that reach back into the composition layer's persistence —
 * promoting the entry to a durable record on first success — are injected
 * as {@link AcpTurnCtx} callbacks rather than imported (which would
 * circularly depend on the shell). Moving session construction behind a
 * clean `create(spec)` factory is deferred to M4/M5.
 *
 * See docs/proposals/layered-architecture.md §3.6 / §7 (M2 / M2.6).
 */

import { fauxAssistantMessage } from '@earendil-works/pi-ai';

import { acpSessionRegistry } from '../acp/session-registry.js';
import {
  acpUpdateToStreamEvent,
  mergeThinkingChunk,
} from '@agenetes/acp-driver';
import { applyToolExt } from '../store/chat-thread-store.js';

import type {
  AgentHandle,
  AgentRequest,
  InStreamEvent,
  RenderFn,
} from './handle.js';
import type { AcpSessionEntry } from '../acp/session-registry.js';
import type { ContentPart } from '../conversation/prompt/attachments.js';
import type { AcpTurnOverlay } from '../store/chat-thread-store.js';
import type {
  AgentCapabilities,
  AgentStreamEvent,
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { AcpPlanEntry } from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The external path's render output: the deterministic ACP prompt payload
 * derived from this turn's envelope. `blocks` is what goes on the wire;
 * `serialized` is the text form (debug logs); `includedSystem` drives the
 * one-shot system-preamble flip on success; `preparedError` records a
 * preprocessor fall-back for the dispatch log.
 */
export interface PreparedAcpPrompt {
  serialized: string;
  includedSystem: boolean;
  blocks: ContentPart[];
  preparedError?: string;
}

/** The per-turn context an {@link AcpAgentHandle.run} accepts. */
export interface AcpTurnCtx {
  /**
   * The live ACP session for THIS turn, re-resolved by the composition
   * shell (`ensureAcpSession` get-or-create) and handed in per turn so the
   * long-lived handle never captures a stale entry.
   */
  entry: AcpSessionEntry;
  /**
   * Mutable per-turn ACP overlay (tool extensions keyed by `toolCallId`
   * + the turn's plan). Route-owned; mutated in place as events arrive
   * and folded into the persisted turn record by the route.
   */
  overlay: AcpTurnOverlay;
  /** Cancellation signal — wired through to `session/cancel`. */
  signal?: AbortSignal;
  logger: FastifyBaseLogger;
  /**
   * Invoked once the `session/prompt` promise resolves successfully,
   * before the terminal frame. The composition layer wires this to
   * `promoteEntryToPersisted(entry, logger)` — a registry/persistence
   * side effect kept out of the driver to avoid a circular import.
   */
  onPromptSettled?: () => void;
  /**
   * Optional developer aid invoked with the serialized prompt payload the
   * moment after `render` runs. Lets the composition layer dump the
   * assembled prompt without this handle importing the host's
   * prompt-debug util. No-op when omitted.
   */
  onPrepared?: (serialized: string) => void;
}

/** The full control set an ACP Deployment honours. */
const ACP_CONTROL_OPS: AgentCapabilities['control'] = [
  'cancel',
  'set_mode',
  'set_model',
  'set_config_option',
  'answer_permission',
];

/**
 * The capability descriptor every {@link AcpAgentHandle} advertises — a
 * Deployment with the full control set and session-load. Hoisted so the
 * ACP driver (`./drivers.ts`) can advertise it before a handle instance
 * exists.
 */
export const ACP_CAPABILITIES: AgentCapabilities = {
  control: ACP_CONTROL_OPS,
  loadSession: true,
  turnInput: 'blocking',
};

/** ACP stop reasons we know about; mapped onto pi-ai `stopReason`. */
function mapStopReason(
  reason: string | undefined,
  aborted: boolean,
): AssistantMessage['stopReason'] {
  if (aborted || reason === 'cancelled') return 'aborted';
  if (reason === 'max_tokens') return 'length';
  // Default to 'stop' for end_turn, max_turn_requests, refusal, anything else.
  return 'stop';
}

/**
 * The ACP-backed {@link AgentHandle} — a long-lived Deployment. Holds only
 * its `threadId`; the live {@link AcpSessionEntry} for a turn arrives on
 * the {@link AcpTurnCtx} ({@link run}), and out-of-turn ops resolve the
 * live session from `acpSessionRegistry` by `threadId`.
 */
export class AcpAgentHandle implements AgentHandle<
  PreparedAcpPrompt,
  AcpTurnCtx
> {
  /**
   * A Deployment advertises the full control set and can resume a prior
   * session (`session/load`). It accepts turn input blocking (the ACP
   * baseline: `session/prompt` always elicits a model turn).
   */
  readonly capabilities: AgentCapabilities = ACP_CAPABILITIES;

  constructor(private readonly threadId: string) {}

  async *run(
    request: AgentRequest | null,
    render: RenderFn<PreparedAcpPrompt>,
    ctx: AcpTurnCtx,
  ): AsyncGenerator<InStreamEvent, Message[]> {
    const { entry, overlay, signal, logger, onPromptSettled, onPrepared } = ctx;

    // ACP always needs fresh input — a `session/prompt` with nothing to
    // say is meaningless. A null request (no new input / resume-only) is
    // rejected by this driver (the interface allows null; its meaning is
    // driver-defined — see AgentHandle.run).
    if (request === null) {
      yield {
        type: 'error',
        data: {
          error:
            'AcpAgentHandle requires a request (resume-without-input is unsupported)',
        },
      };
      return [];
    }

    // Render THIS turn's envelope into ACP wire blocks (the composition
    // layer's render closure owns the preprocessor + raw-text fallback, so
    // `blocks` is always valid here).
    const prepared = await render(request);
    onPrepared?.(prepared.serialized);

    // Bridge the per-update callback into an async iterable via a queue.
    const queue: AgentStreamEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    let assembledText = '';
    let promptError: unknown = null;
    let stopReason: string | undefined;
    let done = false;

    // `contentBlocks` accumulates text / thinking / tool-call blocks in
    // WIRE ORDER; it becomes the persisted `fauxAssistantMessage`, so a
    // refresh preserves interleaving + thinking blocks + tool-call order.
    // `sidecar` enrichment (toolKind / status / plan) accumulates into the
    // route-owned `overlay` as events arrive.
    type AssistantContentBlock =
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | {
          type: 'toolCall';
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        };
    const contentBlocks: AssistantContentBlock[] = [];
    // THIS turn's assembled assistant message(s), RETURNED as the
    // generator's value. Filled in the `finally` so a partial reply
    // survives abort/error.
    const outMessages: Message[] = [];
    const toolCallByCallId = new Map<
      string,
      Extract<AssistantContentBlock, { type: 'toolCall' }>
    >();
    // Plan entries are staged until the turn ends (full-replacement wire
    // semantics: latest plan wins).
    let pendingPlan: AcpPlanEntry[] | null = null;

    const wake = () => {
      if (resolveWaiter) {
        const fn = resolveWaiter;
        resolveWaiter = null;
        fn();
      }
    };

    logger.info(
      {
        sessionId: entry.sessionId,
        profileId: entry.profileId,
        promptLength: prepared.serialized.length,
        preprocessed: !prepared.preparedError,
      },
      '[acp] session/prompt dispatch',
    );

    void entry.client
      .prompt(
        entry.sessionId,
        prepared.blocks,
        (update) => {
          const evt = acpUpdateToStreamEvent(update, logger);
          if (!evt) {
            logger.info(
              { sessionUpdate: update.sessionUpdate, raw: update },
              '[acp] untranslated session/update — dropped',
            );
            return;
          }
          if (evt.type === 'text_delta') {
            assembledText += evt.data.content;
            const last = contentBlocks[contentBlocks.length - 1];
            if (last?.type === 'text') {
              last.text += evt.data.content;
            } else {
              contentBlocks.push({ type: 'text', text: evt.data.content });
            }
          } else if (evt.type === 'thinking_delta') {
            const last = contentBlocks[contentBlocks.length - 1];
            if (last?.type === 'thinking') {
              last.thinking = mergeThinkingChunk(
                last.thinking,
                evt.data.content,
              );
            } else {
              contentBlocks.push({
                type: 'thinking',
                thinking: evt.data.content,
              });
            }
          } else if (evt.type === 'tool_call') {
            applyToolExt(overlay, evt.data.toolCallId, {
              toolKind: evt.data.toolKind,
              status: evt.data.status,
              locations: evt.data.locations,
              content: evt.data.content,
              rawOutput: undefined,
            });
            // `rawInput` may be any JSON shape; pi-ai's `ToolCall.arguments`
            // requires a plain object, so narrow defensively.
            const rawInput = evt.data.rawInput;
            const args: Record<string, unknown> =
              rawInput !== null &&
              typeof rawInput === 'object' &&
              !Array.isArray(rawInput)
                ? (rawInput as Record<string, unknown>)
                : {};
            const block: Extract<AssistantContentBlock, { type: 'toolCall' }> =
              {
                type: 'toolCall',
                id: evt.data.toolCallId,
                name: evt.data.title || evt.data.toolKind || 'tool',
                arguments: args,
              };
            contentBlocks.push(block);
            toolCallByCallId.set(evt.data.toolCallId, block);
          } else if (evt.type === 'tool_call_update') {
            applyToolExt(overlay, evt.data.toolCallId, {
              status: evt.data.status,
              locations: evt.data.locations,
              content: evt.data.content,
              rawOutput: evt.data.rawOutput,
            });
            // ACP allows refining the title mid-flight (e.g. "Reading"
            // → "Reading app.ts"); mirror onto the persisted block.
            if (evt.data.title) {
              const tc = toolCallByCallId.get(evt.data.toolCallId);
              if (tc) tc.name = evt.data.title;
            }
          } else if (evt.type === 'plan') {
            // Full-replacement wire semantics: latest plan wins.
            // Staged until the assistant timestamp is known (finally).
            pendingPlan = evt.data.entries;
          }
          queue.push(evt);
          wake();
        },
        signal,
        // Surface agent permission requests as a transient SSE event.
        // The client owns the suspended promise + resolution; we only
        // push the request onto the drain queue. Not persisted to the
        // sidecar — permission prompts are live-only interactions.
        (req) => {
          queue.push({ type: 'permission_request', data: req });
          wake();
        },
      )
      .then((result) => {
        stopReason = result.stopReason;
        // First-prompt promotion: now that the agent has processed a user
        // turn its session is genuinely recoverable. Injected so the driver
        // stays free of the registry/persistence layer.
        onPromptSettled?.();
        // Mark the one-shot system preamble delivered, but only if this
        // turn actually carried it — a failed turn or slash-command
        // short-circuit leaves the flag untouched so the next real turn
        // re-sends it.
        if (prepared.includedSystem) entry.systemPreambleSent = true;
      })
      .catch((err: unknown) => {
        promptError = err;
      })
      .finally(() => {
        done = true;
        wake();
      });

    try {
      // Drain the queue as updates arrive.
      while (true) {
        while (queue.length > 0) {
          const evt = queue.shift();
          // The translator's return type is the full `AgentStreamEvent`
          // union, but `meta`/`end` are transport-synthesized by the route,
          // never emitted here — narrow to the in-stream union we advertise.
          if (evt && evt.type !== 'meta' && evt.type !== 'end') yield evt;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
        });
      }

      // Visibility fallback for "empty" turns. External agents can finish
      // a turn with zero text (e.g. a tool-only Read/Glob/Bash chain).
      // Synthesize a single explanatory `text_delta` whenever the agent
      // produced no text AND we're not about to surface an error or abort,
      // so the UI doesn't look hung.
      const aborted = signal?.aborted ?? false;
      if (assembledText.length === 0 && !promptError && !aborted) {
        const reason = stopReason ?? 'unknown';
        const synthetic = `_(agent returned no text — stopReason: ${reason}. Usually a tool-only turn or a refusal without prose. Extend the ACP translator if you need tool-call rendering.)_`;
        assembledText = synthetic;
        contentBlocks.push({ type: 'text', text: synthetic });
        yield { type: 'text_delta', data: { content: synthetic } };
      }
    } finally {
      // Persist assistant output. `contentBlocks` is already in wire order,
      // so we hand it straight to pi-ai. Mirrors the built-in path's
      // `finally` so partial replies survive abort/error.
      if (contentBlocks.length > 0) {
        const aborted = signal?.aborted ?? false;
        const timestamp = Date.now();
        outMessages.push(
          fauxAssistantMessage(contentBlocks, {
            stopReason: mapStopReason(stopReason, aborted),
            timestamp,
          }),
        );
      }
      // Commit the turn's plan (full-replacement; latest wins) into the
      // route-owned overlay. Tool extensions were accumulated as events
      // arrived.
      if (pendingPlan) {
        overlay.plan = pendingPlan;
        pendingPlan = null;
      }
    }

    // Yield terminal event — error wins over done.
    if (promptError) {
      const msg =
        promptError instanceof Error
          ? promptError.message
          : String(promptError);
      logger.warn(
        { sessionId: entry.sessionId, err: msg },
        '[acp] session/prompt failed',
      );
      yield { type: 'error', data: { error: msg } };
      return outMessages;
    }

    yield {
      type: 'done',
      data: {
        message: assembledText,
        meta: { stopReason },
      },
    };
    return outMessages;
  }

  async control(msg: ControlMsg): Promise<ControlAck> {
    if (!this.capabilities.control.includes(msg.type)) {
      return {
        ok: false,
        error: `unsupported control operation: ${msg.type}`,
        code: 'unsupported',
      };
    }
    // Resolve the live session out-of-turn. A control op with no live
    // session to act on is a precondition failure — we do NOT lazily spawn
    // one just to, e.g., set a mode (§3.6.2 / M2.6).
    const entry = acpSessionRegistry.get(this.threadId);
    if (!entry) {
      return {
        ok: false,
        error: `no active ACP session for thread ${this.threadId}`,
        code: 'not_found',
      };
    }
    const { client, sessionId } = entry;
    try {
      switch (msg.type) {
        case 'cancel':
          await client.cancel(sessionId);
          return { ok: true };
        case 'set_mode':
          await client.setSessionMode(sessionId, msg.data.modeId);
          return { ok: true };
        case 'set_model':
          await client.setSessionModel(sessionId, msg.data.modelId);
          return { ok: true };
        case 'set_config_option':
          await client.setSessionConfigOption(
            sessionId,
            msg.data.optionId,
            msg.data.value,
          );
          return { ok: true };
        case 'answer_permission': {
          const matched = client.resolvePermission(
            msg.data.requestId,
            msg.data.decision,
          );
          return matched
            ? { ok: true }
            : {
                ok: false,
                error: `no pending permission request: ${msg.data.requestId}`,
                code: 'not_found',
              };
        }
        default:
          return {
            ok: false,
            error: `unsupported control operation: ${(msg as ControlMsg).type}`,
            code: 'unsupported',
          };
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Tear down the long-lived session: drop the live ACP entry for this
   * `threadId` (which `shutdown()`s the client) and evict it from the
   * registry. Idempotent — a no-op when no session is live.
   */
  close(): void {
    acpSessionRegistry.remove(this.threadId);
  }
}
