/**
 * Sideband API Routes
 *
 * Endpoints consumed by the HST (Huabu Sideband Tool) running inside
 * external agent processes. All routes require Bearer token auth
 * (validated by the global preHandler in app.ts).
 *
 * POST /ask-agent — SSE-streaming endpoint that runs the built-in agent
 */

import { createId } from '@sediment/shared';

import { runAgent } from '../modules/agent/agent.service.js';

import type { StreamEvent } from '../modules/agent/agent.service.js';
import type { Context, UserMessage } from '@earendil-works/pi-ai';
import type { FastifyPluginAsync } from 'fastify';

// ── System prompt (minimal v1 — TODO: design offline with maintainers) ──

const SIDEBAND_AGENT_SYSTEM_PROMPT = `You are a built-in assistant for the Huabu canvas workspace.
You have access to canvas tools (read nodes, create nodes, edit content, manage edges).
When the user (an external AI agent) asks you a question or requests an action,
use the available tools to inspect or modify the canvas, then respond concisely.
Focus on being helpful and precise. Return factual results from the canvas — do not hallucinate node IDs or content.`;

// ── Types ──

interface AskAgentBody {
  prompt: string;
  canvasId: string;
}

// ── Route plugin ──

const sidebandRoutes: FastifyPluginAsync = async (app) => {
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
          },
        },
      },
    },
    async (request, reply) => {
      const { prompt, canvasId } = request.body;
      const threadId = createId('sideband');

      // Build a minimal context with the user's prompt
      const userMessage: UserMessage = {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now(),
      };
      const context: Context = {
        systemPrompt: SIDEBAND_AGENT_SYSTEM_PROMPT,
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
};

// ── Helpers ──

function writeSSE(
  raw: NodeJS.WritableStream,
  event: StreamEvent,
  threadId: string,
): void {
  // Inject threadId into done events so HST can capture it
  const data = event.type === 'done' ? { ...event.data, threadId } : event.data;
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default sidebandRoutes;
