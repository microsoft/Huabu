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

import { Agent, convertToLlm } from '@earendil-works/pi-agent-core';

import { renderEnvelopeMessages } from './conversation/prompt/build-prompt.js';
import { dumpAssembledPrompt } from './conversation/prompt/debug-prompt.js';
import { ensureApiKey, getLLMModel } from './llm.js';
import { buildToolsForScope, type ToolScope } from './tools/index.js';

import type { ChatEnvelope } from './conversation/envelope.js';
import type {
  AgentEvent,
  AgentToolResult,
} from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  Context,
  Message,
  TextContent,
} from '@earendil-works/pi-ai';
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

// ==================== Helpers ====================

/** Concatenate every TextContent block into a single string. */
function joinText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ==================== Agent Loop ====================

/**
 * Run the agent loop, streaming events as an async generator.
 *
 * Internally:
 * 1. Constructs a pi-agent-core `Agent` over `context.messages`
 * 2. Calls `agent.continue()` (the user message is already on context)
 * 3. Bridges agent events into our `AgentStreamEvent` discriminated union
 * 4. After `agent_end`, returns THIS run's output delta (the messages the
 *    agent appended) as the generator's return value. `context.messages`
 *    is treated as read-only input and never written back.
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
    maxIterations = 20,
    signal,
    logger,
    debugPrompt,
  } = options;

  const tools = buildToolsForScope(scope, {
    canvasId,
    origin,
    ...(threadId ? { threadId } : {}),
  });

  // Render THIS turn's envelope into its user message and run the agent
  // over [prior history + this turn] in a LOCAL array, leaving
  // `context.messages` untouched. Output leaves via this generator's
  // RETURN value; the rendered user message is excluded from that delta
  // (re-derived from the envelope on reload).
  //
  // Envelope-less callers (memory / sketch / reachback) build
  // `context.messages` themselves and read the event stream; for them
  // `turnMessages` is empty and the run proceeds over it directly.
  const turnMessages = envelope
    ? (await renderEnvelopeMessages(envelope, { canvasId: canvasId ?? null }))
        .messages
    : [];
  const priorLen = context.messages.length;
  const runMessages = envelope
    ? [...context.messages, ...turnMessages]
    : context.messages;
  // This run's output delta — the single value we return (see the tail).
  let outputDelta: Message[] = [];

  // Optional developer aid: dump the fully-assembled prompt (system +
  // prior history + this turn). No-op unless HUABU_DEBUG_PROMPT is set.
  if (debugPrompt) {
    dumpAssembledPrompt({
      systemPrompt: context.systemPrompt ?? '',
      messages: runMessages,
      newMessageCount: turnMessages.length,
      turnNumber: debugPrompt.turnNumber,
      threadId: debugPrompt.threadId,
      canvasId: canvasId ?? null,
      mode: debugPrompt.mode,
      logger: debugPrompt.logger,
    });
  }

  // Soft turn cap: replaces the old self-rolled `maxIterations` counter.
  // pi-agent-core 0.74's `Agent` class doesn't expose `shouldStopAfterTurn`
  // (only the lower-level `runAgentLoop` does), so we count `turn_end`
  // events and call `agent.abort()` after the cap. This calls the
  // *agent's* internal AbortController, not the route's — so the route's
  // `cleanUpAbortedMessages` does not fire, and we trim the trailing
  // aborted-empty assistant message that the loop appends as a side
  // effect (see the `agent_end` branch below).
  let turnCount = 0;
  let cappedOut = false;

  const agent = new Agent({
    initialState: {
      systemPrompt: context.systemPrompt,
      model: getLLMModel(),
      tools,
      // The Agent setter copies the top-level array, so it owns its own
      // transcript and `context.messages` is never written back to. We
      // pass the LOCAL `runMessages` (prior history + this turn) purely as
      // read-only input; the result travels out via the return value.
      messages: runMessages,
    },
    convertToLlm: (msgs) => msgs as Message[],
    // pi-agent-core invokes this before every LLM call, including across
    // long-running tool batches — that's exactly when OAuth tokens (e.g.
    // GitHub Copilot's short-lived bearer) may need refreshing. Reusing
    // our existing resolver keeps env / persisted-config / OAuth flows
    // working unchanged.
    getApiKey: () => ensureApiKey(),
    // Run independent tool calls in the same batch concurrently. The
    // common win is the LLM emitting N parallel `read` / `inspect_nodes`
    // / `web_search` calls — total latency drops from sum to max.
    //
    // Audit notes (see docs/architecture/agent-architecture.md"):
    //   - Read-only tools (`read`, `grep`, `find`, `ls`,
    //     `get_canvas_outline`, `inspect_nodes`, `inspect_edges`,
    //     `web_search`) are trivially safe.
    //   - `canvas_commands` is opted OUT of parallelism via
    //     `executionMode: 'sequential'` on its tool definition.
    //     Server-side, its handler reads canvas state once to build a
    //     nodeTypeMap; a parallel CREATE+MERGE pair on the same id
    //     would lose provenance injection on the merge. Client-side,
    //     SSE tool_result completion order ≠ declared order and
    //     `useAgentStream` applies each result the moment it lands,
    //     so a parallel MERGE could land before its CREATE. The
    //     per-tool override means any batch containing a
    //     `canvas_commands` call falls back to serial — acceptable
    //     because mixed read+write batches are rare in practice
    //     (the agent typically reads first, writes later).
    toolExecution: 'parallel',
  });

  // ------- Single subscribe: queue events, flag agent_end, count turns -------
  type Resolver = (value: AgentEvent | null) => void;
  const eventQueue: AgentEvent[] = [];
  const waiters: Resolver[] = [];
  let agentEnded = false;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'turn_end') {
      turnCount++;
      if (turnCount >= maxIterations && !cappedOut) {
        cappedOut = true;
        logger?.info(
          `[agent] Reached maxIterations (${maxIterations}), aborting after current turn`,
        );
        agent.abort();
      }
    }
    if (event.type === 'agent_end') agentEnded = true;
    const w = waiters.shift();
    if (w) w(event);
    else eventQueue.push(event);
  });

  function nextEvent(): Promise<AgentEvent | null> {
    const queued = eventQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (agentEnded) {
      return Promise.resolve(null);
    }
    return new Promise<AgentEvent | null>((resolve) => waiters.push(resolve));
  }

  // ------- Abort wiring -------
  const onAbort = () => {
    logger?.info('[agent] Signal aborted, propagating to pi-agent-core');
    agent.abort();
    // Wake any pending waiter so the generator can drain and exit.
    const w = waiters.shift();
    if (w) w(null);
  };
  if (signal?.aborted) {
    // Already aborted before we started.
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }

  // ------- Kick off the run -------
  // `continue()` resumes from existing context (last message must be user
  // or toolResult, which the route guarantees by pushing the user message
  // before calling runAgent).
  const runPromise = agent.continue().catch((err: unknown) => {
    // pi-agent-core's contract is that streamFn never throws and errors
    // are encoded into the stream. But just in case, surface the error
    // through the queue so the generator emits an `error` event.
    logger?.info(
      `[agent] continue() rejected: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    agentEnded = true;
    const w = waiters.shift();
    if (w) w(null);
  });

  try {
    while (true) {
      const event = await nextEvent();
      if (event === null) break;

      switch (event.type) {
        case 'message_update': {
          const inner = event.assistantMessageEvent;
          if (inner.type === 'text_delta') {
            yield { type: 'text_delta', data: { content: inner.delta } };
          } else if (inner.type === 'thinking_delta') {
            yield { type: 'thinking_delta', data: { content: inner.delta } };
          }
          break;
        }

        case 'tool_execution_start': {
          yield {
            type: 'tool_call',
            data: {
              toolCallId: event.toolCallId,
              // `title` is display-only; the machine tool name travels
              // on `internalToolName` so the web can resolve the render
              // variant + gate local side-effects (canvas_commands).
              title: event.toolName,
              internalToolName: event.toolName,
              status: 'pending',
              rawInput: (event.args ?? {}) as Record<string, unknown>,
            },
          };
          break;
        }

        case 'tool_execution_end': {
          const result = event.result as AgentToolResult<unknown> | undefined;
          const toolText = result?.content ? joinText(result.content) : '';
          // pi-agent-core wraps thrown handler errors as tool results
          // with `isError: true` and the `Error.message` as text content.
          // Lift that into the standard `ToolResponse<status: 'error'>`
          // envelope so the web client renders it as an error tool row
          // (see apps/web/src/components/Messages/ToolMessage.tsx).
          // Successful results stay verbatim — the web's
          // `parseToolResponse` either reads their existing envelope or
          // auto-wraps plain JSON as `{ status: 'success', data: ... }`.
          let payload = toolText;
          if (event.isError) {
            logger?.info(
              `[agent] Tool ${event.toolName} returned isError=true: ${toolText.slice(0, 200)}`,
            );
            payload = JSON.stringify({
              tool: event.toolName,
              status: 'error',
              error: toolText || 'Tool execution failed',
            });
          }
          yield {
            type: 'tool_call_update',
            data: {
              toolCallId: event.toolCallId,
              status: event.isError ? 'failed' : 'completed',
              // The web recovers the tool name from the part the
              // originating `tool_call` created; the result payload
              // (JSON-stringified `ToolResponse`) rides on `rawOutput`.
              rawOutput: payload,
            },
          };
          break;
        }

        case 'agent_end': {
          // Look at the final assistant message to decide done vs. error.
          const messages = agent.state.messages;

          // When `cappedOut` is true, `agent.abort()` was called from the
          // turn_end listener. If the just-finished turn had pending tool
          // calls, the loop entered one more iteration where the LLM
          // stream got cancelled — appending an empty assistant message
          // with `stopReason: 'aborted'`. Trim it so the user sees the
          // last *useful* assistant text on cap-out (and so we don't leak
          // an empty "AI response" row into history).
          if (cappedOut) {
            const tail = messages[messages.length - 1];
            if (
              tail?.role === 'assistant' &&
              tail.stopReason === 'aborted' &&
              joinText(tail.content).length === 0
            ) {
              messages.pop();
            }
          }

          const lastAssistant = [...messages]
            .reverse()
            .find((m): m is AssistantMessage => m.role === 'assistant');

          const stopReason = lastAssistant?.stopReason;
          const finalText = lastAssistant
            ? joinText(lastAssistant.content)
            : '';

          if (stopReason === 'error') {
            yield {
              type: 'error',
              data: {
                error: agent.state.errorMessage ?? 'LLM streaming error',
              },
            };
          } else if (cappedOut) {
            // Soft turn cap hit. Surface the last useful assistant text
            // (if any) followed by an error event explaining why we
            // stopped. The route's `cleanUpAbortedMessages` does NOT fire
            // here because the *route's* AbortController was never
            // tripped — only the agent's internal one was.
            if (finalText) {
              yield {
                type: 'done',
                data: {
                  message: finalText,
                  meta: {
                    stopReason,
                    usage: lastAssistant?.usage,
                    iterations: turnCount,
                  },
                },
              };
            }
            yield {
              type: 'error',
              data: {
                error: `Agent loop exceeded maximum iterations (${maxIterations})`,
              },
            };
          } else if (stopReason === 'aborted') {
            // Real user-initiated abort: route handles UX
            // (cleanUpAbortedMessages + status row). Nothing to emit.
          } else {
            yield {
              type: 'done',
              data: {
                message: finalText,
                meta: {
                  stopReason,
                  usage: lastAssistant?.usage,
                  iterations: turnCount,
                },
              },
            };
          }
          break;
        }

        // Other events (agent_start, turn_start/end, message_start/end,
        // tool_execution_update) are intentionally not surfaced — the
        // route + UI never relied on them.
        default:
          break;
      }
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);

    // Make sure the run has fully settled (and `agent_end` listeners
    // drained) before we sync state back. `runPromise` already resolves
    // at that point; `waitForIdle` is a belt-and-suspenders.
    await runPromise;
    await agent.waitForIdle();

    // This run's output delta = everything the agent appended after the
    // input prefix. RETURN it as the single output channel — we never
    // write back into `context.messages` (callers read this value or the
    // event stream, so mutating the input would be a redundant path).
    //
    // `convertToLlm` downcasts `agent.state.messages` (a superset with
    // harness-only roles like `custom` / `bashExecution` / `branchSummary`
    // / `compactionSummary`) into wire `Message`s. The input prefix
    // (`priorLen` history + `turnMessages.length` rendered rows) has no
    // harness roles, so it survives 1:1 and the slice index stays valid.
    const converted = convertToLlm(agent.state.messages);
    outputDelta = converted.slice(priorLen + turnMessages.length);
  }

  return outputDelta;
}
