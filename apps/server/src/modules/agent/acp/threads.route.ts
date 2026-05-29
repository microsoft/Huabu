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

import {
  acpPermissionDecisionSchema,
  ensureAcpSessionRequestSchema,
  setAcpSessionConfigOptionRequestSchema,
  setAcpSessionModeRequestSchema,
  setAcpSessionModelRequestSchema,
} from '@sediment/shared';

import { ensureAcpSession } from './service.js';
import { acpSessionRegistry } from './session-registry.js';

import type { AcpSessionEntry } from './session-registry.js';
import type {
  AcpPermissionDecisionResponse,
  AcpSessionMetaSnapshot,
  AcpThreadCommandsResponse,
  EnsureAcpSessionResponse,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelResponse,
  SetAcpSessionModeResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

interface ThreadParams {
  threadId: string;
}

/**
 * Project the mutable session-meta fields cached on the entry into the
 * wire-shape clients consume. Pure; safe to call on every response.
 */
function snapshotSessionMeta(entry: AcpSessionEntry): AcpSessionMetaSnapshot {
  return {
    availableModes: entry.availableModes,
    currentModeId: entry.currentModeId,
    availableModels: entry.availableModels,
    currentModelId: entry.currentModelId,
    configOptions: entry.configOptions,
    sessionInfo: entry.sessionInfo,
    usage: entry.usage,
    updatedAt: entry.metaUpdatedAt,
  };
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
        sessionMeta: snapshotSessionMeta(entry),
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
      sessionMeta: snapshotSessionMeta(entry),
    };
  });

  /**
   * Answer an outstanding `session/request_permission` for this thread.
   *
   * SSE is one-way, so the user's approve/deny choice (surfaced via a
   * `permission_request` event) comes back over this POST. The body
   * carries the originating `requestId` plus either an `optionId`
   * (selected) or `cancelled: true`. `resolved: false` means no
   * suspended request matched — already answered, timed out, or the
   * session ended; the client can safely ignore it.
   */
  app.post<{
    Params: ThreadParams;
    Reply: AcpPermissionDecisionResponse | { message: string; code?: string };
  }>('/threads/:threadId/permission', async (request, reply) => {
    const { threadId } = request.params;
    const entry = acpSessionRegistry.get(threadId);
    if (!entry) {
      return reply.status(404).send({
        message: 'No ACP session for this thread',
        code: 'session_not_found',
      });
    }

    const parsed = acpPermissionDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn(
        { threadId, issues: parsed.error.issues },
        '[acp/threads] invalid permission decision body',
      );
      return reply.status(400).send({
        message: 'Invalid request body',
        code: 'validation_failed',
      });
    }

    const { requestId, optionId, cancelled } = parsed.data;
    const resolved = entry.client.resolvePermission(
      requestId,
      cancelled || !optionId ? { cancelled: true } : { optionId },
    );
    return { resolved };
  });

  // ── Session-meta set-RPCs ─────────────────────────────────────────
  //
  // Three POSTs surface the corresponding ACP `session/set_*` calls.
  // They mutate session-meta state on the agent; the agent confirms
  // by pushing a `session/update` notification that flows back into
  // the session entry through `handleSessionMetaUpdate`. The HTTP
  // response is therefore best treated as "request accepted" — the
  // authoritative state is the one carried by the next SSE event.
  //
  // Failure modes:
  //   • 404 — no session for this thread (caller must POST `/session`
  //     first).
  //   • 400 — body failed `safeParse`.
  //   • 502 — agent rejected the RPC (unknown id, capability missing,
  //     transport error). The user-visible message comes from the
  //     agent's rejection.

  app.post<{
    Params: ThreadParams;
    Reply: SetAcpSessionModeResponse | { message: string; code?: string };
  }>('/threads/:threadId/mode', async (request, reply) => {
    const { threadId } = request.params;
    const entry = acpSessionRegistry.get(threadId);
    if (!entry) {
      return reply.status(404).send({
        message: 'No ACP session for this thread',
        code: 'session_not_found',
      });
    }
    const parsed = setAcpSessionModeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn(
        { threadId, issues: parsed.error.issues },
        '[acp/threads] invalid set-mode body',
      );
      return reply.status(400).send({
        message: 'Invalid request body',
        code: 'validation_failed',
      });
    }
    try {
      await entry.client.setSessionMode(entry.sessionId, parsed.data.modeId);
      // Optimistic local update so the next GET returns the new id
      // even before the agent's confirmation notification lands.
      entry.currentModeId = parsed.data.modeId;
      entry.metaUpdatedAt = Date.now();
      return { ok: true as const, modeId: parsed.data.modeId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { threadId, modeId: parsed.data.modeId, err: message },
        '[acp/threads] setSessionMode failed',
      );
      return reply.status(502).send({ message, code: 'acp_set_mode_failed' });
    }
  });

  app.post<{
    Params: ThreadParams;
    Reply: SetAcpSessionModelResponse | { message: string; code?: string };
  }>('/threads/:threadId/model', async (request, reply) => {
    const { threadId } = request.params;
    const entry = acpSessionRegistry.get(threadId);
    if (!entry) {
      return reply.status(404).send({
        message: 'No ACP session for this thread',
        code: 'session_not_found',
      });
    }
    const parsed = setAcpSessionModelRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn(
        { threadId, issues: parsed.error.issues },
        '[acp/threads] invalid set-model body',
      );
      return reply.status(400).send({
        message: 'Invalid request body',
        code: 'validation_failed',
      });
    }
    try {
      await entry.client.setSessionModel(entry.sessionId, parsed.data.modelId);
      entry.currentModelId = parsed.data.modelId;
      entry.metaUpdatedAt = Date.now();
      return { ok: true as const, modelId: parsed.data.modelId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { threadId, modelId: parsed.data.modelId, err: message },
        '[acp/threads] setSessionModel failed',
      );
      return reply.status(502).send({ message, code: 'acp_set_model_failed' });
    }
  });

  app.post<{
    Params: ThreadParams;
    Reply:
      | SetAcpSessionConfigOptionResponse
      | { message: string; code?: string };
  }>('/threads/:threadId/config-option', async (request, reply) => {
    const { threadId } = request.params;
    const entry = acpSessionRegistry.get(threadId);
    if (!entry) {
      return reply.status(404).send({
        message: 'No ACP session for this thread',
        code: 'session_not_found',
      });
    }
    const parsed = setAcpSessionConfigOptionRequestSchema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      request.log.warn(
        { threadId, issues: parsed.error.issues },
        '[acp/threads] invalid set-config-option body',
      );
      return reply.status(400).send({
        message: 'Invalid request body',
        code: 'validation_failed',
      });
    }
    try {
      await entry.client.setSessionConfigOption(
        entry.sessionId,
        parsed.data.configOptionId,
        parsed.data.value,
      );
      entry.metaUpdatedAt = Date.now();
      return {
        ok: true as const,
        configOptionId: parsed.data.configOptionId,
        value: parsed.data.value,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        {
          threadId,
          configOptionId: parsed.data.configOptionId,
          err: message,
        },
        '[acp/threads] setSessionConfigOption failed',
      );
      return reply
        .status(502)
        .send({ message, code: 'acp_set_config_option_failed' });
    }
  });
};

export default acpThreadsRoutes;
