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
 * closure, wraps the session entry in this handle, and drains `events()`.
 *
 * The ACP client/session is fully encapsulated behind the injected
 * {@link AcpSessionEntry}: the composition layer (which owns
 * `ensureAcpSession` + the preprocessor) constructs the entry and injects
 * the ready OBJECT, so this class needs no session-open imports. Two
 * session-lifecycle side effects that reach back into the composition
 * layer's registry/persistence — promoting the entry to a durable record
 * on first success — are injected as the {@link AcpAgentHandleOptions}
 * callbacks rather than imported (which would circularly depend on the
 * shell). Moving session construction behind a `create(spec)` factory is
 * deferred to M4/M5.
 *
 * See docs/proposals/layered-architecture.md §3.6 / §7 (M2).
 */

import { fauxAssistantMessage } from '@earendil-works/pi-ai';

import {
  acpUpdateToStreamEvent,
  mergeThinkingChunk,
} from '../acp/translator.js';
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
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { AcpPlanEntry, AgentStreamEvent } from '@sediment/shared';
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

/** Construction-time options for an {@link AcpAgentHandle}. */
export interface AcpAgentHandleOptions {
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
 * The ACP-backed {@link AgentHandle}. Wraps a route-supplied live
 * {@link AcpSessionEntry} (the client + open sessionId) and drives one
 * prompt turn against it.
 */
export class AcpAgentHandle implements AgentHandle<PreparedAcpPrompt> {
  /**
   * A Deployment advertises the full control set and can resume a prior
   * session (`session/load`). It accepts turn input blocking (the ACP
   * baseline: `session/prompt` always elicits a model turn).
   */
  readonly capabilities: AgentCapabilities = ACP_CAPABILITIES;

  private pending?: {
    request: AgentRequest | null;
    render: RenderFn<PreparedAcpPrompt>;
  };

  constructor(
    private readonly entry: AcpSessionEntry,
    private readonly options: AcpAgentHandleOptions,
  ) {}

  submit(
    request: AgentRequest | null,
    render: RenderFn<PreparedAcpPrompt>,
  ): void {
    this.pending = { request, render };
  }

  async *events(): AsyncGenerator<InStreamEvent, Message[]> {
    const pending = this.pending;
    if (!pending) {
      throw new Error('AcpAgentHandle.events() called before submit()');
    }
    const { entry, options } = this;
    const { overlay, signal, logger, onPromptSettled, onPrepared } = options;

    // ACP always needs fresh input — a `session/prompt` with nothing to
    // say is meaningless. A null request (no new input / resume-only) is
    // rejected by this driver (the interface allows null; its meaning is
    // driver-defined — see AgentHandle.submit).
    if (pending.request === null) {
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
    const prepared = await pending.render(pending.request);
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
    const { client, sessionId } = this.entry;
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
}
