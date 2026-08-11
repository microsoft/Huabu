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
      let closed = false;
      let bufferingHandshake = true;
      const bufferedEvents: CanvasSyncEvent[] = [];
      let unsubscribe = (): void => {};

      const closeStream = (): void => {
        if (closed) return;
        closed = true;
        request.raw.off('close', closeStream);
        unsubscribe();
        bufferedEvents.length = 0;
        try {
          reply.raw.end();
        } catch {
          /* already closed */
        }
      };

      request.raw.once('close', closeStream);

      try {
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        reply.raw.flushHeaders?.();
        reply.raw.write(': ok\n\n');
        if (closed) return;

        // Subscribe before reading the baseline. A commit can otherwise land
        // after the read but before listener registration and be invisible to
        // both the snapshot and this stream. Keep publications queued until
        // the snapshot is on the wire so an update can never precede it.
        unsubscribe = subscribeCanvasUpdates(canvasId, (event) => {
          if (closed) return;
          if (bufferingHandshake) {
            bufferedEvents.push(event);
            return;
          }
          try {
            writeSSE(reply.raw, event);
          } catch {
            closeStream();
          }
        });
        if (closed) {
          unsubscribe();
          return;
        }

        const canvas = getCanvasStore(canvasId).read();
        if (closed) return;
        writeSSE(reply.raw, {
          type: 'snapshot',
          data: { version: canvas?.version ?? 0 },
        });

        // Leave buffering enabled while draining. If a write synchronously
        // triggers another publication it is appended and stays in order.
        for (const event of bufferedEvents) {
          if (closed) return;
          writeSSE(reply.raw, event);
        }
        bufferedEvents.length = 0;
        bufferingHandshake = false;
      } catch (error) {
        closeStream();
        throw error;
      }
    },
  );
};

export default syncRoutes;
