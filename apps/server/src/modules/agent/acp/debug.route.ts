/**
 * `POST /api/debug/acp-prompt` — Phase 1 debug endpoint that bypasses the
 * regular `/api/agent` route to exercise the ACP client end-to-end.
 *
 * Body:
 * ```
 * {
 *   "agentId": "dev-laptop:claude:my-repo:abcd1234",
 *   "prompt":  "explain this codebase in one sentence",
 *   "cwd":     "/absolute/path"   // optional, defaults to process.cwd()
 * }
 * ```
 *
 * Streams Server-Sent Events using the same `event:`/`data:` framing as
 * `/api/agent`, but yields only `text_delta`, `done`, and `error` events
 * (translator scope for Phase 1).
 *
 * NOT to be merged into production routes — this endpoint will be deleted
 * once Phase 2's `@mention` routing in `agent.route.ts` is wired up. See
 * docs/huabu-acp-client-plan.md §Phase 1 / §Phase 2.
 */

import { AcpAgentClient } from './client.js';
import { getAgentletServer } from './server-mount.js';
import { acpUpdateToStreamEvent } from './translator.js';

import type { AgentStreamEvent } from '@sediment/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface DebugPromptBody {
  agentId?: string;
  prompt?: string;
  cwd?: string;
}

function writeSSE(raw: NodeJS.WritableStream, event: AgentStreamEvent): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

async function handleDebugPrompt(
  request: FastifyRequest<{ Body: DebugPromptBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { agentId, prompt, cwd } = request.body ?? {};

  if (!agentId || typeof agentId !== 'string') {
    return reply.status(400).send({ message: 'agentId is required' });
  }
  if (!prompt || typeof prompt !== 'string') {
    return reply.status(400).send({ message: 'prompt is required' });
  }
  const resolvedCwd = cwd && typeof cwd === 'string' ? cwd : process.cwd();

  const server = getAgentletServer();
  if (!server) {
    return reply.status(503).send({
      message:
        'Agentlet server is not mounted. Set SEDIMENT_ENABLE_ACP=1 to enable.',
    });
  }

  const conn = server.getConnection(agentId);
  if (!conn || conn.status !== 'connected') {
    return reply.status(404).send({
      message: `Agent ${agentId} is not connected`,
      available: server
        .getConnections({ status: 'connected' })
        .map((c) => c.agentId),
    });
  }

  // Hijack the response to write SSE directly.
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();
  reply.raw.write(': ok\n\n');

  const abortController = new AbortController();
  request.raw.on('close', () => {
    if (!reply.raw.writableEnded) abortController.abort();
  });

  const client = new AcpAgentClient(conn, { logger: request.log });
  let assembled = '';

  try {
    request.log.info({ agentId }, '[acp-debug] initialize');
    await client.initialize();

    request.log.info({ agentId, cwd: resolvedCwd }, '[acp-debug] session/new');
    const sessionId = await client.newSession({ cwd: resolvedCwd });

    request.log.info(
      { agentId, sessionId, promptLength: prompt.length },
      '[acp-debug] session/prompt',
    );

    const result = await client.prompt(
      sessionId,
      prompt,
      (update) => {
        const evt = acpUpdateToStreamEvent(update);
        if (!evt) {
          request.log.debug({ update }, '[acp-debug] untranslated update');
          return;
        }
        if (evt.type === 'text_delta') assembled += evt.data.content;
        writeSSE(reply.raw, evt);
      },
      abortController.signal,
    );

    writeSSE(reply.raw, {
      type: 'done',
      data: { message: assembled, meta: { stopReason: result.stopReason } },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    request.log.error({ err: message }, '[acp-debug] prompt failed');
    writeSSE(reply.raw, { type: 'error', data: { error: message } });
  } finally {
    client.shutdown('debug_route_done');
    reply.raw.write('event: end\ndata: {}\n\n');
    reply.raw.end();
  }
}

export default async function debugAcpRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Body: DebugPromptBody }>('/acp-prompt', handleDebugPrompt);
}
