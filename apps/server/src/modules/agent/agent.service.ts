/**
 * Unified Agent Service
 *
 * Drives the agent loop using `@earendil-works/pi-agent-core`'s `Agent`
 * class. The class owns the transcript, executes tools, and emits
 * lifecycle events; this module bridges those events into the
 * `AsyncGenerator<StreamEvent>` shape the route layer already consumes.
 *
 * Public surface (signature-compatible with the previous self-rolled loop):
 *  - {@link runAgent} — yields SSE-shaped events, mutates `context.messages`
 */

import { Agent } from '@earendil-works/pi-agent-core';

import { ensureApiKey, getLLMModel } from './llm.js';
import { buildToolsForMode } from './tools/index.js';

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
import type { AgentMode, AgentStreamEvent } from '@sediment/shared';

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
  /** Agent mode determines available tools and system prompt */
  mode: AgentMode;
  /** Current canvas ID available as implicit context for canvas-aware tools. */
  canvasId?: string;
  /** pi-ai Context (systemPrompt + messages). Will be mutated with responses. */
  context: Context;
  /** Structured logger for request-scoped diagnostics */
  logger?: AgentLogger;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /**
   * Soft cap on agent turns (LLM call + tool batch). When reached, the
   * agent loop is aborted internally and a cap-out error is emitted.
   * Mirrors the previous self-rolled `maxIterations`.
   */
  maxIterations?: number;
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
 * 4. After `agent_end`, syncs `agent.state.messages` back into
 *    `context.messages` so the route's existing `saveContext` /
 *    `cleanUpAbortedContext` keep working.
 */
export async function* runAgent(
  options: AgentRunOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  const {
    mode,
    canvasId,
    context,
    logger,
    signal,
    maxIterations = 20,
  } = options;

  const tools = buildToolsForMode(mode, { canvasId });

  // Soft turn cap: replaces the old self-rolled `maxIterations` counter.
  // pi-agent-core 0.74's `Agent` class doesn't expose `shouldStopAfterTurn`
  // (only the lower-level `runAgentLoop` does), so we count `turn_end`
  // events and call `agent.abort()` after the cap. This calls the
  // *agent's* internal AbortController, not the route's — so the route's
  // `cleanUpAbortedContext` does not fire, and we trim the trailing
  // aborted-empty assistant message that the loop appends as a side
  // effect (see the `agent_end` branch below).
  let turnCount = 0;
  let cappedOut = false;

  const agent = new Agent({
    initialState: {
      systemPrompt: context.systemPrompt,
      model: getLLMModel(),
      tools,
      // The Agent setter copies the top-level array; element references
      // stay identical, so route-side mutations on individual messages
      // continue to work — but the array identity differs after
      // construction, which is why we re-sync below in the `finally`.
      messages: context.messages,
    },
    convertToLlm: (msgs) => msgs as Message[],
    // pi-agent-core invokes this before every LLM call, including across
    // long-running tool batches — that's exactly when OAuth tokens (e.g.
    // GitHub Copilot's short-lived bearer) may need refreshing. Reusing
    // our existing resolver keeps env / persisted-config / OAuth flows
    // working unchanged.
    getApiKey: () => ensureApiKey(),
    // Match the previous self-rolled loop, which executed tool batches one
    // call at a time. Step 4 of the migration plan will flip this to
    // 'parallel' once we audit canvas_commands for race-free batching.
    toolExecution: 'sequential',
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
            type: 'tool_start',
            data: {
              toolName: event.toolName,
              toolArgs: (event.args ?? {}) as Record<string, unknown>,
            },
          };
          break;
        }

        case 'tool_execution_end': {
          const result = event.result as AgentToolResult<unknown> | undefined;
          const toolText = result?.content ? joinText(result.content) : '';
          // pi-agent-core wraps thrown executor errors as `isError: true`.
          // Today's tools encode failures inside the JSON payload instead
          // of throwing, so this only surfaces in logs — but Step 2's file
          // tools (which throw) will benefit from the breadcrumb without
          // any further wiring.
          if (event.isError) {
            logger?.info(
              `[agent] Tool ${event.toolName} returned isError=true: ${toolText.slice(0, 200)}`,
            );
          }
          yield {
            type: 'tool_result',
            data: { toolName: event.toolName, toolResult: toolText },
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
            // stopped. The route's `cleanUpAbortedContext` does NOT fire
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
            // (cleanUpAbortedContext + status row). Nothing to emit.
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

    // Sync the agent's final transcript back into `context.messages`. The
    // route layer (saveContext / cleanUpAbortedContext) reads `context`
    // directly, so we mutate the array in place to preserve identity.
    context.messages.length = 0;
    context.messages.push(...agent.state.messages);
  }
}
