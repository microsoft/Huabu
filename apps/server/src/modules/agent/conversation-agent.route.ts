// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getAgentProfileRegistry,
  getAgentletGateway,
} from '@agenetes/agentlet-host';

import {
  conversationAgentPreferenceSchema,
  HUABU_AGENT_PROFILE_ID,
} from '@huabu/shared';

import {
  getConversationAgentPreference,
  getEffectiveConversationAgentProfileId,
  setConversationAgentPreference,
} from './conversation-agent.js';
import { isOwnerRequest } from '../security/owner.js';

import type {
  ApiResult,
  ConversationAgentPreference,
  ConversationAgentPreferenceResponse,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

function projectPreference(): ConversationAgentPreferenceResponse {
  const preference = getConversationAgentPreference();
  const effectiveProfileId = getEffectiveConversationAgentProfileId();
  if (effectiveProfileId === HUABU_AGENT_PROFILE_ID) {
    return { preference, effectiveProfileId, selectionState: 'available' };
  }
  const registry = getAgentProfileRegistry();
  const profile = effectiveProfileId
    ? registry?.getProfile(effectiveProfileId)
    : undefined;
  return {
    preference,
    effectiveProfileId,
    selectionState:
      effectiveProfileId === null
        ? 'unconfigured'
        : !registry
          ? 'offline'
          : !profile
            ? 'deleted'
            : getAgentletGateway()?.getAgentlet(profile.agentletId)?.status ===
                'connected'
              ? 'available'
              : 'offline',
  };
}

const conversationAgentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message:
          'Forbidden: conversation Agent preference requires owner authorization',
      });
    }
  });

  app.get<{ Reply: ApiResult<ConversationAgentPreferenceResponse> }>(
    '/',
    { prefixTrailingSlash: 'both' },
    async () => projectPreference(),
  );

  app.put<{
    Body: ConversationAgentPreference;
    Reply: ApiResult<ConversationAgentPreferenceResponse>;
  }>('/', { prefixTrailingSlash: 'both' }, async (request, reply) => {
    const parsed = conversationAgentPreferenceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ??
          'Invalid conversation Agent preference',
        code: 'validation_failed',
      });
    }
    if (
      parsed.data.profileId !== null &&
      parsed.data.profileId !== HUABU_AGENT_PROFILE_ID
    ) {
      const registry = getAgentProfileRegistry();
      if (!registry) {
        return reply.status(503).send({
          message: 'Agent Profile registry is not ready',
          code: 'profile_registry_unavailable',
        });
      }
      if (
        !new Set(registry.listSelectableProfileIds()).has(parsed.data.profileId)
      ) {
        return reply.status(400).send({
          message: 'Select Built-In Pi or an existing external Agent Profile',
          code: 'profile_not_found',
        });
      }
    }
    setConversationAgentPreference(parsed.data);
    return projectPreference();
  });
};

export default conversationAgentRoutes;
