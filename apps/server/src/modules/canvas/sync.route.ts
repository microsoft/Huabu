// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas real-time sync SSE route.
 *
 * `GET /:canvasId/sync/stream` opens a Server-Sent Events stream. On
 * connect it emits one `snapshot` event carrying the canvas's current
 * `version` (so a client that connected after a mutation can detect the
 * gap and `loadCanvas` to catch up), then forwards every subsequent
 * `update` published by `publishCanvasUpdate`.
 *
 * Mirrors the SSE plumbing in `external.route.ts`.
 */

import {
  canvasOperationStreamQuerySchema,
  recentCanvasConversationParamsSchema,
} from '@huabu/shared';

import { subscribeCanvasUpdates } from './canvas-sync.js';
import { operationPrincipal } from './operations/routes.js';
import { streamCanvasOperations } from './operations/stream.js';
import { space } from '../storage/index.js';

import type { CanvasSyncEvent } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

function writeSSE(raw: NodeJS.WritableStream, event: CanvasSyncEvent): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

const syncRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get<{ Params: { canvasId: string } }>(
    '/:canvasId/sync/stream',
    async (request, reply) => {
      const params = recentCanvasConversationParamsSchema.safeParse(
        request.params,
      );
      if (!params.success)
        return reply.code(400).send({
          message: params.error.issues[0]?.message ?? 'Invalid canvas ID',
        });
      const { canvasId } = params.data;
      if (Object.hasOwn(request.query as object, 'protocolVersion')) {
        const query = canvasOperationStreamQuerySchema.safeParse(request.query);
        if (!query.success)
          return reply.code(400).send({
            message: 'Invalid collaboration stream protocol or cursor',
          });
        if (!operationPrincipal(request, reply)) return;
        return streamCanvasOperations(canvasId, query.data, request, reply);
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');

      const pending: CanvasSyncEvent[] = [];
      let snapshotSent = false;
      let closed = false;
      const unsubscribe = subscribeCanvasUpdates(canvasId, (event) => {
        if (closed) return;
        if (!snapshotSent) {
          pending.push(event);
          return;
        }
        writeSSE(reply.raw, event);
      });
      const heartbeat = setInterval(() => {
        reply.raw.write(': ping\n\n');
      }, 15_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      reply.raw.once('close', cleanup);

      // Subscribe before reading the baseline. Updates committed while the
      // snapshot is read are buffered and delivered after it, closing the
      // handshake race without reordering updates ahead of the snapshot.
      let canvas;
      try {
        canvas = await space(canvasId).read();
      } catch (error) {
        request.log.error(
          { err: error, canvasId },
          'Canvas sync baseline read failed',
        );
        cleanup();
        reply.raw.destroy();
        return;
      }
      if (closed) return;
      writeSSE(reply.raw, {
        type: 'snapshot',
        data: { version: canvas?.version ?? 0 },
      });
      snapshotSent = true;
      for (const event of pending) writeSSE(reply.raw, event);
      pending.length = 0;
    },
  );
};

export default syncRoutes;
