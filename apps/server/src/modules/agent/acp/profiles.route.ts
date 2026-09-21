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
 * The list includes the supervised agentlet's health snapshot. Profiles
 * retain their own explicit machine identity.
 *
 * Profiles are templates: once a thread is created against a profile
 * we snapshot the recipe onto the thread record and the two become
 * independent. Deleting the profile here therefore does NOT stop any
 * running agent process — each thread carries its own recipe.
 */

import {
  getAgentProfileRegistry,
  getAgentletGateway,
  getDaemonSupervisor,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';

import {
  agentProfileParamsSchema,
  createAcpProfileBodySchema,
  patchAgentProfileBodySchema,
} from '@huabu/shared';

import {
  hasDiscoverySource,
  mergeProfileCustomData,
} from './harness-profile-discovery.js';
import { invalidateProfileSchemaCache } from './profile-schema-cache.js';
import { isOwnerRequest } from '../../security/owner.js';
import {
  getAgentDefaults,
  initializeAgentDefaults,
} from '../agent-defaults.js';

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

const acpProfilesRoutes: FastifyPluginAsync = async (app) => {
  // ── List ─────────────────────────────────────────────────────────────
  app.get<{ Reply: ApiResult<AcpProfilesListResponse> }>(
    '/profiles',
    async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const registry = getAgentProfileRegistry();
      if (!registry) {
        return reply.status(503).send({
          message: 'Agent Profile registry is not ready',
          code: 'profile_registry_unavailable',
        });
      }
      return {
        profiles: registry.listProfiles(),
        selectableProfileIds: registry.listSelectableProfileIds(),
        agentlet: getDaemonSupervisor().getStatus(),
        agentDefaults: getAgentDefaults(),
      };
    },
  );

  // ── Create ──────────────────────────────────────────────────────────
  app.post<{ Reply: ApiResult<AcpProfileMutationResponse> }>(
    '/profiles',
    async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = createAcpProfileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Invalid profile body',
          code: 'validation_failed',
        });
      }
      if (hasDiscoverySource(parsed.data.customData)) {
        return reply.status(400).send({
          message: 'Automatic Profile source is reserved',
          code: 'invalid_profile_source',
        });
      }
      const registry = getAgentProfileRegistry();
      if (!registry) {
        return reply.status(503).send({
          message: 'Agent Profile registry is not ready',
          code: 'profile_registry_unavailable',
        });
      }
      const agentletId = getSupervisedAgentletId();
      const launch = parsed.data.launch;
      if (launch.kind === 'acp-harness') {
        try {
          const gateway = getAgentletGateway();
          if (!gateway) throw new Error('Agentlet Gateway is not ready');
          const result = await gateway.discoverHarnesses(agentletId, {
            prepareWorkspaces: false,
          });
          const harness = result.harnesses.find(
            (entry) => entry.id === launch.harnessId,
          );
          if (!harness?.installed || harness.launchVersion !== 1) {
            return reply.status(409).send({
              code: 'harness_launch_unavailable',
              message:
                'The selected Agentlet cannot launch this structured harness Profile.',
            });
          }
          if (launch.options?.autoApprove && !harness.autoApprove) {
            return reply.status(400).send({
              code: 'harness_option_unsupported',
              message:
                'This harness does not support an auto-approval launch option.',
            });
          }
        } catch (error) {
          request.log.warn(
            { err: error, agentletId },
            'Harness launch validation failed',
          );
          return reply.status(503).send({
            code: 'harness_discovery_unavailable',
            message: 'Agentlet harness detection is unavailable.',
          });
        }
      }
      const common = {
        alias: parsed.data.alias,
        agentletId,
        workingDirPath: parsed.data.workingDirPath,
        ...(parsed.data.metadata && { metadata: parsed.data.metadata }),
        ...(parsed.data.customData === undefined
          ? {}
          : { customData: parsed.data.customData }),
      };
      const created = registry.createProfile(
        launch.kind === 'acp-command'
          ? { ...common, launchKind: 'acp-command', command: launch.command }
          : {
              ...common,
              launchKind: 'acp-harness',
              harnessId: launch.harnessId,
              options: launch.options,
            },
      );
      initializeAgentDefaults(registry.listProfiles());
      return created;
    },
  );

  // ── Update ──────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Reply: ApiResult<AcpProfileMutationResponse>;
  }>('/profiles/:id', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const params = agentProfileParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        message: 'Invalid Profile id',
        code: 'validation_failed',
      });
    }
    const parsed = patchAgentProfileBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: 'Invalid profile patch body',
        code: 'validation_failed',
      });
    }
    const registry = getAgentProfileRegistry();
    if (!registry) {
      return reply.status(503).send({
        message: 'Agent Profile registry is not ready',
        code: 'profile_registry_unavailable',
      });
    }
    const existing = registry.getProfile(params.data.id);
    if (!existing) {
      return reply.status(404).send({
        message: `No profile with id ${params.data.id}`,
        code: 'profile_not_found',
      });
    }
    let customData = parsed.data.customData;
    if (customData !== undefined) {
      try {
        customData = mergeProfileCustomData(existing, customData);
      } catch (error) {
        request.log.warn(
          { err: error, profileId: existing.id },
          'Invalid Profile source update',
        );
        return reply.status(400).send({
          message: 'Automatic Profile source cannot be changed',
          code: 'invalid_profile_source',
        });
      }
    }
    const updated = registry.patchProfile(params.data.id, {
      ...(parsed.data.alias === undefined ? {} : { alias: parsed.data.alias }),
      ...(customData === undefined ? {} : { customData }),
      ...(parsed.data.metadata === undefined
        ? {}
        : { metadata: parsed.data.metadata }),
    });
    return updated;
  });

  // ── Delete ──────────────────────────────────────────────────────────
  app.delete<{
    Params: { id: string };
    Reply: ApiResult<{ deleted: boolean }>;
  }>('/profiles/:id', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const params = agentProfileParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        message: 'Invalid Profile id',
        code: 'validation_failed',
      });
    }
    // Profile is a template only — threads created against it have
    // already snapshotted the recipe and continue running their own
    // CLI processes. Nothing to stop here.
    const registry = getAgentProfileRegistry();
    if (!registry) {
      return reply.status(503).send({
        message: 'Agent Profile registry is not ready',
        code: 'profile_registry_unavailable',
      });
    }
    const deleted = registry.deleteProfile(params.data.id);
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
