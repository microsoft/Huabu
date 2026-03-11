/**
 * @file intent.route.ts
 *
 * POST /api/intent/recognize
 * Accepts an AgentBaseContext and returns ranked intent candidates.
 */

import {
  recognizeIntent,
  resolveActions,
  logIntentEpisode,
} from './intent.service.js';

import type {
  IntentRequest,
  IntentResponse,
  IntentEpisodeRequest,
  ResolveActionsRequest,
  ResolveActionsResponse,
} from '@sediment/shared';
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

  fastify.post<{ Body: IntentEpisodeRequest }>(
    '/episode',
    async (request, reply) => {
      const { episode } = request.body;
      if (!episode?.id) {
        return reply.code(400).send({ error: 'episode is required' } as never);
      }
      logIntentEpisode(episode);
      return reply.send({ success: true });
    },
  );

  fastify.post<{ Body: ResolveActionsRequest; Reply: ResolveActionsResponse }>(
    '/resolve-actions',
    async (request, reply) => {
      const { canvasContext, chosenIntent } = request.body;

      if (!canvasContext || !chosenIntent) {
        return reply.code(400).send({
          error: 'canvasContext and chosenIntent are required',
        } as never);
      }

      const actions = await resolveActions(canvasContext, chosenIntent);

      return reply.send({ actions });
    },
  );
};

export default intentRoutes;
