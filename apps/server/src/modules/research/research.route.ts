/**
 * Research Route
 *
 * Streams AgentEvent objects — the same format as the chat route.
 * All research progress is carried via messages with structured toolResponse,
 * so no special research-specific event types are needed.
 */

import { ResearchAgent } from './research.agent.js';

import type { ResearchStateType } from './graphs/research.state.js';
import type { AgentEvent } from '../agent/base/index.js';
import type {
  ChatHistoryResponse,
  ResearchRequest,
  ToolResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Write SSE event
 */
function writeEvent(raw: NodeJS.WritableStream, event: AgentEvent) {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Research Routes
 */
const researchRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  // Create ResearchAgent instance (lazy initialization)
  let agentPromise: Promise<ResearchAgent> | null = null;
  const getAgent = () => {
    if (!agentPromise) {
      agentPromise = ResearchAgent.create();
    }
    return agentPromise;
  };

  /**
   * GET /research/history/:threadId
   * Return the persisted research state for a thread.
   * Returns same format as chat history for unified handling.
   */
  fastify.get<{
    Params: { threadId: string };
    Reply: ChatHistoryResponse;
  }>('/history/:threadId', async function (request, reply) {
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
          error: 'Session not found',
        } as unknown as ChatHistoryResponse);
      }

      // All progress info is now in state.messages — same shape as chat history.
      const rawMessages: unknown[] = Array.isArray(state.messages)
        ? state.messages
        : [];

      type MsgEntry =
        | { role: 'user' | 'assistant'; content: string }
        | { role: 'tool'; toolResponse: ToolResponse<string, unknown> };

      const messages: MsgEntry[] = rawMessages.flatMap<MsgEntry>((m) => {
        if (!m || typeof m !== 'object') return [];
        const obj = m as Record<string, unknown>;
        // Use both _getType() and constructor.name as fallback (matches chat route)
        const type =
          typeof obj._getType === 'function'
            ? (obj._getType as () => string)()
            : null;
        const ctorName = (obj as { constructor?: { name?: string } })
          .constructor?.name;
        const content = typeof obj.content === 'string' ? obj.content : '';
        const kwargs = obj.additional_kwargs as
          | Record<string, unknown>
          | undefined;
        const toolResponse = kwargs?.toolResponse as
          | ToolResponse<string, unknown>
          | undefined;

        const isAi = type === 'ai' || ctorName === 'AIMessage';
        const isHuman = type === 'human' || ctorName === 'HumanMessage';

        if (isAi) {
          if (toolResponse) return [{ role: 'tool' as const, toolResponse }];
          if (content) return [{ role: 'assistant' as const, content }];
        }
        if (isHuman && content) return [{ role: 'user' as const, content }];
        return [];
      });

      return reply.send({ threadId, messages });
    } catch (error) {
      request.log.error(error, 'Failed to fetch research history');
      return reply.code(500).send({
        error: 'Internal server error',
      } as unknown as ChatHistoryResponse);
    }
  });

  /**
   * POST /research
   * Start deep research and stream results
   */
  fastify.post<{ Body: ResearchRequest }>('/', async function (request, reply) {
    const { query, canvasId, canvasVersion, threadId, config } = request.body;

    // Validation
    if (!query || query.trim().length === 0) {
      return reply.code(400).send({
        error: 'Query is required',
      });
    }

    if (!canvasId) {
      return reply.code(400).send({
        error: 'Canvas ID is required',
      });
    }

    if (!threadId || threadId.trim().length === 0) {
      return reply.code(400).send({
        error: 'Thread ID is required',
      });
    }

    request.log.info(
      {
        query: query.slice(0, 100),
        canvasId,
        canvasVersion,
        config,
      },
      'Starting deep research',
    );

    // Hijack response for SSE streaming
    reply.hijack();

    // SSE Headers
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

      const startTime = Date.now();

      // Prepare initial state
      const initialState: Partial<ResearchStateType> = {
        query,
        canvasId,
        threadId,
        canvasVersion: canvasVersion ?? 0,
        config: {
          searchDepth: config?.searchDepth ?? 'advanced',
          placement: config?.placement ?? 'auto',
          groupWithFrame: config?.groupWithFrame ?? true,
          padding: config?.padding,
        },
        subQueries: [],
        searchResults: [],
        createdNodeIds: [],
        synthesisNodeIds: [],
        messages: [],
        errors: [],
        startTime,
      };

      // Stream AgentEvents directly — same format as chat route
      for await (const event of agent.stream(initialState, threadId)) {
        writeEvent(reply.raw, event);
      }

      // Emit complete event with final state metadata
      const finalState = await agent.getHistory(threadId);
      writeEvent(reply.raw, {
        type: 'complete',
        timestamp: Date.now(),
        data: {
          meta: {
            frameId: finalState?.frameId ?? null,
            nodeCount: finalState?.createdNodeIds?.length ?? 0,
            duration: Date.now() - startTime,
          },
        },
      });

      request.log.info('Research completed successfully');
    } catch (error) {
      request.log.error(error, 'Research failed');
      const errorMsg =
        error instanceof Error ? error.message : 'Internal Error';

      writeEvent(reply.raw, {
        type: 'error',
        timestamp: Date.now(),
        data: {
          meta: { message: errorMsg, recoverable: false },
        },
      });
    } finally {
      reply.raw.end();
    }
  });
};

export default researchRoutes;
