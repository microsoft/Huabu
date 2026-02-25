/**
 * Research Route
 *
 * Handles deep research requests with SSE streaming.
 */

import { getResearchGraph } from './graphs/research.graph.js';

import type { ResearchStateType } from './graphs/research.state.js';
import type { ResearchEvent, ResearchRequest } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Write SSE event
 */
function writeEvent(raw: NodeJS.WritableStream, event: ResearchEvent) {
  const eventType = event.type;
  raw.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Research Routes
 */
const researchRoutes: FastifyPluginAsync = async (
  fastify,
  _opts,
): Promise<void> => {
  /**
   * POST /research
   * Start deep research and stream results
   */
  fastify.post<{ Body: ResearchRequest }>('/', async function (request, reply) {
    const { query, canvasId, canvasVersion, config } = request.body;

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
      // Get research graph
      const graph = getResearchGraph();

      // Prepare initial state
      const startTime = Date.now();
      const sessionId = `research-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;

      const initialState: Partial<ResearchStateType> = {
        query,
        canvasId,
        sessionId,
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

      // Send initial thinking event
      writeEvent(reply.raw, {
        type: 'thinking',
        timestamp: startTime,
        data: {
          step: 'Starting research...',
          content: `Query: ${query}`,
        },
      });

      // Track current step
      let currentStep = 'Initializing...';
      // Track how many errors have already been sent to avoid re-sending duplicates
      let sentErrorCount = 0;

      // Stream graph execution
      const stream = await graph.stream(initialState, {
        streamMode: ['updates', 'values'],
      });

      for await (const chunk of stream) {
        if (process.env.DEBUG_AGENT === '1') {
          request.log.info({ chunk }, 'research: stream chunk');
        }

        // LangGraph yields tuples: [mode, payload]
        if (!Array.isArray(chunk) || typeof chunk[0] !== 'string') continue;

        const mode = chunk[0];
        const payload = chunk[1];

        if (mode === 'updates') {
          // Node execution updates
          if (typeof payload !== 'object' || payload === null) continue;
          const updateObj = payload as Record<string, unknown>;
          const nodeName = Object.keys(updateObj)[0] ?? 'unknown';

          // Map node names to user-friendly steps
          const stepMap: Record<string, string> = {
            'query-analysis': 'Analyzing your query...',
            'multi-search': 'Searching for sources...',
            ingestion: 'Processing content...',
            synthesis: 'Generating insights...',
            'canvas-organization': 'Organizing canvas...',
          };

          currentStep = stepMap[nodeName] ?? nodeName;

          writeEvent(reply.raw, {
            type: 'thinking',
            timestamp: Date.now(),
            data: {
              step: currentStep,
              content: `Executing ${nodeName}...`,
            },
          });
        }

        if (mode === 'values') {
          // Full state updates
          const state = payload as Partial<ResearchStateType>;

          // Send searching event when we have search results
          if (state.searchResults && state.searchResults.length > 0) {
            const firstQuery = state.subQueries?.[0] ?? query;
            writeEvent(reply.raw, {
              type: 'searching',
              timestamp: Date.now(),
              data: {
                query: firstQuery,
                resultCount: state.searchResults.length,
              },
            });

            // Send node_created events for each search result
            const newResults = state.searchResults.filter(
              (result) => result.nodeId,
            );
            for (const result of newResults) {
              if (!result.nodeId) continue;
              writeEvent(reply.raw, {
                type: 'node_created',
                timestamp: Date.now(),
                data: {
                  nodeId: result.nodeId,
                  nodeType: 'web',
                  position: { x: 0, y: 0 }, // Position calculated by backend
                  data: {
                    url: result.url,
                    title: result.title,
                  },
                },
              });
            }
          }

          // Send synthesis event if we have synthesis nodes
          if (state.synthesisNodeIds && state.synthesisNodeIds.length > 0) {
            for (const nodeId of state.synthesisNodeIds) {
              writeEvent(reply.raw, {
                type: 'synthesis',
                timestamp: Date.now(),
                data: {
                  content: 'Generated AI synthesis',
                  nodeId,
                  relatedNodeIds: state.createdNodeIds ?? [],
                },
              });
            }
          }

          // Send node_created event for frame
          if (state.frameId) {
            writeEvent(reply.raw, {
              type: 'node_created',
              timestamp: Date.now(),
              data: {
                nodeId: state.frameId,
                nodeType: 'frame',
                position: { x: 0, y: 0 },
                data: {
                  label: `Research: ${query.slice(0, 40)}`,
                },
              },
            });
          }

          // Send only new error events (avoid re-sending already-sent errors)
          if (state.errors && state.errors.length > sentErrorCount) {
            const newErrors = state.errors.slice(sentErrorCount);
            sentErrorCount = state.errors.length;
            for (const error of newErrors) {
              writeEvent(reply.raw, {
                type: 'error',
                timestamp: Date.now(),
                data: {
                  message: error,
                  recoverable: true,
                },
              });
            }
          }
        }
      }

      // Send complete event
      writeEvent(reply.raw, {
        type: 'complete',
        timestamp: Date.now(),
        data: {
          frameId: undefined,
          canvasVersion: 1,
          nodeCount: 0,
          duration: Date.now() - startTime,
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
          message: errorMsg,
          recoverable: false,
        },
      });
    } finally {
      reply.raw.end();
    }
  });
};

export default researchRoutes;
