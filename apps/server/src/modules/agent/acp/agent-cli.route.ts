// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `GET /api/acp/agent-cli` — agentlet-local ACP harness detection.
 *
 * Powers the Agent picker in the Settings UI. The response includes the
 * complete trusted catalogue with an `installed` flag so missing agents can
 * remain visible with installation guidance. The user picks an installed
 * CLI when creating a profile; the server then
 * spawns it (via the embedded agentlet daemon) on demand. There is no
 * longer any pairing / clipboard step \u2014 the wrapper script and on-PATH
 * agentlet check were removed in the daemon-mode refactor.
 *
 * Owner-only. This adapter never probes the Huabu Server's PATH.
 */

import {
  getAgentletGateway,
  getSupervisedAgentletId,
  getAgentProfileRegistry,
} from '@agenetes/agentlet-host';
import {
  CUSTOM_COMMAND_CAPABILITIES,
  CUSTOM_COMMAND_WRAPPER_ID,
} from '@agentlet/protocol';

import { acpAgentCliQuerySchema } from '@huabu/shared';

import { isOwnerRequest } from '../../security/owner.js';

import type {
  AcpAgentCliInfo,
  AcpAgentCliListResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

async function detectAgentClis(profileId?: string): Promise<AcpAgentCliInfo[]> {
  const gateway = getAgentletGateway();
  if (!gateway) throw new Error('Agentlet Gateway is not ready');
  const profile = profileId
    ? getAgentProfileRegistry()?.getProfile(profileId)
    : undefined;
  if (profileId && !profile) throw new Error('Agent Profile is unavailable');
  const result = await gateway.discoverHarnesses(
    profile?.agentletId ?? getSupervisedAgentletId(),
    {
      prepareWorkspaces: false,
    },
  );
  if (result.harnesses.some((entry) => entry.id === CUSTOM_COMMAND_WRAPPER_ID))
    return result.harnesses;
  return [
    ...result.harnesses,
    {
      id: CUSTOM_COMMAND_WRAPPER_ID,
      displayName: 'Custom command',
      binary: CUSTOM_COMMAND_WRAPPER_ID,
      acpArgs: [],
      autoApprove: null,
      installed: false,
      installHint: '',
      capabilities: CUSTOM_COMMAND_CAPABILITIES,
    },
  ];
}

export function createAcpAgentCliRoutes(
  detect: typeof detectAgentClis = detectAgentClis,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: ApiResult<AcpAgentCliListResponse> }>(
      '/agent-cli',
      async (request, reply) => {
        if (!isOwnerRequest(request)) {
          return reply.status(403).send({
            message:
              'Forbidden: agent CLI detection requires owner authorization',
          });
        }
        const parsed = acpAgentCliQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          return reply.status(400).send({
            code: 'validation_failed',
            message: 'Invalid harness catalogue query',
          });
        }
        try {
          if (
            parsed.data.profileId &&
            !getAgentProfileRegistry()?.getProfile(parsed.data.profileId)
          ) {
            return reply.status(404).send({
              code: 'profile_not_found',
              message: 'Agent Profile is unavailable',
            });
          }
          return { agents: await detect(parsed.data.profileId) };
        } catch (error) {
          request.log.warn(
            { err: error },
            '[acp] agentlet harness detection failed',
          );
          return reply.status(503).send({
            message: 'Agentlet harness detection is unavailable',
            code: 'harness_discovery_unavailable',
          });
        }
      },
    );
  };
}

export default createAcpAgentCliRoutes();
