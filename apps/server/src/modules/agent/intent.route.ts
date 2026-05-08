/**
 * Intent Routes
 *
 * POST /api/intent/recognize
 * POST /api/intent/recognize-stream
 * POST /api/intent/recognize-annotation-stream
 * POST /api/intent/episode
 */

import { INTENT_SSE_EVENTS } from '@sediment/shared';

import {
  recognizeIntent,
  recognizeIntentStream,
  recognizeAnnotationCommands,
  logIntentEpisode,
} from './intent.service.js';

import type {
  AnnotationCommandResponse,
  ApiResult,
  IntentEpisodeAck,
  IntentEpisodeRequest,
  IntentRequest,
  IntentResponse,
  IntentStreamEvent,
  AnnotationIntentRequest,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

/** Write a single typed SSE frame. */
function writeIntentSSE(
  raw: NodeJS.WritableStream,
  event: IntentStreamEvent,
): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

const intentRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post<{ Body: IntentRequest; Reply: ApiResult<IntentResponse> }>(
    '/recognize',
    async (request, reply) => {
      const { canvasContext } = request.body;

      if (!canvasContext) {
        return reply.code(400).send({ message: 'canvasContext is required' });
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
        return reply.code(400).send({ message: 'canvasContext is required' });
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
          writeIntentSSE(reply.raw, {
            type: INTENT_SSE_EVENTS.Candidate,
            data: candidate,
          });
        }
        writeIntentSSE(reply.raw, {
          type: INTENT_SSE_EVENTS.Done,
          data: {},
        });
      } catch (err) {
        request.log.error(err, 'Intent streaming failed');
        writeIntentSSE(reply.raw, {
          type: INTENT_SSE_EVENTS.Error,
          data: { error: 'Intent recognition failed' },
        });
      }

      reply.raw.end();
    },
  );

  // Annotation → canvas commands (one-step, no SSE).
  // Receives screenshot + structured cluster context, asks LLM to reason
  // and return an executable batch of canvas commands.
  fastify.post<{
    Body: AnnotationIntentRequest;
    Reply: ApiResult<AnnotationCommandResponse>;
  }>('/recognize-annotation', async (request, reply) => {
    const { screenshot, clusterContext, canvasId } = request.body;

    if (!screenshot) {
      return reply.code(400).send({ message: 'screenshot is required' });
    }

    if (!clusterContext) {
      return reply.code(400).send({ message: 'clusterContext is required' });
    }

    try {
      const result = await recognizeAnnotationCommands(
        screenshot,
        clusterContext,
        canvasId,
      );
      return reply.send(result);
    } catch (err) {
      request.log.error(err, 'Annotation command recognition failed');
      return reply
        .code(500)
        .send({ message: 'Annotation command recognition failed' });
    }
  });

  fastify.post<{
    Body: IntentEpisodeRequest;
    Reply: ApiResult<IntentEpisodeAck>;
  }>('/episode', async (request, reply) => {
    const { episode, canvasId } = request.body;
    if (!episode?.id) {
      return reply.code(400).send({ message: 'episode is required' });
    }
    logIntentEpisode(episode, canvasId);
    return reply.send({ success: true });
  });
};

export default intentRoutes;
