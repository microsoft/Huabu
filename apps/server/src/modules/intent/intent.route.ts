/**
 * @file intent.route.ts
 *
 * POST /api/intent/recognise
 * Accepts an AgentBaseContext and returns ranked intent candidates.
 */

import { recogniseIntent } from './intent.service.js';

import type { IntentRequest, IntentResponse } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const intentRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post<{ Body: IntentRequest; Reply: IntentResponse }>(
    '/recognise',
    async (request, reply) => {
      const { canvasContext } = request.body;

      if (!canvasContext) {
        return reply
          .code(400)
          .send({ error: 'canvasContext is required' } as never);
      }

      const intentCandidates = await recogniseIntent(canvasContext);

      return reply.send({ intentCandidates });
    },
  );
};

export default intentRoutes;
