/**
 * `GET   /api/acp/profiles`            — list profiles + daemon snapshot
 * `POST  /api/acp/profiles`            — create
 * `PATCH /api/acp/profiles/:id`        — update
 * `DELETE /api/acp/profiles/:id`       — delete (+ best-effort stop agent)
 *
 * Loopback-only on every verb. Profiles contain a fully-resolved
 * command line that the daemon will execute on this machine; allowing
 * remote writes would be a trivial RCE.
 *
 * The response shape includes a snapshot of {@link AcpDaemonStatus}
 * on the list endpoint so the UI can render the daemon health banner
 * without a second request — there is only ever one daemon per
 * Sediment instance and the two are conceptually coupled (profiles
 * are useless without a running daemon).
 */

import { randomUUID } from 'node:crypto';

import {
  acpProfileCreateRequestSchema,
  acpProfileUpdateRequestSchema,
} from '@sediment/shared';

import { getDaemonSupervisor } from './daemon-supervisor.js';
import {
  deleteProfile,
  getProfile,
  insertProfile,
  listProfiles,
  updateProfile,
} from './profile-store.js';
import { getRuntime, releaseProfile } from './spawn-orchestrator.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type {
  AcpAgentProfile,
  AcpAgentProfileWithRuntime,
  AcpProfileMutationResponse,
  AcpProfilesListResponse,
  ApiResult,
} from '@sediment/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

function withRuntime(profile: AcpAgentProfile): AcpAgentProfileWithRuntime {
  return { ...profile, runtime: getRuntime(profile.id) };
}

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
        profiles: listProfiles().map(withRuntime),
        daemon: getDaemonSupervisor().getStatus(),
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
      const now = Date.now();
      const profile: AcpAgentProfile = {
        id: randomUUID(),
        // Fall back to a deterministic label so the picker always has
        // something to show before the user edits the name.
        displayName: parsed.data.displayName ?? parsed.data.cliId,
        cliId: parsed.data.cliId,
        command: parsed.data.command,
        cwd: parsed.data.cwd,
        env: parsed.data.env,
        autoRestart: parsed.data.autoRestart ?? true,
        createdAt: now,
        updatedAt: now,
      };
      insertProfile(profile);
      return withRuntime(profile);
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
    // `null` env means "clear all env vars"; undefined means "no
    // change". Translate before handing to the store so the store
    // stays unaware of the wire convention.
    const envPatch =
      parsed.data.env === null
        ? { env: undefined }
        : parsed.data.env !== undefined
          ? { env: parsed.data.env }
          : {};
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
      ...envPatch,
      updatedAt: Date.now(),
    });
    return withRuntime(updated);
  });

  // ── Delete ──────────────────────────────────────────────────────────
  app.delete<{
    Params: { id: string };
    Reply: ApiResult<{ deleted: boolean }>;
  }>('/profiles/:id', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    // Stop any in-flight spawn before removing the record so the
    // daemon isn't left holding a process that has no profile to
    // map back to.
    await releaseProfile(request.params.id);
    const deleted = deleteProfile(request.params.id);
    if (!deleted) {
      return reply.status(404).send({
        message: `No profile with id ${request.params.id}`,
        code: 'profile_not_found',
      });
    }
    return { deleted: true };
  });
};

export default acpProfilesRoutes;
