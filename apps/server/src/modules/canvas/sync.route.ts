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

import { subscribeCanvasUpdates } from './canvas-sync.js';
import { getCanvasStore } from '../storage/index.js';

import type { CanvasSyncEvent } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

function writeSSE(raw: NodeJS.WritableStream, event: CanvasSyncEvent): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

const syncRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get<{ Params: { canvasId: string } }>(
    '/:canvasId/sync/stream',
    async (request, reply) => {
      const { canvasId } = request.params;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');

      // Baseline handshake: report the current version so the client can
      // close the "mutated before I subscribed" gap.
      const canvas = getCanvasStore(canvasId).read();
      writeSSE(reply.raw, {
        type: 'snapshot',
        data: { version: canvas?.version ?? 0 },
      });

      const unsubscribe = subscribeCanvasUpdates(canvasId, (event) => {
        writeSSE(reply.raw, event);
      });

      request.raw.on('close', () => {
        unsubscribe();
        try {
          reply.raw.end();
        } catch {
          /* already closed */
        }
      });
    },
  );
};

export default syncRoutes;
