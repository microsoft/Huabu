import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createId } from '@sediment/shared';

import { SYSTEM_PROMPT } from '../../prompt/system.js';
import { createGraph } from '../agent/graph.js';
import { getCheckpointer } from '../agent/store/index.js';
import { getCanvasDb } from '../canvas/canvas.db.js';
import { buildContext } from '../knowledge/index.js';

import type {
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

async function hasExistingThreadState(
  agent: unknown,
  config: { configurable: { thread_id: string } },
): Promise<boolean> {
  const maybeGetState = (
    agent as { getState?: (c: unknown) => Promise<unknown> }
  ).getState;
  if (typeof maybeGetState !== 'function') return false;

  try {
    const state = await maybeGetState(config);
    const values = (state as { values?: unknown })?.values;
    const messages = (values as { messages?: unknown })?.messages;
    return Array.isArray(messages) && messages.length > 0;
  } catch {
    return false;
  }
}

function isLangChainMessage(value: unknown): value is {
  content?: unknown;
  _getType?: () => string;
  constructor?: { name?: string };
} {
  return typeof value === 'object' && value !== null;
}

function normalizeRole(message: unknown): 'user' | 'assistant' | 'tool' {
  if (!isLangChainMessage(message)) return 'assistant';

  const type = message._getType?.();
  const ctorName = message.constructor?.name;

  if (type === 'tool' || ctorName === 'ToolMessage') return 'tool';

  return type === 'human' || ctorName === 'HumanMessage' ? 'user' : 'assistant';
}

function normalizeContent(message: unknown): string {
  if (!isLangChainMessage(message)) {
    return typeof message === 'string'
      ? message
      : JSON.stringify(message ?? '');
  }

  const content = message.content;
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? '');
}

function getTextDelta(message: unknown): string | null {
  if (!isLangChainMessage(message)) {
    return typeof message === 'string' ? message : null;
  }

  return typeof message.content === 'string' ? message.content : null;
}

function writeUpdate(
  raw: NodeJS.WritableStream,
  payload: ChatStreamUpdatePayload,
) {
  raw.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseToolResponse(
  content: string,
): ToolResponse<string, unknown> | null {
  try {
    const data = JSON.parse(content) as unknown;
    if (!isRecord(data)) return null;
    if (typeof data.tool !== 'string') return null;
    if (data.status !== 'success' && data.status !== 'error') return null;

    if (data.status === 'error') {
      if (typeof data.error !== 'string') return null;
      if (typeof data.hint !== 'undefined' && typeof data.hint !== 'string') {
        return null;
      }
    }

    return data as ToolResponse<string, unknown>;
  } catch {
    return null;
  }
}

function getUpdateMessages(value: unknown): unknown[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const messages = (value as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : null;
}

const chatRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  // Compile the graph once (with checkpointer for multi-turn persistence)
  const checkpointer = await getCheckpointer();
  const agent = createGraph({ checkpointer });

  fastify.post<{ Body: SendMessageRequest; Reply: SendMessageResponse }>(
    '/',
    async function (request, reply) {
      const { content, threadId, canvasId, canvasVersion, selectedNodeIds } =
        request.body;
      const resolvedThreadId = getOrCreateThreadId(threadId);

      // Load sourceIds from canvas_nodes for selected nodes
      const sourceIds: string[] = [];

      if (canvasId && selectedNodeIds && selectedNodeIds.length > 0) {
        try {
          const database = getCanvasDb();

          // Version check: ensure client has the latest canvas state
          if (typeof canvasVersion === 'number') {
            const canvasRow = database
              .prepare('SELECT version FROM canvases WHERE canvas_id = ?')
              .get(canvasId) as { version: number } | undefined;

            if (canvasRow && canvasRow.version !== canvasVersion) {
              return reply.code(409).send({
                error:
                  'Canvas version mismatch. Please refresh canvas and try again.',
              });
            }
          }

          // Load sourceIds from canvas_nodes
          const placeholders = selectedNodeIds.map(() => '?').join(',');
          const rows = database
            .prepare(
              `SELECT node_id, source_id
               FROM canvas_nodes
               WHERE canvas_id = ? AND node_id IN (${placeholders})`,
            )
            .all(canvasId, ...selectedNodeIds) as Array<{
            node_id: string;
            source_id: string | null;
          }>;

          for (const row of rows) {
            if (row.source_id) {
              sourceIds.push(row.source_id);
            } else {
              request.log.warn(
                { nodeId: row.node_id },
                'Node has no sourceId (not yet ingested or unsupported type)',
              );
            }
          }

          request.log.info(
            {
              canvasId,
              selectedNodeIds: selectedNodeIds.length,
              loadedSources: sourceIds.length,
            },
            'Loaded sourceIds from canvas_nodes',
          );
        } catch (error) {
          request.log.error(
            error,
            'Failed to load sourceIds from canvas_nodes',
          );
          // Don't fail the request, just log the error
          // Chat can proceed without sources
        }
      }

      // Build context from ingested sources
      let contextString = '';
      if (sourceIds.length > 0) {
        try {
          const { context, sources } = await buildContext(sourceIds);
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

      // We'll stream the response manually via reply.raw
      reply.hijack();

      // SSE Headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        // Avoid proxy buffering (nginx, etc.)
        'X-Accel-Buffering': 'no',
      });

      // Ensure headers are sent immediately
      reply.raw.flushHeaders?.();
      // Kick the stream so clients don't wait for the first payload
      reply.raw.write(': ok\n\n');

      try {
        const config = {
          configurable: { thread_id: resolvedThreadId },
        };

        const isExisting = await hasExistingThreadState(agent, config);

        // Prepare system message with context if available
        const systemPrompt = contextString
          ? `${SYSTEM_PROMPT}\n\n${contextString}`
          : SYSTEM_PROMPT;

        const inputs = {
          messages: isExisting
            ? [new HumanMessage(content)]
            : [new SystemMessage(systemPrompt), new HumanMessage(content)],
        };

        if (process.env.DEBUG_AGENT === '1') {
          request.log.info(
            {
              contentLength: content?.length,
              hasAzureKey: Boolean(process.env.AZURE_OPENAI_API_KEY),
              hasAzureEndpoint: Boolean(process.env.AZURE_OPENAI_API_ENDPOINT),
            },
            'chat: starting agent stream',
          );
        }

        // We request both:
        // - 'messages': token-level message chunks (for progressive UI updates)
        // - 'updates': node-level updates (tool results, final messages, etc.)
        const stream = await agent.stream(inputs, {
          streamMode: ['messages', 'updates'],
          ...config,
        });

        // Let the client know which thread is being used (for clients that don't send one yet).
        writeUpdate(reply.raw, {
          node: 'meta',
          metadata: { threadId: resolvedThreadId },
        });

        let assistantText = '';

        for await (const chunk of stream) {
          if (process.env.DEBUG_AGENT === '1') {
            request.log.info({ chunk }, 'chat: agent stream chunk');
          }

          // When multiple stream modes are enabled, LangGraph yields tuples:
          //   ['messages', [BaseMessage, metadata]]
          //   ['updates',  { agent: { messages: [...] } }]
          if (!Array.isArray(chunk) || typeof chunk[0] !== 'string') continue;

          const mode = chunk[0];
          const payload = chunk[1];

          if (mode === 'messages') {
            if (!Array.isArray(payload) || payload.length !== 2) continue;
            const message = payload[0];
            const metadata = payload[1] as Record<string, unknown>;
            const nodeName =
              typeof metadata.langgraph_node === 'string'
                ? metadata.langgraph_node
                : 'agent';

            // Only stream token-level deltas for the LLM node.
            // ToolNode outputs are sent via `updates` mode to avoid duplicates.
            if (nodeName !== 'agent') continue;

            if (normalizeRole(message) !== 'assistant') continue;

            const delta = getTextDelta(message);
            assistantText = delta
              ? assistantText + delta
              : normalizeContent(message);

            writeUpdate(reply.raw, {
              node: nodeName,
              message: { role: 'assistant', content: assistantText },
            });
            continue;
          }

          if (mode === 'updates') {
            if (typeof payload !== 'object' || payload === null) continue;
            const updateObj = payload as Record<string, unknown>;
            const nodeName = Object.keys(updateObj)[0] ?? 'unknown';
            const nodeResult = updateObj[nodeName];

            const messages = getUpdateMessages(nodeResult);
            if (!messages || messages.length === 0) continue;

            const lastMessage = messages[messages.length - 1];
            const role = normalizeRole(lastMessage);
            const normalizedContent = normalizeContent(lastMessage);

            if (nodeName === 'agent' && role === 'assistant') {
              assistantText = normalizedContent;
            }

            if (nodeName === 'tools') {
              const toolResponse = parseToolResponse(normalizedContent);
              writeUpdate(reply.raw, {
                node: nodeName,
                toolResponse: toolResponse ?? undefined,
                message: { role: 'tool', content: normalizedContent },
              });
            } else {
              writeUpdate(reply.raw, {
                node: nodeName,
                message: { role, content: normalizedContent },
              });
            }
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
};

export default chatRoutes;
