/**
 * Unified Agent Service
 *
 * Core agent loop using pi-ai. Handles all modes (chat, research, agent)
 * with a shared tool-calling framework. The LLM streams tokens and can
 * invoke tools; the agent loop automatically executes tools and continues
 * until the LLM produces a final text response.
 *
 * Replaces LangGraph's StateGraph, checkpointer, and BaseAgent entirely.
 */

import { llmStream } from './llm.js';
import {
  chatTools,
  researchTools,
  operateTools,
  executeTool,
} from './tools/index.js';

import type { Context, Tool, AssistantMessage } from '@mariozechner/pi-ai';
import type { AgentMode } from '@sediment/shared';

/**
 * Unified streaming event emitted to the frontend via SSE.
 * Simplified from the old AgentEvent — the frontend just needs to know
 * what kind of data is arriving.
 */
export type StreamEventType =
  | 'text_delta'
  | 'tool_start'
  | 'tool_result'
  | 'thinking_delta'
  | 'done'
  | 'error';

export interface StreamEvent {
  type: StreamEventType;
  data: {
    /** Incremental text content (for text_delta / thinking_delta) */
    content?: string;
    /** Tool name (for tool_start / tool_result) */
    toolName?: string;
    /** Tool call arguments (for tool_start) */
    toolArgs?: Record<string, unknown>;
    /** Tool execution result (for tool_result) */
    toolResult?: string;
    /** Final complete message (for done) */
    message?: string;
    /** Error message (for error) */
    error?: string;
    /** Extra metadata */
    meta?: Record<string, unknown>;
  };
}

export interface AgentRunOptions {
  /** Agent mode determines available tools and system prompt */
  mode: AgentMode;
  /** pi-ai Context (systemPrompt + messages + tools). Will be mutated with responses. */
  context: Context;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Maximum number of tool-calling rounds (default: 20) */
  maxIterations?: number;
}

// ==================== Tool Sets ====================

function getToolsForMode(mode: AgentMode): Tool[] {
  switch (mode) {
    case 'ask':
      return chatTools;
    case 'research':
      return researchTools;
    case 'operate':
      return operateTools;
    default:
      return chatTools;
  }
}

// ==================== Agent Loop ====================

/**
 * Run the agent loop, streaming events as an async generator.
 *
 * The loop:
 * 1. Sends context to LLM via pi-ai stream()
 * 2. Streams text_delta events for token-level updates
 * 3. When LLM requests tool calls (stopReason === 'toolUse'):
 *    a. Emit tool_start events
 *    b. Execute each tool
 *    c. Emit tool_result events
 *    d. Add assistant message + tool results to context
 *    e. Call the LLM again (goto 1)
 * 4. When LLM finishes (stopReason === 'stop'):
 *    a. Emit done event with final message
 */
export async function* runAgent(
  options: AgentRunOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  const { mode, context, signal, maxIterations = 20 } = options;

  const tools = getToolsForMode(mode);

  // Ensure tools are set on the context
  context.tools = tools;

  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    if (signal?.aborted) {
      yield {
        type: 'error',
        data: { error: 'Request was aborted' },
      };
      return;
    }

    // Stream from the LLM
    const s = llmStream(context, {
      signal,
    });

    // Track whether we already yielded an error (to avoid calling s.result)
    let streamErrored = false;

    // Forward streaming events
    for await (const event of s) {
      switch (event.type) {
        case 'text_delta':
          yield {
            type: 'text_delta',
            data: { content: event.delta },
          };
          break;

        case 'thinking_delta':
          yield {
            type: 'thinking_delta',
            data: { content: event.delta },
          };
          break;

        case 'toolcall_start':
          break;

        case 'toolcall_end':
          yield {
            type: 'tool_start',
            data: {
              toolName: event.toolCall.name,
              toolArgs: event.toolCall.arguments as Record<string, unknown>,
            },
          };
          break;

        case 'error':
          streamErrored = true;
          yield {
            type: 'error',
            data: {
              error: event.error?.errorMessage ?? 'LLM streaming error',
            },
          };
          break;
      }
    }

    // If the stream errored, stop the loop
    if (streamErrored) {
      return;
    }

    // Get the final assistant message
    let result: AssistantMessage;
    try {
      result = await s.result();
    } catch (err) {
      yield {
        type: 'error',
        data: {
          error: err instanceof Error ? err.message : 'Failed to get result',
        },
      };
      return;
    }

    // Add assistant message to context
    context.messages.push(result);

    // Check if the LLM wants to call tools
    if (result.stopReason === 'toolUse') {
      const toolCalls = result.content.filter((b) => b.type === 'toolCall');

      for (const call of toolCalls) {
        // Execute the tool
        let toolResultText: string;
        try {
          toolResultText = await executeTool(
            call.name,
            (call.arguments ?? {}) as Record<string, unknown>,
          );
        } catch (err) {
          toolResultText = JSON.stringify({
            error: err instanceof Error ? err.message : 'Tool execution failed',
          });
        }

        // Emit tool result to frontend
        yield {
          type: 'tool_result',
          data: {
            toolName: call.name,
            toolResult: toolResultText,
          },
        };

        // Add tool result to context for next iteration
        context.messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: toolResultText }],
          isError: false,
          timestamp: Date.now(),
        });
      }

      // Continue the loop — LLM will be called again with tool results
      continue;
    }

    // LLM finished (stop, length, or error) — extract final text
    const finalText = result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    yield {
      type: 'done',
      data: {
        message: finalText,
        meta: {
          stopReason: result.stopReason,
          usage: result.usage,
          iterations: iteration,
        },
      },
    };
    return;
  }

  // Max iterations exceeded
  yield {
    type: 'error',
    data: {
      error: `Agent loop exceeded maximum iterations (${maxIterations})`,
    },
  };
}

/**
 * Create a fresh pi-ai Context for a given mode.
 */
export function createContext(mode: AgentMode, systemPrompt: string): Context {
  return {
    systemPrompt,
    messages: [],
    tools: getToolsForMode(mode),
  };
}
