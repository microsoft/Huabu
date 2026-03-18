/**
 * Intent Routes
 *
 * POST /api/intent/recognize
 * POST /api/intent/recognize-stream
 * POST /api/intent/episode
 */

import {
  recognizeIntent,
  recognizeIntentStream,
  logIntentEpisode,
} from './intent.service.js';

import type {
  IntentRequest,
  IntentResponse,
  IntentEpisodeRequest,
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

  fastify.post<{ Body: IntentRequest }>(
    '/recognize-stream',
    async (request, reply) => {
      const { canvasContext } = request.body;

      if (!canvasContext) {
        return reply
          .code(400)
          .send({ error: 'canvasContext is required' } as never);
      }

      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');

      try {
        for await (const candidate of recognizeIntentStream(canvasContext)) {
          reply.raw.write(
            `event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`,
          );
        }
        reply.raw.write('event: done\ndata: {}\n\n');
      } catch (err) {
        request.log.error(err, 'Intent streaming failed');
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ error: 'Intent recognition failed' })}\n\n`,
        );
      }

      reply.raw.end();
    },
  );

  fastify.post<{ Body: IntentEpisodeRequest }>(
    '/episode',
    async (request, reply) => {
      const { episode, canvasId } = request.body;
      if (!episode?.id) {
        return reply.code(400).send({ error: 'episode is required' } as never);
      }
      logIntentEpisode(episode, canvasId);
      return reply.send({ success: true });
    },
  );
};

export default intentRoutes;
