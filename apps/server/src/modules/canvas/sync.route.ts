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
 * The same stream carries `presence` events (see `canvas-presence.ts`). A
 * page that opens it with `?pageId=` is not sent its own presence, and that
 * page's presence is dropped when its last stream closes.
 *
 * Mirrors the SSE plumbing in `external.route.ts`.
 */

import {
  canvasSyncStreamQuerySchema,
  recentCanvasConversationParamsSchema,
} from '@huabu/shared';

import { canvasPresence } from './canvas-presence.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import { presenceSpaceKey } from './presence.route.js';
import { space } from '../storage/index.js';

import type { CanvasPresenceEvent, CanvasSyncEvent } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

/** Pointer positions are skipped for a stream this far behind; the next one supersedes them. */
const POINTER_BACKLOG_BYTES = 256 * 1024;

function writeSSE(
  raw: NodeJS.WritableStream,
  event: CanvasSyncEvent | CanvasPresenceEvent,
): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

const syncRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get<{ Params: { canvasId: string }; Querystring: unknown }>(
    '/:canvasId/sync/stream',
    async (request, reply) => {
      const params = recentCanvasConversationParamsSchema.safeParse(
        request.params,
      );
      if (!params.success)
        return reply.code(400).send({
          message: params.error.issues[0]?.message ?? 'Invalid canvas ID',
        });
      const query = canvasSyncStreamQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply.code(400).send({
          message: query.error.issues[0]?.message ?? 'Invalid page ID',
        });
      const { canvasId } = params.data;
      const { pageId } = query.data;
      const presenceKey = presenceSpaceKey(canvasId);
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
      // Presence is independent of the Space version, so it is not held back
      // for the baseline: subscribe, then send who is already here.
      const unsubscribePresence = canvasPresence.subscribe(
        presenceKey,
        pageId,
        (data) => {
          if (closed) return;
          if (
            data.op === 'pointer' &&
            reply.raw.writableLength > POINTER_BACKLOG_BYTES
          )
            return;
          writeSSE(reply.raw, { type: 'presence', data });
        },
      );
      writeSSE(reply.raw, {
        type: 'presence',
        data: {
          op: 'snapshot',
          pages: canvasPresence.snapshot(presenceKey, pageId),
        },
      });
      const heartbeat = setInterval(() => {
        reply.raw.write(': ping\n\n');
      }, 15_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribePresence();
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
