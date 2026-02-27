/**
 * Chat Routes (Refactored)
 *
 * Uses ChatAgent internally but maintains existing API contract for backward compatibility.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createId } from '@sediment/shared';

import { ChatAgent } from './chat.agent.js';
import { SYSTEM_PROMPT } from '../../prompt/system.js';
import { buildContext } from '../knowledge/index.js';

import type {
  ChatHistoryItem,
  ChatHistoryResponse,
  ChatStreamUpdatePayload,
  SendMessageRequest,
  SendMessageResponse,
  ToolResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

function getOrCreateThreadId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return createId('thread');
}

function writeUpdate(
  raw: NodeJS.WritableStream,
  payload: ChatStreamUpdatePayload,
) {
  raw.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
}

const chatRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  // Create ChatAgent instance (lazy initialization)
  let agentPromise: Promise<ChatAgent> | null = null;
  const getAgent = () => {
    if (!agentPromise) {
      agentPromise = ChatAgent.create();
    }
    return agentPromise;
  };

  /**
   * GET /chat/history/:threadId
   * Return the persisted user/assistant message history for a thread.
   */
  fastify.get<{ Params: { threadId: string }; Reply: ChatHistoryResponse }>(
    '/history/:threadId',
    async function (request, reply) {
      const { threadId } = request.params;

      if (!threadId || threadId.trim().length === 0) {
        return reply.code(400).send({
          error: 'threadId is required',
        } as unknown as ChatHistoryResponse);
      }

      try {
        const agent = await getAgent();
        const state = await agent.getHistory(threadId);

        if (!state) {
          return reply.code(404).send({
            error: 'Thread not found',
          } as unknown as ChatHistoryResponse);
        }

        const rawMessages: unknown[] = Array.isArray(state.messages)
          ? state.messages
          : [];

        // Return user, assistant, and tool messages
        const messages: ChatHistoryItem[] = rawMessages
          .map((m) => {
            const role = getMessageRole(m);
            if (role === 'user' || role === 'assistant') {
              return {
                role,
                content: getMessageContent(m),
              };
            }
            if (role === 'tool') {
              const toolResponse = extractToolResponse(m);
              if (toolResponse) {
                return {
                  role: 'tool' as const,
                  toolResponse,
                };
              }
            }
            return null;
          })
          .filter((m): m is ChatHistoryItem => {
            if (m === null) return false;
            if (m.role === 'tool') return true;
            // User/assistant must have content
            return (
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              m.content.trim().length > 0
            );
          });

        return reply.send({ threadId, messages });
      } catch (error) {
        request.log.error(error, 'Failed to fetch history');
        return reply.code(500).send({
          error: 'Failed to fetch history',
        } as unknown as ChatHistoryResponse);
      }
    },
  );

  /**
   * POST /chat
   * Start a new chat message and stream results
   */
  fastify.post<{ Body: SendMessageRequest; Reply: SendMessageResponse }>(
    '/',
    async function (request, reply) {
      const { content, threadId, selectedSourceIds } = request.body;
      const resolvedThreadId = getOrCreateThreadId(threadId);

      // Build context from ingested sources
      let contextString = '';
      if (selectedSourceIds && selectedSourceIds.length > 0) {
        try {
          const { context, sources } = await buildContext(selectedSourceIds);
          contextString = context;

          request.log.info(
            {
              sourceCount: sources.length,
              contextLength: contextString.length,
            },
            'Built context from sources',
          );
        } catch (error) {
          request.log.error(error, 'Failed to build context');
          // Continue without context
        }
      }

      // Stream the response via SSE
      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');

      try {
        const agent = await getAgent();

        // Check if thread has existing history
        const state = await agent.getHistory(resolvedThreadId);
        const isExisting =
          state && Array.isArray(state.messages) && state.messages.length > 0;

        // Prepare inputs
        const inputs = {
          selectionContext: contextString.length > 0 ? contextString : null,
          messages: [
            ...(isExisting ? [] : [new SystemMessage(SYSTEM_PROMPT)]),
            new HumanMessage(content),
          ],
        };

        // Send thread ID metadata
        writeUpdate(reply.raw, {
          node: 'meta',
          metadata: { threadId: resolvedThreadId },
        });

        // Stream from ChatAgent
        const stream = agent.stream(inputs, resolvedThreadId);

        for await (const event of stream) {
          if (event.type === 'update' && event.data) {
            writeUpdate(reply.raw, event.data as ChatStreamUpdatePayload);
          }
        }

        reply.raw.write(`event: end\ndata: {}\n\n`);
      } catch (error) {
        request.log.error(error);
        const errorMsg =
          error instanceof Error ? error.message : 'Internal Error';
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ message: errorMsg })}\n\n`,
        );
      } finally {
        reply.raw.end();
      }
    },
  );

  // Helper functions
  function getMessageRole(message: unknown): string {
    if (typeof message !== 'object' || message === null) return 'assistant';

    const msg = message as {
      _getType?: () => string;
      constructor?: { name?: string };
    };
    const type = msg._getType?.();
    const ctorName = msg.constructor?.name;

    if (type === 'system' || ctorName === 'SystemMessage') return 'system';
    if (type === 'tool' || ctorName === 'ToolMessage') return 'tool';
    return type === 'human' || ctorName === 'HumanMessage'
      ? 'user'
      : 'assistant';
  }

  function getMessageContent(message: unknown): string {
    if (typeof message !== 'object' || message === null) {
      return typeof message === 'string'
        ? message
        : JSON.stringify(message ?? '');
    }

    const content = (message as { content?: unknown }).content;
    return typeof content === 'string'
      ? content
      : JSON.stringify(content ?? '');
  }

  /**
   * Extract tool response from a LangChain ToolMessage
   */
  function extractToolResponse(
    m: unknown,
  ): ToolResponse<string, unknown> | null {
    if (typeof m !== 'object' || m === null) return null;

    const msg = m as Record<string, unknown>;

    // Check for tool_call_id (LangChain ToolMessage)
    if (!msg.tool_call_id && !msg.name) return null;

    const toolName = (msg.name as string) ?? 'unknown';
    const content = (msg.content as string) ?? '';

    // Try to parse content as JSON for structured tool responses
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        // If it has status/tool fields, it's already a ToolResponse
        if ('status' in parsed && 'tool' in parsed) {
          return parsed as ToolResponse<string, unknown>;
        }
        // Otherwise, wrap it
        return {
          tool: toolName,
          status: 'success',
          data: parsed,
        };
      }
    } catch {
      // Not JSON, treat as plain text
    }

    // Fallback: wrap as generic tool response
    return {
      tool: toolName,
      status: 'success',
      data: { content },
    };
  }
};

export default chatRoutes;
