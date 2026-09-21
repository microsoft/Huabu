// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getAgentProfileRegistry,
  getAgentletGateway,
} from '@agenetes/agentlet-host';

import { agentDefaultsSchema, buildAcpSessionSelectors } from '@huabu/shared';

import { getProfileSchemaCache } from './acp/profile-schema-cache.js';
import { getAgentDefaults, setAgentDefaults } from './agent-defaults.js';
import { isOwnerRequest } from '../security/owner.js';

import type {
  AgentDefaults,
  AgentDefaultsResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

function projectDefaults(defaults: AgentDefaults): AgentDefaultsResponse {
  const profile = defaults.profileId
    ? getAgentProfileRegistry()?.getProfile(defaults.profileId)
    : undefined;
  const cached = profile ? getProfileSchemaCache(profile.id) : null;
  const modelSelector = cached
    ? buildAcpSessionSelectors({
        availableModes: [],
        currentModeId: null,
        availableModels: cached.availableModels ?? [],
        currentModelId: null,
        configOptions: cached.configOptions ?? [],
        selections: {},
      }).some(
        (selector) =>
          selector.category === 'model' &&
          selector.kind === 'select' &&
          selector.options.length > 0,
      )
    : false;
  return {
    defaults,
    selectionState:
      defaults.profileId === null
        ? 'unconfigured'
        : !profile
          ? 'deleted'
          : getAgentletGateway()?.getAgentlet(profile.agentletId)?.status ===
              'connected'
            ? 'available'
            : 'offline',
    // Missing observations and editable CLI labels do not prove lack of support.
    modelCapability:
      profile?.launch.kind === 'acp-command'
        ? 'unsupported'
        : modelSelector
          ? 'supported'
          : 'unknown',
  };
}

const agentDefaultsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: Agent defaults require owner authorization',
      });
    }
    if (!getAgentProfileRegistry()) {
      return reply.status(503).send({
        message: 'Agent Profile registry is not ready',
        code: 'profile_registry_unavailable',
      });
    }
  });

  app.get<{ Reply: ApiResult<AgentDefaultsResponse> }>(
    '/',
    { prefixTrailingSlash: 'both' },
    async () => projectDefaults(getAgentDefaults()),
  );

  app.put<{ Reply: ApiResult<AgentDefaultsResponse> }>(
    '/',
    { prefixTrailingSlash: 'both' },
    async (request, reply) => {
      const parsed = agentDefaultsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: parsed.error.issues[0]?.message ?? 'Invalid Agent defaults',
          code: 'validation_failed',
        });
      }
      if (
        parsed.data.profileId !== null &&
        !getAgentProfileRegistry()?.getProfile(parsed.data.profileId)
      ) {
        return reply.status(400).send({
          message: 'Select an existing external Agent Profile',
          code: 'profile_not_found',
        });
      }
      return projectDefaults(setAgentDefaults(parsed.data));
    },
  );
};

export default agentDefaultsRoutes;
