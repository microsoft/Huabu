/**
 * `AcpAgentHandle` — the {@link AgentHandle} implementation for the
 * external, ACP-connected backend (the "Deployment" driver).
 *
 * This is the canonical home for the external agent's *execution* logic:
 * the per-update callback → queue bridge, the `session/update` →
 * `AgentStreamEvent` translation, the wire-ordered content-block assembly
 * that becomes the persisted assistant message, and the terminal
 * done/error frame. The composition shell (host `acp/service.ts`) opens /
 * reuses the session, builds the render closure, and drives one
 * `run(...)` against the long-lived handle.
 *
 * Lifecycle (§3.2 / M2.6): the ACP path is a **Deployment** — a
 * long-lived, stateful session that hosts *many* turns, carries
 * cross-turn `control`, and has a liveness dimension a Job never has. So
 * the handle itself is long-lived: `AgentRuntime` holds it across turns
 * keyed by `threadId`, and it is addressable out-of-turn for `control()`
 * / `close()`. It bakes its {@link AcpCreateSpec} at construction and
 * self-resolves its backing {@link AcpSessionEntry} *per turn* (via
 * `ensureAcpSession`, get-or-create) inside {@link run} — so the handle
 * owns its whole session lifecycle and the composition shell no longer
 * opens the session out-of-band and hands the entry in. Out-of-turn
 * (`control` / `close`) it resolves the live entry from
 * `acpSessionRegistry` by `threadId` (a precondition failure when no
 * session is live — we do not lazily spawn one just to, e.g., set a mode).
 *
 * The heavy session-open logic lives in `ensureAcpSession` (this same
 * package); the handle drives it from its baked spec, installs the entry's
 * up-report hook (`reportState`), and internalizes the first-success
 * promotion of the session's `sessionId` into the durable snapshot.
 *
 * The handle is generic over the host request shape (`TRequest`): it never
 * inspects the request, only forwards it to the injected `render` closure,
 * so it stays host-agnostic. The host binds `TRequest` to its concrete
 * request (the canvas `ChatEnvelope`) at construction.
 *
 * See docs/proposals/layered-architecture.md §3.6 / §7 (M2 / M2.6 / M5).
 */

import { fauxAssistantMessage } from '@earendil-works/pi-ai';

import { applyToolExt } from './overlay.js';
import { acpSessionRegistry } from './session-registry.js';
import { ensureAcpSession, registerAcpStateListener, reportEntryState } from './session.js';
import { acpUpdateToStreamEvent, mergeThinkingChunk } from './translator.js';

import type { AcpTurnOverlay } from './overlay.js';
import type { AcpBindingRecipe } from './binding-recipe.js';
import type { AcpSessionLogger } from './session.js';
import type { AgentStateSnapshot, Namespace } from '@agenetes/protocol';
import type {
  AgentCapabilities,
  AgentStreamEvent,
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';
import type {
  AgentHandle as RuntimeAgentHandle,
  AgentTurnState,
  RenderFn as RuntimeRenderFn,
} from '@agenetes/runtime';
import type {
  ContentBlock as AcpContentBlock,
  PlanEntry as AcpPlanEntry,
} from '@agentclientprotocol/sdk';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';

/**
 * The events a handle actually emits: every `AgentStreamEvent` frame
 * except the transport-synthesized `meta` / `end` (those are added by the
 * route around a turn, not by a handle).
 */
export type InStreamEvent = Exclude<
  AgentStreamEvent,
  { type: 'meta' | 'end' }
>;

/**
 * The external path's render output: the deterministic ACP prompt payload
 * derived from this turn's envelope. `blocks` is what goes on the wire
 * (already ACP content blocks — the render closure maps host content
 * parts onto them); `serialized` is the text form (debug logs);
 * `includedSystem` drives the one-shot system-preamble flip on success;
 * `preparedError` records a preprocessor fall-back for the dispatch log.
 */
export interface PreparedAcpPrompt {
  serialized: string;
  includedSystem: boolean;
  blocks: AcpContentBlock[];
  preparedError?: string;
}

/**
 * The minimal `WorkloadSpec` projection the ACP handle bakes at
 * construction (I9.3 `resolve(spec.kind).create(spec)`). It carries
 * everything the handle needs to self-resolve its live session per turn —
 * so the composition shell no longer opens the session out-of-band and
 * hands the entry in. A full host `WorkloadSpec` satisfies this
 * structurally, so the mounted instance passes its spec straight through.
 */
export interface AcpCreateSpec {
  /** The L1-minted addressable id this Deployment is keyed by (I4.2). */
  readonly threadId: string;
  /**
   * The dispatch `kind` (I5). Optional here — the handle never reads it
   * (the instance dispatches on it before `create`) — but present on the
   * full host spec, which is why it is accepted.
   */
  readonly kind?: string;
  /** Storage / metadata scope for this session (I4.1 / §7 M5.0). */
  readonly namespace: Namespace;
  /** External binding (alias + profileId) for the thread. */
  readonly binding: { readonly alias: string; readonly profileId: string };
  /** `cwd` for `session/new`; when omitted, derived from the bound recipe. */
  readonly cwd?: string;
  /** Pre-resolved spawn recipe for a first-time thread (host-resolved). */
  readonly recipe?: AcpBindingRecipe | null;
  /** L1-assembled agent reachback env, passed through to the spawn call. */
  readonly env?: Record<string, string>;
}

/** The per-turn context an {@link AcpAgentHandle.run} accepts. */
export interface AcpTurnCtx {
  /**
   * Mutable per-turn ACP overlay (tool extensions keyed by `toolCallId`
   * + the turn's plan). Route-owned; mutated in place as events arrive
   * and folded into the persisted turn record by the route.
   */
  overlay: AcpTurnOverlay;
  /** Cancellation signal — wired through to `session/cancel`. */
  signal?: AbortSignal;
  /**
   * The request-scoped logger for THIS turn. Per-turn (not baked at
   * construction) so log lines stay correlated to the driving request.
   * Typed as the wider {@link AcpSessionLogger} because the handle now
   * drives `ensureAcpSession` with it (which needs `debug` / `error`), as
   * well as the per-update translation.
   */
  logger: AcpSessionLogger;
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
 * ACP driver can advertise it before a handle instance exists.
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
 * The ACP-backed {@link AgentHandle} — a long-lived Deployment. Bakes its
 * {@link AcpCreateSpec} at construction and self-resolves the live
 * {@link AcpSessionEntry} for a turn inside {@link run} (get-or-create);
 * out-of-turn ops resolve the
 * live session from `acpSessionRegistry` by `threadId`.
 *
 * `TRequest` is the host request shape — never inspected here, only
 * forwarded to `render` — so the driver stays host-agnostic.
 */
export class AcpAgentHandle<TRequest = unknown>
  implements
    RuntimeAgentHandle<
      TRequest,
      PreparedAcpPrompt,
      Message[],
      InStreamEvent,
      AcpTurnCtx
    >
{
  /**
   * A Deployment advertises the full control set and can resume a prior
   * session (`session/load`). It accepts turn input blocking (the ACP
   * baseline: `session/prompt` always elicits a model turn).
   */
  readonly capabilities: AgentCapabilities = ACP_CAPABILITIES;

  /**
   * @param spec       The baked create-time WorkloadSpec projection.
   * @param priorState The instance's down-feed (I9.7): the durable
   *   `AgentStateSnapshot` last persisted for this thread, forwarded into
   *   `ensureAcpSession` so the session resumes / rehydrates from it. A
   *   fresh thread receives `undefined`.
   */
  constructor(
    private readonly spec: AcpCreateSpec,
    private readonly priorState?: AgentStateSnapshot,
  ) {}

  /**
   * Register the instance's up-report listener (I9.7). The listener is
   * keyed by `threadId` in the driver's module-level registry, so it fires
   * for every meta change on this thread — including out-of-turn set-RPCs
   * that resolve an entry without going through `run`. Returns an
   * unsubscribe that clears it. The instance wires this once per live
   * Deployment handle.
   */
  onState(listener: (snapshot: AgentStateSnapshot) => void): () => void {
    return registerAcpStateListener(this.spec.threadId, listener);
  }

  async *run(
    request: TRequest | null,
    render: RuntimeRenderFn<TRequest, PreparedAcpPrompt>,
    ctx: AcpTurnCtx,
  ): AsyncGenerator<InStreamEvent, Message[]> {
    const { overlay, signal, logger, onPrepared } = ctx;

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

    // Self-resolve (open or reuse) THIS turn's live ACP session from the
    // baked spec — the handle owns its session lifecycle now, so the
    // composition shell no longer opens it out-of-band and hands the entry
    // in. `ensureAcpSession` handles connection lookup, stale-entry
    // eviction, initialize + session/new, and listener registration; a
    // hard failure (unbound profile / bridge down) throws here, surfacing
    // on the generator's first `next()` exactly as before.
    const entry = await ensureAcpSession({
      threadId: this.spec.threadId,
      binding: this.spec.binding,
      namespace: this.spec.namespace,
      ...(this.spec.cwd !== undefined && { cwd: this.spec.cwd }),
      ...(this.spec.recipe !== undefined && { recipe: this.spec.recipe }),
      ...(this.spec.env !== undefined && { env: this.spec.env }),
      ...(this.priorState !== undefined && { priorState: this.priorState }),
      logger,
    });

    // Fire an initial up-report (I9.7) now that the entry is resolved and
    // in the live registry: this persists the resumed session's sessionId
    // (when already recoverable) + seeded metadata through the instance,
    // folding in any replay touches that landed before the listener wired.
    reportEntryState(entry);

    // Render THIS turn's envelope into ACP wire blocks (the composition
    // layer's render closure owns the preprocessor + raw-text fallback, so
    // `blocks` is always valid here). The driver OWNS the per-turn session
    // state and supplies it to render as the second argument: `render`
    // interprets `isFirstMessage` (→ whether to prepend the one-shot system
    // preamble) — the "has the preamble been sent" bookkeeping stays L2.
    const turnState: AgentTurnState = {
      isFirstMessage: !entry.systemPreambleSent,
    };
    const prepared = await render(request, turnState);
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
        // turn its session is genuinely recoverable. Flip the flag and
        // up-report so the durable snapshot now carries the sessionId
        // (withheld until now — see `snapshotEntryState`). Internalized
        // here (the handle owns its session lifecycle).
        if (!entry.persistedToDisk) {
          entry.persistedToDisk = true;
          reportEntryState(entry);
        }
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
    const entry = acpSessionRegistry.get(this.spec.threadId);
    if (!entry) {
      return {
        ok: false,
        error: `no active ACP session for thread ${this.spec.threadId}`,
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
    acpSessionRegistry.remove(this.spec.threadId);
  }
}
