/**
 * `GET   /api/acp/profiles`            — list profiles + daemon snapshot
 * `POST  /api/acp/profiles`            — create
 * `PATCH /api/acp/profiles/:id`        — update
 * `DELETE /api/acp/profiles/:id`       — delete (template only — live
 *                                        threads keep running off their
 *                                        own binding-recipe snapshots)
 *
 * Loopback-only on every verb. Profiles contain a fully-resolved
 * command line that the daemon will execute on this machine; allowing
 * remote writes would be a trivial RCE.
 *
 * The response shape includes a snapshot of {@link AcpAgentletStatus}
 * on the list endpoint so the UI can render the agentlet health banner
 * without a second request — there is only ever one agentlet per
 * Sediment instance and the two are conceptually coupled (profiles
 * are useless without a running agentlet).
 *
 * Profiles are templates: once a thread is created against a profile
 * we snapshot the recipe onto the thread record and the two become
 * independent. Deleting the profile here therefore does NOT stop any
 * running agent process — each thread carries its own recipe.
 */

import { randomUUID } from 'node:crypto';

import { getDaemonSupervisor } from '@agenetes/agentlet-host';

import {
  acpProfileCreateRequestSchema,
  acpProfileUpdateRequestSchema,
} from '@sediment/shared';

import { invalidateProfileSchemaCache } from './profile-schema-cache.js';
import {
  deleteProfile,
  getProfile,
  insertProfile,
  listProfiles,
  updateProfile,
} from './profile-store.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type {
  AcpAgentProfile,
  AcpProfileMutationResponse,
  AcpProfilesListResponse,
  ApiResult,
} from '@sediment/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

function denyRemote(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isLoopbackRequest(request)) return false;
  reply.status(403).send({
    message:
      'Forbidden: external agent profiles can only be managed from localhost',
  });
  return true;
}

const acpProfilesRoutes: FastifyPluginAsync = async (app) => {
  // ── List ─────────────────────────────────────────────────────────────
  app.get<{ Reply: ApiResult<AcpProfilesListResponse> }>(
    '/profiles',
    async (request, reply) => {
      if (denyRemote(request, reply)) return;
      return {
        profiles: listProfiles(),
        agentlet: getDaemonSupervisor().getStatus(),
      };
    },
  );

  // ── Create ──────────────────────────────────────────────────────────
  app.post<{ Reply: ApiResult<AcpProfileMutationResponse> }>(
    '/profiles',
    async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = acpProfileCreateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Invalid profile body',
          code: 'validation_failed',
        });
      }
      // Validate: either command+cwd or agentTeam must be provided
      const isAgentTeam = parsed.data.cliId === 'agent-team';
      if (isAgentTeam && !parsed.data.agentTeam?.agentDir) {
        return reply.status(400).send({
          message: 'agentTeam.agentDir is required for agent-team profiles',
          code: 'validation_failed',
        });
      }
      if (!isAgentTeam && (!parsed.data.command || !parsed.data.cwd)) {
        return reply.status(400).send({
          message: 'command and cwd are required for non-agent-team profiles',
          code: 'validation_failed',
        });
      }
      const now = Date.now();
      const profile: AcpAgentProfile = {
        id: randomUUID(),
        // Fall back to a deterministic label so the picker always has
        // something to show before the user edits the name.
        displayName: parsed.data.displayName ?? parsed.data.cliId,
        cliId: parsed.data.cliId,
        command: parsed.data.command,
        cwd: parsed.data.cwd,
        autoRestart: parsed.data.autoRestart ?? true,
        ...(parsed.data.agentTeam && { agentTeam: parsed.data.agentTeam }),
        createdAt: now,
        updatedAt: now,
      };
      insertProfile(profile);
      return profile;
    },
  );

  // ── Update ──────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Reply: ApiResult<AcpProfileMutationResponse>;
  }>('/profiles/:id', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const parsed = acpProfileUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: 'Invalid profile patch body',
        code: 'validation_failed',
      });
    }
    const existing = getProfile(request.params.id);
    if (!existing) {
      return reply.status(404).send({
        message: `No profile with id ${request.params.id}`,
        code: 'profile_not_found',
      });
    }
    const updated = updateProfile(request.params.id, {
      ...(parsed.data.displayName !== undefined && {
        displayName: parsed.data.displayName,
      }),
      ...(parsed.data.command !== undefined && {
        command: parsed.data.command,
      }),
      ...(parsed.data.cwd !== undefined && { cwd: parsed.data.cwd }),
      ...(parsed.data.autoRestart !== undefined && {
        autoRestart: parsed.data.autoRestart,
      }),
      ...(parsed.data.agentTeam !== undefined && {
        agentTeam: parsed.data.agentTeam,
      }),
      updatedAt: Date.now(),
    });
    // Binding-relevant edits (`command` / `cwd`) can shift the agent's
    // reported model / mode / config schema, so the per-profile schema
    // cache must be dropped — the next session of this profile will
    // repopulate it from the live agent. Pure cosmetic edits
    // (`displayName`, `autoRestart`) leave the cache untouched so the
    // toolbar stays optimistically populated.
    const commandChanged =
      parsed.data.command !== undefined &&
      parsed.data.command !== existing.command;
    const cwdChanged =
      parsed.data.cwd !== undefined && parsed.data.cwd !== existing.cwd;
    if (commandChanged || cwdChanged) {
      invalidateProfileSchemaCache(updated.id);
    }
    return updated;
  });

  // ── Delete ──────────────────────────────────────────────────────────
  app.delete<{
    Params: { id: string };
    Reply: ApiResult<{ deleted: boolean }>;
  }>('/profiles/:id', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    // Profile is a template only — threads created against it have
    // already snapshotted the recipe and continue running their own
    // CLI processes. Nothing to stop here.
    const deleted = deleteProfile(request.params.id);
    if (!deleted) {
      return reply.status(404).send({
        message: `No profile with id ${request.params.id}`,
        code: 'profile_not_found',
      });
    }
    // Drop the per-profile schema cache too so the deleted profile
    // does not leave an orphan entry that could be resurrected if a
    // future create somehow reused the same id.
    invalidateProfileSchemaCache(request.params.id);
    return { deleted: true };
  });
};

export default acpProfilesRoutes;
