/**
 * @file intent.route.ts
 *
 * POST /api/intent/recognize
 * Accepts an AgentBaseContext and returns ranked intent candidates.
 */

import { recognizeIntent } from './intent.service.js';

import type { IntentRequest, IntentResponse } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const intentRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post<{ Body: IntentRequest; Reply: IntentResponse }>(
    '/recognize',
    async (request, reply) => {
      const { canvasContext } = request.body;

      if (!canvasContext) {
        return reply
          .code(400)
          .send({ error: 'canvasContext is required' } as never);
      }

      const intentCandidates = await recognizeIntent(canvasContext);

      return reply.send({ intentCandidates });
    },
  );
};

export default intentRoutes;
