/**
 * Unified Agent Service
 *
 * Drives the agent loop using `@earendil-works/pi-agent-core`'s `Agent`
 * class. The class owns the transcript, executes tools, and emits
 * lifecycle events; this module bridges those events into the
 * `AsyncGenerator<StreamEvent>` shape the route layer already consumes.
 *
 * Public surface (signature-compatible with the previous self-rolled loop):
 *  - {@link runAgent}     — yields SSE-shaped events, mutates `context.messages`
 *  - {@link createContext} — fresh empty Context for a given mode
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
   * Soft cap on agent turns (LLM call + tool batch) before we forcibly
   * abort the run. Mirrors the previous self-rolled `maxIterations`.
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

  // ------- Event queue bridging subscribe() → AsyncGenerator -------
  type Resolver = (value: AgentEvent | null) => void;
  const eventQueue: AgentEvent[] = [];
  const waiters: Resolver[] = [];
  let agentEnded = false;

  const unsubscribe = agent.subscribe((event) => {
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

  // ------- Soft turn cap (replaces the old maxIterations counter) -------
  let turnCount = 0;
  let cappedOut = false;
  const unsubscribeTurnCap = agent.subscribe((event) => {
    if (event.type === 'turn_end') {
      turnCount++;
      if (turnCount >= maxIterations && !cappedOut) {
        cappedOut = true;
        logger?.info(
          `[agent] Reached maxIterations (${maxIterations}), aborting`,
        );
        agent.abort();
      }
    }
  });

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
          yield {
            type: 'tool_result',
            data: { toolName: event.toolName, toolResult: toolText },
          };
          break;
        }

        case 'agent_end': {
          // Look at the final assistant message to decide done vs. error.
          const messages = agent.state.messages;
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
          } else if (stopReason === 'aborted') {
            // Route handles abort UX (cleanUpAbortedContext + status row).
            // Surface a soft notice when the abort came from our turn cap
            // so the user sees why the agent stopped.
            if (cappedOut) {
              yield {
                type: 'error',
                data: {
                  error: `Agent loop exceeded maximum iterations (${maxIterations})`,
                },
              };
            }
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
    unsubscribeTurnCap();
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

/**
 * Create a fresh pi-ai Context for a given mode.
 *
 * `tools` are intentionally omitted here: the runtime tool list is rebuilt
 * by `runAgent` per-request via `buildToolsForMode`, since each tool needs
 * a fresh `canvasId`-bound `execute` closure.
 */
export function createContext(_mode: AgentMode, systemPrompt: string): Context {
  return {
    systemPrompt,
    messages: [],
  };
}
