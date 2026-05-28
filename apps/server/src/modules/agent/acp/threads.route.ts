/**
 * `POST /api/acp/threads/:threadId/session` — eagerly open (or reuse) the
 * per-thread ACP session so the web client can pull slash commands BEFORE
 * the user submits their first prompt.
 *
 * `GET  /api/acp/threads/:threadId/commands` — return the cached
 * `available_commands_update` snapshot for an existing session (404 if
 * no session has been opened for this thread yet).
 *
 * Why a dedicated route family (instead of widening `agents.route.ts`):
 *  - These endpoints are thread-scoped, not agent-scoped.
 *  - They mutate (or read) per-thread session state that lives in
 *    `acpSessionRegistry`. Keeping that surface separate makes the
 *    read-only `agents` list easier to reason about.
 *
 * Wire contracts (`EnsureAcpSessionRequest` / `EnsureAcpSessionResponse`
 * / `AcpThreadCommandsResponse`) live in `@sediment/shared`; this route
 * validates every body with `safeParse` per docs/api-design.md.
 *
 * Auth: relies on the global Basic-Auth gate (app.ts). No additional
 * per-route check — the agentlet bridge itself is gated by
 * `token-store.ts`.
 */

import { ensureAcpSessionRequestSchema } from '@sediment/shared';

import { ensureAcpSession } from './service.js';
import { acpSessionRegistry } from './session-registry.js';

import type {
  AcpThreadCommandsResponse,
  EnsureAcpSessionResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

interface ThreadParams {
  threadId: string;
}

const acpThreadsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Open (or reuse) the per-thread ACP session. Idempotent: repeated
   * calls with the same `{threadId, agentletAgentId, canvasId}` triple
   * return the same session id. Response always includes the latest
   * cached `availableCommands`; an empty array means the agent has
   * not yet pushed its list (caller should poll
   * `/threads/:threadId/commands` after a short delay).
   */
  app.post<{
    Params: ThreadParams;
    Reply: EnsureAcpSessionResponse | { message: string; code?: string };
  }>('/threads/:threadId/session', async (request, reply) => {
    const { threadId } = request.params;
    if (!threadId || threadId.length === 0) {
      return reply
        .status(400)
        .send({ message: 'threadId is required', code: 'bad_request' });
    }

    const parsed = ensureAcpSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn(
        { threadId, issues: parsed.error.issues },
        '[acp/threads] invalid session request body',
      );
      return reply.status(400).send({
        message: 'Invalid request body',
        code: 'validation_failed',
      });
    }

    try {
      const entry = await ensureAcpSession({
        threadId,
        binding: {
          alias: parsed.data.alias,
          agentletAgentId: parsed.data.agentletAgentId,
        },
        canvasId: parsed.data.canvasId,
        cwd: parsed.data.cwd,
        logger: request.log,
      });
      return {
        sessionId: entry.sessionId,
        availableCommands: entry.availableCommands,
        updatedAt: entry.commandsUpdatedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { threadId, err: message },
        '[acp/threads] ensureAcpSession failed',
      );
      return reply.status(503).send({ message, code: 'acp_session_failed' });
    }
  });

  /**
   * Read the cached slash-command snapshot for an existing session.
   * Returns 404 when no session has been opened for `threadId` yet —
   * the caller should POST `/threads/:threadId/session` first.
   *
   * `updatedAt` is `0` when the session exists but the agent has not
   * pushed `available_commands_update` yet. The web client uses this
   * to decide whether to schedule a delayed re-fetch.
   */
  app.get<{
    Params: ThreadParams;
    Reply: AcpThreadCommandsResponse | { message: string; code?: string };
  }>('/threads/:threadId/commands', async (request, reply) => {
    const { threadId } = request.params;
    const entry = acpSessionRegistry.get(threadId);
    if (!entry) {
      return reply.status(404).send({
        message: 'No ACP session for this thread',
        code: 'session_not_found',
      });
    }
    return {
      sessionId: entry.sessionId,
      availableCommands: entry.availableCommands,
      updatedAt: entry.commandsUpdatedAt,
    };
  });
};

export default acpThreadsRoutes;
