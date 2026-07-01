/**
 * Reachback API Routes
 *
 * Endpoints consumed by the HRT (Huabu Reachback Tool) running inside
 * external agent processes. All routes require Bearer token auth
 * (validated by the global preHandler in app.ts).
 *
 * POST /ask-agent — SSE-streaming endpoint that runs the built-in agent
 */

import { createId } from '@sediment/shared';

import { runAgent } from '../modules/agent/agent.service.js';
import { snapshotNodesToArtifacts } from '../modules/agent/tools/handlers/snapshot-node.js';

import type { StreamEvent } from '../modules/agent/agent.service.js';
import type { Context, UserMessage } from '@earendil-works/pi-ai';
import type { FastifyPluginAsync } from 'fastify';

// ── System prompt (minimal v1 — TODO: design offline with maintainers) ──

const REACHBACK_AGENT_SYSTEM_PROMPT = `You are a built-in assistant for the Huabu canvas workspace.
You have access to canvas tools (read nodes, create nodes, edit content, manage edges).
When the user (an external AI agent) asks you a question or requests an action,
use the available tools to inspect or modify the canvas, then respond concisely.
Focus on being helpful and precise. Return factual results from the canvas — do not hallucinate node IDs or content.`;

// ── Types ──

interface AskAgentBody {
  prompt: string;
  canvasId: string;
  /**
   * The ACP conversation thread that invoked this built-in agent (from
   * the reachback `HUABU_THREAD_ID` env). Canvas changes the built-in
   * agent makes are broadcast to live frontends and attributed to this
   * thread's change card. Absent for callers with no host thread.
   */
  hostThreadId?: string;
}

interface SnapshotQuery {
  canvasId: string;
  nodeIds: string;
  maxPixels?: number;
}

/** One rendered PNG in the snapshot manifest. */
interface SnapshotImage {
  /** Artifact key (`<id>.png`); download via `/api/canvas/:canvasId/artifact/:key`. */
  key: string;
  /** PNG width in pixels (0 = unknown, e.g. an image pass-through). */
  width: number;
  /** PNG height in pixels (0 = unknown). */
  height: number;
  /** Canvas node ids whose pixels contributed to this PNG. */
  originNodeIds: string[];
}

interface SnapshotResponse {
  canvasId: string;
  images: SnapshotImage[];
}

/** Hard cap on node ids accepted in one snapshot request. */
const SNAPSHOT_MAX_NODE_IDS = 200;

// ── Route plugin ──

const reachbackRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: AskAgentBody }>(
    '/ask-agent',
    {
      schema: {
        body: {
          type: 'object',
          required: ['prompt', 'canvasId'],
          properties: {
            prompt: { type: 'string', minLength: 1 },
            canvasId: { type: 'string', minLength: 1 },
            hostThreadId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { prompt, canvasId, hostThreadId } = request.body;
      const threadId = createId('reachback');

      // Build a minimal context with the user's prompt
      const userMessage: UserMessage = {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now(),
      };
      const context: Context = {
        systemPrompt: REACHBACK_AGENT_SYSTEM_PROMPT,
        messages: [userMessage],
        tools: [],
      };

      // SSE setup — hijack the response to stream events
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      // Initial SSE comment — signals connection is alive
      reply.raw.write(': ok\n\n');

      const abortController = new AbortController();

      // Clean up on client disconnect
      const onClose = () => abortController.abort();
      request.raw.socket?.once('close', onClose);

      try {
        const stream = runAgent({
          scope: 'operate',
          canvasId,
          origin: { type: 'ai-operate' },
          context,
          logger: { info: (m) => request.log.info(m) },
          signal: abortController.signal,
          maxIterations: 10,
          // Attribute canvas writes to the host ACP conversation so its
          // change card owns them. (All canvas writes broadcast to live
          // frontends unconditionally.)
          ...(hostThreadId ? { threadId: hostThreadId } : {}),
        });

        for await (const event of stream) {
          writeSSE(reply.raw, event, threadId);
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Internal agent error';
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ error: message, threadId })}\n\n`,
        );
      } finally {
        request.raw.socket?.removeListener('close', onClose);
        reply.raw.end();
      }
    },
  );

  // ── GET /snapshot — render sketch/image nodes to PNG artifact(s) ──
  //
  // Thin exposure of the internal `snapshot_nodes` tool. Given a set of
  // node ids, it spatially clusters image + sketch nodes (frames expand
  // to their children) and rasterizes each cluster to one
  // content-addressed PNG in the canvas `.artifacts/` store. The agent
  // then downloads each PNG via the (Bearer-reachable) canvas artifact
  // route `GET /api/canvas/:canvasId/artifact/:key`.
  app.get<{ Querystring: SnapshotQuery }>(
    '/snapshot',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['canvasId', 'nodeIds'],
          properties: {
            canvasId: { type: 'string', minLength: 1 },
            nodeIds: { type: 'string', minLength: 1 },
            maxPixels: { type: 'integer', minimum: 256, maximum: 4096 },
          },
        },
      },
    },
    async (request, reply) => {
      const { canvasId, nodeIds, maxPixels } = request.query;

      // Comma-separated list; trim, drop empties, dedupe (preserve order).
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const raw of nodeIds.split(',')) {
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }

      if (ids.length === 0) {
        return reply
          .code(400)
          .send({ message: 'nodeIds must contain at least one node id' });
      }
      if (ids.length > SNAPSHOT_MAX_NODE_IDS) {
        return reply.code(400).send({
          message: `Too many node ids (${ids.length}); max ${SNAPSHOT_MAX_NODE_IDS}`,
        });
      }

      try {
        const results = await snapshotNodesToArtifacts({
          canvasId,
          nodeIds: ids,
          ...(maxPixels !== undefined ? { maxPixels } : {}),
        });
        const payload: SnapshotResponse = {
          canvasId,
          images: results.map((r) => ({
            key: r.src,
            width: r.width,
            height: r.height,
            originNodeIds: r.originNodeIds,
          })),
        };
        return reply.send(payload);
      } catch (err: unknown) {
        // `snapshotNodesToArtifacts` throws on missing / non-snapshottable
        // top-level nodes and on a missing canvas. Surface the message so
        // the HRT caller learns why, as a 400 (caller-supplied bad ids).
        const message =
          err instanceof Error ? err.message : 'Failed to snapshot nodes';
        request.log.info({ canvasId, message }, 'reachback snapshot failed');
        return reply.code(400).send({ message });
      }
    },
  );
};

// ── Helpers ──

function writeSSE(
  raw: NodeJS.WritableStream,
  event: StreamEvent,
  threadId: string,
): void {
  // Inject threadId into done events so HRT can capture it
  const data = event.type === 'done' ? { ...event.data, threadId } : event.data;
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default reachbackRoutes;
