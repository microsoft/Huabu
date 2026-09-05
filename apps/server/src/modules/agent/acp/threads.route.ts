// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { acpSessionRegistry } from '@agenetes/acp-driver';
import { getSupervisedAgentletId } from '@agenetes/agentlet-host';

import {
  acpPermissionDecisionSchema,
  acpThreadCachedMetaQuerySchema,
  setAcpSessionConfigOptionRequestSchema,
  setAcpSessionModeRequestSchema,
  setAcpSessionModelRequestSchema,
} from '@huabu/shared';

import {
  externalAgentRealization,
  realizationHttpError,
} from './external-agent-realization.js';
import { getProfileSchemaCache } from './profile-schema-cache.js';
import {
  rememberProfileConfigPreference,
  rememberProfileSessionPreference,
} from './profile-session-preferences.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';
import { agenetes } from '../agenetes/index.js';

import type { AcpProfileSchemaCacheEntry } from './profile-schema-cache.js';
import type { AcpSessionEntry } from '@agenetes/acp-driver';
import type { AgentMetadata } from '@agenetes/protocol';
import type {
  AcpPermissionDecisionResponse,
  AcpSessionMetaSnapshot,
  AcpThreadCachedMetaQuery,
  AcpThreadCachedMetaResponse,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelResponse,
  SetAcpSessionModeResponse,
} from '@huabu/shared';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';

interface ThreadParams {
  threadId: string;
}

function controlFailureStatus(code?: string): 409 | 502 {
  return code === 'session_suspended' ? 409 : 502;
}

function controlFailureCode(operation: string, code?: string): string {
  return code === 'session_suspended' ? code : `acp_${operation}_failed`;
}

async function realizeControlThread(
  threadId: string,
  target: {
    binding: { kind: 'external'; alias: string; profileId: string };
    canvasId?: string;
    cwd?: string;
  },
  logger: FastifyBaseLogger,
) {
  try {
    const realized = await externalAgentRealization.realize({
      threadId,
      canvasId: target.canvasId,
      requestedBinding: target.binding,
      requestedCwd: target.cwd,
      logger,
    });
    const entry = await externalAgentRealization.ensureSession(
      realized,
      logger,
    );
    return { ok: true as const, realized, entry };
  } catch (error) {
    const failure = realizationHttpError(error);
    logger.warn(
      { threadId, code: failure.body.code, err: failure.body.message },
      '[acp/threads] canonical realization for set-RPC failed',
    );
    return { ok: false as const, ...failure };
  }
}

function resolveThreadAgentletId(threadId: string, canvasId?: string): string {
  if (canvasId) {
    const record = agenetes.record(canvasAcpNamespace(canvasId), threadId);
    const driverSpec = record?.spec.spec;
    if (
      driverSpec &&
      typeof driverSpec === 'object' &&
      typeof (driverSpec as { agentletId?: unknown }).agentletId === 'string'
    ) {
      return (driverSpec as { agentletId: string }).agentletId;
    }
  }
  return getSupervisedAgentletId();
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
    selections: entry.selections,
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
    selections: {},
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
  meta: AgentMetadata,
): AcpSessionMetaSnapshot {
  return {
    availableModes: meta.availableModes ?? [],
    currentModeId: meta.currentModeId ?? null,
    availableModels: meta.availableModels ?? [],
    currentModelId: meta.currentModelId ?? null,
    configOptions: meta.configOptions ?? [],
    selections: meta.selections ?? {},
    sessionInfo: meta.sessionInfo ?? null,
    usage: meta.usage ?? null,
    updatedAt: meta.metaUpdatedAt ?? 0,
  };
}

/**
 * Project the per-profile schema cache entry into the wire snapshot.
 * Used by `/cached-meta` when no per-thread record exists. Schema fields and
 * last-known observations (`current*`) are preserved, but the response is
 * marked `source: 'profile'`; clients must open a real session before
 * presenting those observations as active values. Per-session fields
 * (`sessionInfo`, `usage`) default to neutral values.
 *
 * `selections` stays empty for the same reason: a user choice belongs to
 * one thread and must never leak across threads of the same profile.
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
    selections: {},
    sessionInfo: null,
    usage: null,
    updatedAt: entry.metaUpdatedAt ?? 0,
  };
}

const acpThreadsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Read-only **no-spawn** meta snapshot for a thread.
   *
   * This route never contacts the agentlet. It returns cached commands and
   * selector metadata in priority order:
   *
   *   1. Live entry in `acpSessionRegistry` (some prior call already
   *      opened the session this lifetime) → freshest state.
   *   2. Per-thread Agenetes record → last known
   *      state of THIS thread (includes per-thread `current*` choices
   *      and per-session `sessionInfo` / `usage`).
   *   3. Per-profile schema cache (`profile-schema-cache`) → schema
   *      (model / mode / config option catalogues) shared across all
   *      threads of the same profile, marked `source: 'profile'` because
   *      its `current*` values belong to another thread.
   *   4. Cache miss (truly first use of this profile on this server)
   *      → empty snapshot with `updatedAt === 0`. UI treats as
   *      "neutral / no data yet", NOT a failure.
   *
   * Designed for the web's `useAcpSessionMeta` hydrate-on-mount path:
   * opening an existing thread can populate dropdowns from its own cache
   * without paying the agentlet cold-start tax. A profile-only hit is
   * observational: mode/model may be displayed as last observed, while
   * generic config values remain unconfirmed until this thread reports or
   * records an explicit selection.
   *
   * Always responds 200 — absence of cache is a normal state.
   */
  app.get<{
    Params: ThreadParams;
    Querystring: AcpThreadCachedMetaQuery;
    Reply: AcpThreadCachedMetaResponse | { message: string; code?: string };
  }>('/threads/:threadId/cached-meta', async (request, reply) => {
    const { threadId } = request.params;
    const parsed = acpThreadCachedMetaQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        message: 'Invalid query',
        code: 'validation_failed',
      });
    }
    const { canvasId, profileId } = parsed.data;
    const agentletId = resolveThreadAgentletId(threadId, canvasId);
    const live = acpSessionRegistry.get(agentletId, threadId);
    if (live) {
      return {
        source: 'thread',
        availableCommands: live.availableCommands,
        commandsUpdatedAt: live.commandsUpdatedAt,
        sessionMeta: snapshotSessionMeta(live),
      };
    }
    if (canvasId) {
      const record = agenetes.record(canvasAcpNamespace(canvasId), threadId);
      const persistedMeta = record?.state?.metadata;
      if (persistedMeta) {
        return {
          source: 'thread',
          availableCommands: persistedMeta.availableCommands ?? [],
          commandsUpdatedAt: persistedMeta.commandsUpdatedAt ?? 0,
          sessionMeta: snapshotMetaFromPersisted(persistedMeta),
        };
      }
    }
    if (profileId) {
      const profileCache = getProfileSchemaCache(profileId);
      if (
        profileCache &&
        ((profileCache.metaUpdatedAt ?? 0) > 0 ||
          (profileCache.commandsUpdatedAt ?? 0) > 0)
      ) {
        return {
          source: 'profile',
          availableCommands: profileCache.availableCommands ?? [],
          commandsUpdatedAt: profileCache.commandsUpdatedAt ?? 0,
          sessionMeta: snapshotMetaFromProfileCache(profileCache),
        };
      }
    }
    return {
      source: 'none',
      availableCommands: [],
      commandsUpdatedAt: 0,
      sessionMeta: emptySessionMetaSnapshot(),
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
    // A permission answer only ever arrives mid-turn (correlated with a
    // `permission_request` emitted during an in-flight `session/prompt`),
    // so a live handle for this thread is the precondition. `get` never
    // spawns one (I9.3): a missing handle is a dead-session 404.
    const handle = agenetes.get(threadId);
    if (!handle) {
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
    // Fold onto the long-lived handle's control plane (M3): the reverse
    // permission is a duplex correlated by `requestId` — `answer_permission`
    // control ⟂ `permission_request` event. The 404 above enforces the live
    // session precondition (L1); `control()` resolves the same entry by
    // threadId. `ok:false` here means no suspended request matched (already
    // answered / timed out / session ended) — surfaced as `resolved:false`.
    const ack = await handle.control({
      type: 'answer_permission',
      data: {
        requestId,
        decision: cancelled || !optionId ? { cancelled: true } : { optionId },
      },
    });
    return { resolved: ack.ok };
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
  // The first request realizes the complete canonical workload, ensures its
  // ACP session from that same spec, and then applies the control. Later
  // requests reuse the persisted workload.
  //
  // Failure modes:
  //   • 400 — body failed `safeParse`.
  //   • 409 — requested binding/cwd conflicts with the canonical thread.
  //   • 503 — workload realization or session creation failed.
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
    const resolved = await realizeControlThread(
      threadId,
      parsed.data,
      request.log,
    );
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }
    const ack = await resolved.realized.handle.control({
      type: 'set_mode',
      data: { modeId: parsed.data.modeId },
    });
    if (!ack.ok) {
      request.log.warn(
        { threadId, modeId: parsed.data.modeId, err: ack.error },
        '[acp/threads] setSessionMode failed',
      );
      return reply.status(controlFailureStatus(ack.code)).send({
        message: ack.error,
        code: controlFailureCode('set_mode', ack.code),
      });
    }
    return { ok: true as const, modeId: parsed.data.modeId };
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
    const resolved = await realizeControlThread(
      threadId,
      parsed.data,
      request.log,
    );
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }
    const ack = await resolved.realized.handle.control({
      type: 'set_model',
      data: { modelId: parsed.data.modelId },
    });
    if (!ack.ok) {
      request.log.warn(
        { threadId, modelId: parsed.data.modelId, err: ack.error },
        '[acp/threads] setSessionModel failed',
      );
      return reply.status(controlFailureStatus(ack.code)).send({
        message: ack.error,
        code: controlFailureCode('set_model', ack.code),
      });
    }
    rememberProfileSessionPreference(
      resolved.entry.profileId,
      'model',
      parsed.data.modelId,
    );
    return { ok: true as const, modelId: parsed.data.modelId };
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
    const resolved = await realizeControlThread(
      threadId,
      parsed.data,
      request.log,
    );
    if (!resolved.ok) {
      return reply.status(resolved.status).send(resolved.body);
    }
    const ack = await resolved.realized.handle.control({
      type: 'set_config_option',
      data: {
        optionId: parsed.data.configOptionId,
        value: parsed.data.value,
      },
    });
    if (!ack.ok) {
      request.log.warn(
        {
          threadId,
          configOptionId: parsed.data.configOptionId,
          err: ack.error,
        },
        '[acp/threads] setSessionConfigOption failed',
      );
      return reply.status(controlFailureStatus(ack.code)).send({
        message: ack.error,
        code: controlFailureCode('set_config_option', ack.code),
      });
    }
    rememberProfileConfigPreference(
      resolved.entry.profileId,
      resolved.entry.configOptions,
      parsed.data.configOptionId,
      parsed.data.value,
    );
    return {
      ok: true as const,
      configOptionId: parsed.data.configOptionId,
      value: parsed.data.value,
    };
  });
};

export default acpThreadsRoutes;
