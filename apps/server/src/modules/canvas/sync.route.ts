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

      const pending: CanvasSyncEvent[] = [];
      let snapshotSent = false;
      const unsubscribe = subscribeCanvasUpdates(canvasId, (event) => {
        if (!snapshotSent) {
          pending.push(event);
          return;
        }
        writeSSE(reply.raw, event);
      });

      // Subscribe before reading the baseline. Updates committed while the
      // snapshot is read are buffered and delivered after it, closing the
      // handshake race without reordering updates ahead of the snapshot.
      const canvas = await space(canvasId).read();
      writeSSE(reply.raw, {
        type: 'snapshot',
        data: { version: canvas?.version ?? 0 },
      });
      snapshotSent = true;
      for (const event of pending) writeSSE(reply.raw, event);
      pending.length = 0;

      const heartbeat = setInterval(() => {
        reply.raw.write(': ping\n\n');
      }, 15_000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
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
