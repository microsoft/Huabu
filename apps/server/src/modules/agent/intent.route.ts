// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Intent Routes
 *
 * POST /api/intent/recognize
 * POST /api/intent/recognize-stream
 * POST /api/intent/recognize-sketch
 * POST /api/intent/episode
 */

import {
  INTENT_SSE_EVENTS,
  sketchIntentRequestSchema,
  intentEpisodeRequestSchema,
  intentRequestSchema,
} from '@huabu/shared';

import {
  recognizeIntent,
  recognizeIntentStream,
  logIntentEpisode,
} from './intent.service.js';
import { recognizeSketchCommands } from './sketch.service.js';

import type {
  SketchCommandResponse,
  ApiResult,
  IntentEpisodeAck,
  IntentEpisodeRequest,
  IntentRequest,
  IntentResponse,
  IntentStreamEvent,
  SketchIntentRequest,
} from '@huabu/shared';
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
      const parsed = intentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: parsed.error.issues[0]?.message ?? 'Invalid body',
        });
      }

      const intentCandidates = await recognizeIntent(
        parsed.data.canvasContext,
        parsed.data.canvasId,
      );

      return reply.send({ intentCandidates });
    },
  );

  fastify.post<{ Body: IntentRequest }>(
    '/recognize-stream',
    async (request, reply) => {
      const parsed = intentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: parsed.error.issues[0]?.message ?? 'Invalid body',
        });
      }

      const { canvasContext, canvasId } = parsed.data;

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
        for await (const candidate of recognizeIntentStream(
          canvasContext,
          canvasId,
        )) {
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

  // Sketch → canvas commands (one-step, no SSE).
  // Receives screenshot + structured cluster context, asks LLM to reason
  // and return an executable batch of canvas commands.
  fastify.post<{
    Body: SketchIntentRequest;
    Reply: ApiResult<SketchCommandResponse>;
  }>('/recognize-sketch', async (request, reply) => {
    const parsed = sketchIntentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      });
    }
    const { screenshot, clusterContext, canvasId } = parsed.data;

    try {
      const result = await recognizeSketchCommands(
        screenshot,
        clusterContext,
        canvasId,
      );
      return reply.send(result);
    } catch (err) {
      request.log.error(err, 'Sketch command recognition failed');
      return reply
        .code(500)
        .send({ message: 'Sketch command recognition failed' });
    }
  });

  fastify.post<{
    Body: IntentEpisodeRequest;
    Reply: ApiResult<IntentEpisodeAck>;
  }>('/episode', async (request, reply) => {
    const parsed = intentEpisodeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      });
    }
    const { episode, canvasId } = parsed.data;
    await logIntentEpisode(episode, canvasId);
    return reply.send({ success: true });
  });
};

export default intentRoutes;
