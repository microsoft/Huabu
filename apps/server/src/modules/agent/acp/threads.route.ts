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

import { AcpServiceError } from './errors.js';
import {
  getProfileSchemaCache,
  type AcpProfileSchemaCacheEntry,
} from './profile-schema-cache.js';
import { ensureAcpSession } from './service.js';
import { acpSessionRegistry } from './session-registry.js';
import { readAcpSessionRecord } from './session-store.js';

import type { AcpSessionEntry } from './session-registry.js';
import type { AcpSessionPersistedMeta } from './session-store.js';
import type {
  AcpPermissionDecisionResponse,
  AcpSessionMetaSnapshot,
  AcpThreadCachedMetaResponse,
  AcpThreadCommandsResponse,
  EnsureAcpSessionResponse,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelResponse,
  SetAcpSessionModeResponse,
} from '@sediment/shared';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';

interface ThreadParams {
  threadId: string;
}

/**
 * Resolve the live session entry for a set-RPC (mode / model / config
 * option), opening it on-demand when none exists yet.
 *
 * The selector dropdowns are seeded from the no-spawn `/cached-meta`
 * snapshot, so the user can switch a value BEFORE the session has ever
 * been spawned. Per the `/cached-meta` contract a real ensure-session
 * is expected on "any set-RPC" — so rather than 404 when the registry
 * is cold, we spawn (or reuse) the session using the `profileId` the
 * client supplies, then let the caller apply the actual switch.
 *
 * Returns either the resolved entry or a ready-to-send error envelope:
 *   • 404 `session_not_found` — no live session AND no `profileId` to
 *     spawn with (legacy callers that didn't send spawn context).
 *   • 503 — the on-demand spawn failed; `code` mirrors the ensure
 *     route's `AcpEnsureErrorCode`.
 */
async function resolveSetRpcEntry(
  threadId: string,
  ctx: { profileId?: string; canvasId?: string; cwd?: string },
  logger: FastifyBaseLogger,
): Promise<
  | { ok: true; entry: AcpSessionEntry }
  | { ok: false; status: number; body: { message: string; code: string } }
> {
  const existing = acpSessionRegistry.get(threadId);
  if (existing) return { ok: true, entry: existing };
  if (!ctx.profileId) {
    return {
      ok: false,
      status: 404,
      body: {
        message: 'No ACP session for this thread',
        code: 'session_not_found',
      },
    };
  }
  try {
    const entry = await ensureAcpSession({
      threadId,
      binding: { alias: ctx.profileId, profileId: ctx.profileId },
      canvasId: ctx.canvasId,
      cwd: ctx.cwd,
      logger,
    });
    return { ok: true, entry };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof AcpServiceError ? err.code : 'internal';
    logger.warn(
      { threadId, code, err: message },
      '[acp/threads] on-demand ensureAcpSession for set-RPC failed',
    );
    return { ok: false, status: 503, body: { message, code } };
  }
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

/** Empty wire-shape snapshot returned when no cache exists. */
function emptySessionMetaSnapshot(): AcpSessionMetaSnapshot {
  return {
    availableModes: [],
    currentModeId: null,
    availableModels: [],
    currentModelId: null,
    configOptions: [],
    sessionInfo: null,
    usage: null,
    updatedAt: 0,
  };
}

/**
 * Project the persisted on-disk meta blob (which has every field
 * optional) into the wire-shape clients consume (which has concrete
 * defaults for every field). Used only by the read-only cached-meta
 * endpoint — the live registry's `snapshotSessionMeta` is preferred
 * whenever an in-memory entry exists.
 */
function snapshotMetaFromPersisted(
  meta: AcpSessionPersistedMeta,
): AcpSessionMetaSnapshot {
  return {
    availableModes: meta.availableModes ?? [],
    currentModeId: meta.currentModeId ?? null,
    availableModels: meta.availableModels ?? [],
    currentModelId: meta.currentModelId ?? null,
    configOptions: meta.configOptions ?? [],
    sessionInfo: meta.sessionInfo ?? null,
    usage: meta.usage ?? null,
    updatedAt: meta.metaUpdatedAt ?? 0,
  };
}

/**
 * Project the per-profile schema cache entry into the wire snapshot.
 * Used by `/cached-meta` when no per-thread record exists — schema
 * fields (catalogues) and last-known defaults (`current*`) are
 * preserved; per-session fields (`sessionInfo`, `usage`) default to
 * neutral values because they're not profile-scoped.
 */
function snapshotMetaFromProfileCache(
  entry: AcpProfileSchemaCacheEntry,
): AcpSessionMetaSnapshot {
  return {
    availableModes: entry.availableModes ?? [],
    currentModeId: entry.currentModeId ?? null,
    availableModels: entry.availableModels ?? [],
    currentModelId: entry.currentModelId ?? null,
    configOptions: entry.configOptions ?? [],
    sessionInfo: null,
    usage: null,
    updatedAt: entry.metaUpdatedAt ?? 0,
  };
}

const acpThreadsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Open (or reuse) the per-thread ACP session. Idempotent: repeated
   * calls with the same `{threadId, profileId, canvasId}` triple
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
          // Alias is purely a display hint at this stage \u2014 there's no
          // wire field for it on EnsureAcpSessionRequest, so we fall
          // back to the profileId itself. Real callers (chat panel)
          // also fetch the profile to render the picker label.
          alias: parsed.data.profileId,
          profileId: parsed.data.profileId,
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
      // Surface the categorical code when the service layer threw an
      // `AcpServiceError` — the web client switches on it to render
      // a remediation-specific tooltip / CTA. Unrecognised throws
      // collapse to `'internal'` so the client can still tell them
      // apart from the categorised failures.
      const code = err instanceof AcpServiceError ? err.code : 'internal';
      request.log.warn(
        { threadId, code, err: message },
        '[acp/threads] ensureAcpSession failed',
      );
      return reply.status(503).send({ message, code });
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
   * Read-only **no-spawn** meta snapshot for a thread.
   *
   * Unlike `POST /threads/:threadId/session`, this route NEVER
   * contacts the agentlet — it returns whatever the server already
   * has cached, in priority order:
   *
   *   1. Live entry in `acpSessionRegistry` (some prior call already
   *      opened the session this lifetime) → freshest state.
   *   2. Per-thread persisted record (`session-store`) → last known
   *      state of THIS thread (includes per-thread `current*` choices
   *      and per-session `sessionInfo` / `usage`).
   *   3. Per-profile schema cache (`profile-schema-cache`) → schema
   *      (model / mode / config option catalogues) shared across all
   *      threads of the same profile, plus the last-known
   *      `current*` defaults from any session of this profile.
   *      Used when opening a BRAND-NEW thread bound to a profile the
   *      user has used before — toolbar populates instantly, no spawn.
   *   4. Cache miss (truly first use of this profile on this server)
   *      → empty snapshot with `updatedAt === 0`. UI treats as
   *      "neutral / no data yet", NOT a failure.
   *
   * Designed for the web's `useAcpSessionMeta` hydrate-on-mount path:
   * opening a thread populates dropdowns from cache (so the user can
   * pre-select before sending) without paying the agentlet cold-start
   * tax. Real ensure-session still happens on `/` menu open, first
   * message send, or any set-RPC — all of which write the freshest
   * snapshot back to disk via `schedulePersistEntryMeta` AND mirror
   * to the per-profile cache via `mirrorEntryToProfileCache`.
   *
   * Always responds 200 — absence of cache is a normal state.
   */
  app.get<{
    Params: ThreadParams;
    Querystring: { canvasId?: string; profileId?: string };
    Reply: AcpThreadCachedMetaResponse;
  }>('/threads/:threadId/cached-meta', async (request) => {
    const { threadId } = request.params;
    const { canvasId, profileId } = request.query;
    const live = acpSessionRegistry.get(threadId);
    if (live) return { sessionMeta: snapshotSessionMeta(live) };
    if (canvasId) {
      const persisted = readAcpSessionRecord(canvasId, threadId);
      if (persisted?.meta) {
        return { sessionMeta: snapshotMetaFromPersisted(persisted.meta) };
      }
    }
    if (profileId) {
      const profileCache = getProfileSchemaCache(profileId);
      if (profileCache && (profileCache.metaUpdatedAt ?? 0) > 0) {
        return { sessionMeta: snapshotMetaFromProfileCache(profileCache) };
      }
    }
    return { sessionMeta: emptySessionMetaSnapshot() };
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
    const resolved = await resolveSetRpcEntry(
      threadId,
      {
        profileId: parsed.data.profileId,
        canvasId: parsed.data.canvasId,
        cwd: parsed.data.cwd,
      },
      request.log,
    );
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }
    const entry = resolved.entry;
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
    const resolved = await resolveSetRpcEntry(
      threadId,
      {
        profileId: parsed.data.profileId,
        canvasId: parsed.data.canvasId,
        cwd: parsed.data.cwd,
      },
      request.log,
    );
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }
    const entry = resolved.entry;
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
    const resolved = await resolveSetRpcEntry(
      threadId,
      {
        profileId: parsed.data.profileId,
        canvasId: parsed.data.canvasId,
        cwd: parsed.data.cwd,
      },
      request.log,
    );
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }
    const entry = resolved.entry;
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
