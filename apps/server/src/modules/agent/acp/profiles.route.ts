// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `GET   /api/acp/profiles`            — list profiles + daemon snapshot
 * `POST  /api/acp/profiles`            — create
 * `PATCH /api/acp/profiles/:id`        — update
 * `DELETE /api/acp/profiles/:id`       — delete (template only — live
 *                                        threads keep running off their
 *                                        own binding-recipe snapshots)
 *
 * Owner-only on every verb. Profiles contain a fully-resolved command line
 * that the daemon will execute on this machine, so unauthenticated callers
 * must never read or mutate them.
 *
 * The response shape includes a snapshot of {@link AcpAgentletStatus}
 * on the list endpoint so the UI can render the agentlet health banner
 * without a second request — there is only ever one agentlet per
 * Huabu instance and the two are conceptually coupled (profiles
 * are useless without a running agentlet).
 *
 * Profiles are templates: once a thread is created against a profile
 * we snapshot the recipe onto the thread record and the two become
 * independent. Deleting the profile here therefore does NOT stop any
 * running agent process — each thread carries its own recipe.
 */

import {
  getAgentTeamRegistry,
  getDaemonSupervisor,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';

import {
  createAcpCommandProfileBodySchema,
  patchAgentProfileBodySchema,
} from '@huabu/shared';

import { invalidateProfileSchemaCache } from './profile-schema-cache.js';
import {
  deleteProfile as deleteLegacyProfile,
  getProfile as getLegacyProfile,
} from './profile-store.js';
import { isOwnerRequest } from '../../security/owner.js';

import type { AcpCommandProfile, AgentProfile } from '@agenetes/agentlet-host';
import type {
  AcpProfileMutationResponse,
  AcpProfilesListResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

function denyRemote(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isOwnerRequest(request)) return false;
  reply.status(403).send({
    message:
      'Forbidden: external agent profiles can only be managed from localhost',
  });
  return true;
}

function isCommandProfile(profile: AgentProfile): profile is AcpCommandProfile {
  return profile.launch.kind === 'acp-command';
}

const acpProfilesRoutes: FastifyPluginAsync = async (app) => {
  // ── List ─────────────────────────────────────────────────────────────
  app.get<{ Reply: ApiResult<AcpProfilesListResponse> }>(
    '/profiles',
    async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const registry = getAgentTeamRegistry();
      const profiles = registry?.listProfiles() ?? [];
      return {
        profiles,
        selectableProfileIds: registry?.listSelectableProfileIds() ?? [],
        agentlet: getDaemonSupervisor().getStatus(),
      };
    },
  );

  // ── Create ──────────────────────────────────────────────────────────
  app.post<{ Reply: ApiResult<AcpProfileMutationResponse> }>(
    '/profiles',
    async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = createAcpCommandProfileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Invalid profile body',
          code: 'validation_failed',
        });
      }
      const registry = getAgentTeamRegistry();
      if (!registry) {
        return reply.status(503).send({
          message: 'Agent Profile registry is not ready',
          code: 'profile_registry_unavailable',
        });
      }
      const created = registry.createProfile({
        launchKind: 'acp-command',
        alias: parsed.data.alias,
        agentletId: getSupervisedAgentletId(),
        command: parsed.data.launch.command,
        workingDirPath: parsed.data.workingDirPath,
        ...(parsed.data.metadata && { metadata: parsed.data.metadata }),
        ...(parsed.data.customData === undefined
          ? {}
          : { customData: parsed.data.customData }),
      });
      if (!isCommandProfile(created)) {
        throw new Error('Agent Profile registry returned an invalid kind');
      }
      return created;
    },
  );

  // ── Update ──────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Reply: ApiResult<AcpProfileMutationResponse>;
  }>('/profiles/:id', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const parsed = patchAgentProfileBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: 'Invalid profile patch body',
        code: 'validation_failed',
      });
    }
    const registry = getAgentTeamRegistry();
    const existing = registry?.getProfile(request.params.id);
    if (!existing) {
      const legacy = getLegacyProfile(request.params.id);
      if (legacy?.cliId === 'agent-team') {
        return reply.status(409).send({
          message:
            'Recreate legacy Agent Team profiles from Agent Team Settings',
          code: 'legacy_agent_team_profile',
        });
      }
      return reply.status(404).send({
        message: `No profile with id ${request.params.id}`,
        code: 'profile_not_found',
      });
    }
    if (!isCommandProfile(existing)) {
      return reply.status(409).send({
        message: 'Manage manifest Profiles from Agent Team Settings',
        code: 'invalid_profile_kind',
      });
    }
    if (!registry) {
      throw new Error('Agent Profile registry became unavailable');
    }
    const updated = registry.patchProfile(request.params.id, {
      ...(parsed.data.alias === undefined ? {} : { alias: parsed.data.alias }),
      ...(parsed.data.customData === undefined
        ? {}
        : { customData: parsed.data.customData }),
      ...(parsed.data.metadata === undefined
        ? {}
        : { metadata: parsed.data.metadata }),
    });
    if (!isCommandProfile(updated)) {
      throw new Error('Agent Profile registry returned an invalid kind');
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
    const registry = getAgentTeamRegistry();
    const deleted =
      (registry?.deleteProfile(request.params.id) ?? false) ||
      deleteLegacyProfile(request.params.id);
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
