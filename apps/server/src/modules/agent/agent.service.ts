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

import { Agent } from '@earendil-works/pi-agent-core';

import { type BuiltinRendered } from './agenetes/builtin-handle.js';
import { getBuiltinDriver } from './agenetes/drivers.js';
import { type RenderFn } from './agenetes/handle.js';
import { renderEnvelopeMessages } from './conversation/prompt/build-prompt.js';
import { dumpAssembledPrompt } from './conversation/prompt/debug-prompt.js';
import { ensureApiKey, getLLMModel } from './llm.js';
import { getSessionReadSet } from './session-read-set.js';
import { buildToolsForScope, type ToolScope } from './tools/index.js';

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
 * This is now a thin COMPOSITION shell over {@link BuiltinAgentHandle}: it
 * owns the pi-SDK construction + host singletons (`buildToolsForScope` /
 * `getLLMModel` / `ensureApiKey`), builds the backing `Agent` over the
 * prior transcript, then delegates the execution seam to the handle —
 * `submit` (render + `prompt`/`continue`) and `events()` (the bridge loop).
 * Behaviour is identical to the pre-M2 inline loop; only the seam moved.
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

  const tools = buildToolsForScope(scope, {
    canvasId,
    origin,
    ...(threadId ? { threadId } : {}),
    // Session-scoped read-set (per conversation thread): the revs of nodes
    // the agent has actually READ this session. Populated only by `read`
    // (full body), never from context previews. `canvas_commands` injects
    // `expectRev` from it so the executor's CAS can reject a stale write.
    readSet: getSessionReadSet(threadId),
  });

  // The composition layer owns the pi-SDK construction + host singletons
  // (`getLLMModel` / `ensureApiKey`); the built-in driver receives a ready
  // `Agent` OBJECT (not the impl), so it stays free of those imports. The
  // agent is built over the PRIOR transcript (`context.messages`) only —
  // this turn's rendered rows are appended by the handle's `submit`
  // (`agent.prompt`), leaving `context.messages` read-only input whose
  // output travels out solely via the generator's return value.
  const agent = new Agent({
    initialState: {
      systemPrompt: context.systemPrompt,
      model: getLLMModel(),
      tools,
      messages: context.messages,
    },
    convertToLlm: (msgs) => msgs as Message[],
    // pi-agent-core invokes this before every LLM call, including across
    // long-running tool batches — that's exactly when OAuth tokens (e.g.
    // GitHub Copilot's short-lived bearer) may need refreshing. Reusing
    // our existing resolver keeps env / persisted-config / OAuth flows
    // working unchanged.
    getApiKey: () => ensureApiKey(),
    // Run independent tool calls in the same batch concurrently.
    // `canvas_commands` opts OUT via `executionMode: 'sequential'` on its
    // tool definition, so any batch containing a write falls back to serial
    // (see docs/architecture/agent-architecture.md).
    toolExecution: 'parallel',
  });

  // This turn's render. An envelope renders to this turn's user message(s)
  // (the handle calls `agent.prompt`); an envelope-less caller (memory /
  // sketch / reachback) has already assembled `context.messages`, so it
  // submits a NULL request and the handle resumes via `agent.continue()` —
  // `render` is never invoked in that case.
  const render: RenderFn<BuiltinRendered> = async (request) =>
    (await renderEnvelopeMessages(request, { canvasId: canvasId ?? null }))
      .messages;

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

  const handle = getBuiltinDriver().create({ agent });
  // `null` request when there is no envelope → the built-in driver resumes
  // the pre-loaded transcript (`agent.continue()`).
  return yield* handle.run(envelope ?? null, render, {
    maxIterations,
    signal,
    logger,
    onRendered,
  });
}
