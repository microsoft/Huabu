/**
 * Unified Agent Service
 *
 * Drives the agent loop using `@earendil-works/pi-agent-core`'s `Agent`
 * class. The class owns the transcript, executes tools, and emits
 * lifecycle events; this module bridges those events into the
 * `AsyncGenerator<StreamEvent>` shape every consumer (chat / operate
 * SSE route, sketch pipeline) consumes.
 *
 * Public surface:
 *  - {@link runAgent} — yields SSE-shaped events. Callers that need
 *    structured output (e.g. sketch) drain the generator
 *    themselves and pull the relevant `tool_result` payload.
 */

import { type BuiltinRendered } from './agenetes/builtin-handle.js';
import {
  agenetes,
  INTERNAL_DRIVER_KIND,
  type BuiltinHandle,
  type BuiltinWorkloadSpec,
} from './agenetes/drivers.js';
import { type RenderFn, wrapChatRequest } from './agenetes/handle.js';
import { canvasAcpNamespace } from '../storage/paths.js';
import { renderEnvelopeMessages } from './conversation/prompt/build-prompt.js';
import { dumpAssembledPrompt } from './conversation/prompt/debug-prompt.js';
import { type ToolScope } from './tools/index.js';

import type { ChatEnvelope } from './conversation/envelope.js';
import type { Context, Message } from '@earendil-works/pi-ai';
import type { AgentStreamEvent, NodeOrigin } from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * SSE events yielded by `runAgent`.
 *
 * `runAgent` only emits the in-stream variants — `meta` and `end` are
 * synthesized by the route handler that owns the HTTP connection.
 */
export type StreamEvent = Exclude<AgentStreamEvent, { type: 'meta' | 'end' }>;

interface AgentLogger {
  info: (message: string) => void;
}

export interface AgentRunOptions {
  /**
   * Tool surface the agent runs against. Drives both the available
   * tool set and (via {@link buildToolsForScope}) any scope-specific
   * tool wiring.
   */
  scope: ToolScope;
  /**
   * Conversation thread id. System-wide this is the same concept as the
   * ACP path's `threadId` — the stable identity a conversation resumes
   * from — but the two backends resume through different media, so its
   * role *inside this function* differs:
   *
   *  - ACP: `threadId` keys a live session registry; resume means
   *    re-prompting the still-running external agent process, whose
   *    memory Sediment cannot otherwise reach. Stateful, in the dispatch
   *    layer.
   *  - Built-in: the conversation has no live process — its memory is
   *    externalized to the on-disk turn log. The route already resumed
   *    it (`loadTurns` + `rebuildContextMessages`) into {@link context}
   *    BEFORE calling `runAgent`. So by the time we get here `threadId`
   *    no longer drives resume; it is only a provenance tag for canvas
   *    writes (feeds the per-thread change card / revert). Omitting it
   *    leaves the dialogue intact — `context` already holds it — and
   *    only detaches canvas writes from their owning thread.
   */
  threadId?: string;
  /** Current canvas ID available as implicit context for canvas-aware tools. */
  canvasId?: string;
  /**
   * This turn's structured input. When provided (the chat route), it is
   * rendered into the per-turn user message internally — symmetric with
   * the external/ACP path, which takes the same envelope — and the
   * rendered message is kept OUT of `context.messages` so the envelope
   * stays the single source of truth on reload.
   *
   * Optional for the internal, envelope-less callers (memory analyzer,
   * sketch recognition, reachback operate) that assemble
   * `context.messages` directly: with no envelope, `runAgent` runs over
   * `context.messages` as-is and syncs the full final transcript back
   * (the legacy behaviour).
   */
  envelope?: ChatEnvelope;
  /**
   * pi-ai Context for this run: `systemPrompt` + the prior messages the
   * agent runs over (rebuilt history for the chat route; a caller-built
   * message list for envelope-less callers). Treated as read-only INPUT —
   * the run's output is delivered ONLY via the generator's return value,
   * never by mutating `messages`.
   */
  context: Context;
  /**
   * `NodeOrigin` stamp forwarded to `canvas_commands` (and ignored by
   * other tools). Defaults inside the handler to `{ type: 'ai-operate' }`;
   * the sketch pipeline overrides to
   * `{ type: 'sketch-recognized' }` so user-authored gestures are
   * not mis-tagged as AI-initiated.
   */
  origin?: NodeOrigin;
  /**
   * Soft cap on agent turns (LLM call + tool batch). When reached, the
   * agent loop is aborted internally and a cap-out error is emitted.
   * Mirrors the previous self-rolled `maxIterations`.
   */
  maxIterations?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Structured logger for request-scoped diagnostics */
  logger?: AgentLogger;
  /**
   * Optional developer aid: when present (and `HUABU_DEBUG_PROMPT` is
   * set), dump the fully-assembled prompt for this turn. Lives here
   * rather than in the route because the route no longer holds the
   * rendered messages — they are built inside {@link runAgent}.
   */
  debugPrompt?: {
    turnNumber: number;
    threadId: string;
    mode: string;
    logger: FastifyBaseLogger;
  };
}

// ==================== Agent Loop ====================

/**
 * Run the built-in agent for one turn, streaming events as an async
 * generator.
 *
 * This is now a thin COMPOSITION shell over the mounted Agenetes instance:
 * it owns the multi-turn assembly (baking the prior transcript into the
 * Job spec's `messages`) and the per-turn render / prompt-debug closures,
 * then hands a serializable {@link BuiltinWorkloadSpec} to
 * `agenetes.create(spec)` and drives one `run(...)`. The pi-SDK
 * construction + host singletons (`getLLMModel` / `ensureApiKey` /
 * `buildToolsForScope` / `getSessionReadSet`) live inside the built-in
 * driver factory (`agenetes/drivers.ts`), reached through the instance —
 * L1 no longer holds a driver handle of its own. Behaviour is identical to
 * the pre-instance path; only the dispatch seam moved.
 *
 * `context.messages` is treated as read-only input; this run's output
 * delta leaves solely via the generator's return value.
 */
export async function* runAgent(
  options: AgentRunOptions,
): AsyncGenerator<StreamEvent, Message[], unknown> {
  const {
    scope,
    threadId,
    canvasId,
    envelope,
    context,
    origin,
    maxIterations,
    signal,
    logger,
    debugPrompt,
  } = options;

  // This turn's render. An envelope renders to this turn's user message(s)
  // (the handle calls `agent.prompt`); an envelope-less caller (memory /
  // sketch / reachback) has already assembled `context.messages`, so it
  // submits a NULL request and the handle resumes via `agent.continue()` —
  // `render` is never invoked in that case.
  const render: RenderFn<BuiltinRendered> = async (request) =>
    (
      await renderEnvelopeMessages(request.content, {
        canvasId: canvasId ?? null,
      })
    ).messages;

  // Optional developer aid: dump the fully-assembled prompt (system +
  // prior history + this turn). No-op unless HUABU_DEBUG_PROMPT is set.
  // Lives in the composition layer so the built-in driver need not import
  // the host's prompt-debug util; the handle calls it back post-render.
  const onRendered = debugPrompt
    ? (renderedMessages: Message[]) => {
        dumpAssembledPrompt({
          systemPrompt: context.systemPrompt ?? '',
          messages: [...context.messages, ...renderedMessages],
          newMessageCount: renderedMessages.length,
          turnNumber: debugPrompt.turnNumber,
          threadId: debugPrompt.threadId,
          canvasId: canvasId ?? null,
          mode: debugPrompt.mode,
          logger: debugPrompt.logger,
        });
      }
    : undefined;

  // Bake this turn's built-in WorkloadSpec (I9.6) — a serializable Job. L1
  // owns the multi-turn assembly: the prior transcript rides `messages`,
  // and the driver factory builds a fresh backing `Agent` from the spec.
  //
  // Envelope-less / stateless callers (memory / sketch / reachback) have no
  // conversation thread. `threadId: ''` keeps the instance record key inert
  // and makes the factory resolve an ephemeral read-set + leave canvas
  // writes unattributed (every downstream consumer truthy-guards the thread
  // id), reproducing the pre-instance behaviour where these callers omitted
  // `threadId` entirely.
  const spec: BuiltinWorkloadSpec = {
    kind: INTERNAL_DRIVER_KIND,
    workloadType: 'Job',
    threadId: threadId ?? '',
    namespace: canvasAcpNamespace(canvasId ?? ''),
    systemPrompt: context.systemPrompt,
    scope,
    canvasId,
    origin,
    messages: context.messages,
    maxIterations,
  };

  // `spec.kind` is `internal`, so the instance's union handle narrows to a
  // `BuiltinHandle`. A Job is minted fresh each turn (never cached), so
  // this always yields a new handle. `null` request when there is no
  // envelope → the handle resumes the pre-loaded transcript
  // (`agent.continue()`).
  const handle = agenetes.create(spec) as BuiltinHandle;
  return yield* handle.run(
    envelope ? wrapChatRequest(envelope) : null,
    render,
    {
      maxIterations,
      signal,
      logger,
      onRendered,
    },
  );
}
