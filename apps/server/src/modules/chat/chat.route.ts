/**
 * Chat Routes (Refactored)
 *
 * Uses ChatAgent internally but maintains existing API contract for backward compatibility.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createId } from '@sediment/shared';

import { ChatAgent } from './chat.agent.js';
import { SYSTEM_PROMPT } from '../../prompt/system.js';
import { getArtifactsDir } from '../artifact/utils.js';
import { buildContext } from '../knowledge/index.js';

import type {
  ChatAttachment,
  ChatHistoryItem,
  ChatHistoryResponse,
  ChatStreamUpdatePayload,
  SelectedNodeDetail,
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

/**
 * Recursively extract knowledge-base source IDs from a selected node.
 * Frame nodes carry their direct children in `children`, so a single
 * selected frame yields source IDs for all of its child nodes too.
 */
function collectSourceIds(node: SelectedNodeDetail): string[] {
  const ids: string[] = [];
  if (node.sourceId) ids.push(node.sourceId);
  for (const child of node.children ?? []) {
    ids.push(...collectSourceIds(child));
  }
  return ids;
}

/**
 * Resolve an attachment image URL to a base64 data URL.
 * Local artifact URLs (e.g. http://localhost:3000/api/artifact/xxx.png) are
 * read from disk and converted to inline data URLs so the LLM API can see them.
 * Already-valid data URLs or remote URLs are returned as-is.
 */
async function resolveImageUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;

  // Match local artifact path: .../api/artifact/<filename>
  const artifactMatch = /\/api\/artifact\/([^/?#]+)/.exec(url);
  if (artifactMatch) {
    const filename = path.basename(artifactMatch[1]);
    const filePath = path.resolve(getArtifactsDir(), filename);

    // Guard against path traversal
    if (!filePath.startsWith(path.resolve(getArtifactsDir()))) {
      console.warn(`Blocked path traversal attempt: ${artifactMatch[1]}`);
      return url;
    }

    try {
      const buffer = await readFile(filePath);
      const ext = path.extname(filename).toLowerCase();
      const MIME_MAP: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
      };
      const mime = MIME_MAP[ext] ?? 'image/png';
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (err) {
      console.warn(`Failed to read artifact: ${filePath}`, err);
      return url;
    }
  }

  // External URL — return as-is (may fail if not reachable by the LLM API)
  return url;
}

/**
 * Build the HumanMessage for the agent.
 * When attachments are present the message uses a multimodal content array
 * so the LLM can see both images and text in a single turn.
 * Image URLs pointing to local artifacts are converted to base64 data URLs.
 */
async function buildHumanMessage(
  text: string,
  attachments: ChatAttachment[] | undefined,
): Promise<HumanMessage> {
  if (!attachments || attachments.length === 0) {
    return new HumanMessage(text);
  }

  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: string } }
  > = [{ type: 'text', text }];

  for (const att of attachments) {
    const dataUrl = await resolveImageUrl(att.url);
    parts.push({
      type: 'image_url',
      image_url: { url: dataUrl, detail: 'high' },
    });

    // Append extracted text if available
    if (att.extractedText && att.extractedText.trim().length > 0) {
      const label = att.label ?? 'attachment';
      parts.push({
        type: 'text',
        text: `[Extracted text from ${label}]:\n${att.extractedText}`,
      });
    }
  }

  return new HumanMessage({ content: parts });
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
              const attachments = extractAttachments(m);
              return {
                role,
                content: getMessageContent(m),
                ...(attachments.length > 0 && { attachments }),
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
      const { content, threadId, canvasContext, attachments } = request.body;
      const resolvedThreadId = getOrCreateThreadId(threadId);

      // Collect knowledge-base source IDs from selected nodes (including
      // frame children) so the agent receives ingested content as context.
      const selectedSourceIds = [
        ...new Set(
          (canvasContext?.selectedNodes ?? []).flatMap(collectSourceIds),
        ),
      ];

      // Build context from ingested sources
      let contextString = '';
      if (selectedSourceIds.length > 0) {
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

        // Prepare inputs — build a multimodal HumanMessage when attachments are present
        const userMessage = await buildHumanMessage(content, attachments);
        const inputs = {
          selectionContext: contextString.length > 0 ? contextString : null,
          messages: [
            ...(isExisting ? [] : [new SystemMessage(SYSTEM_PROMPT)]),
            userMessage,
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
    if (typeof content === 'string') return content;

    // Multimodal content: extract only the user's own text, skipping
    // "[Extracted text from ...]" annotations injected by buildHumanMessage.
    if (Array.isArray(content)) {
      return content
        .filter(
          (part): part is { type: 'text'; text: string } =>
            typeof part === 'object' &&
            part !== null &&
            part.type === 'text' &&
            typeof part.text === 'string' &&
            !part.text.startsWith('[Extracted text from '),
        )
        .map((part) => part.text)
        .join('\n');
    }

    return JSON.stringify(content ?? '');
  }

  /**
   * Extract ChatAttachment[] from a multimodal HumanMessage.
   * Recovers image_url parts so the frontend can render thumbnails after refresh.
   */
  function extractAttachments(message: unknown): ChatAttachment[] {
    if (typeof message !== 'object' || message === null) return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];

    return content
      .filter(
        (
          part,
        ): part is {
          type: 'image_url';
          image_url: { url: string; detail?: string };
        } =>
          typeof part === 'object' &&
          part !== null &&
          part.type === 'image_url' &&
          typeof part.image_url?.url === 'string',
      )
      .map((part) => ({
        type: 'image' as const,
        url: part.image_url.url,
      }));
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
