// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Integrations routes — read/update third-party API keys (Tavily,
 * RapidAPI). Mounted under `/api/integrations`.
 *
 * `GET /config` returns the masked read model (booleans only). `PUT
 * /config` requires the owner (same guard as the LLM routes) because it
 * writes secrets to disk.
 */

import { integrationsConfigUpdateSchema } from '@huabu/shared';

import {
  getIntegrationsConfig,
  setIntegrationsConfig,
} from './integrations.js';
import { isOwnerRequest } from '../security/owner.js';

import type {
  ApiResult,
  IntegrationsConfig,
  IntegrationsConfigUpdate,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const integrationsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/integrations/config — masked status of stored keys
  app.get<{ Reply: ApiResult<IntegrationsConfig> }>('/config', async () => {
    return getIntegrationsConfig();
  });

  // PUT /api/integrations/config — save API keys (owner only)
  app.put<{
    Body: IntegrationsConfigUpdate;
    Reply: ApiResult<IntegrationsConfig>;
  }>('/config', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: integration keys require owner authorization',
      });
    }

    const parsed = integrationsConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }

    return reply.send(await setIntegrationsConfig(parsed.data));
  });
};

export default integrationsRoutes;
