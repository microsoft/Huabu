// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { subscribeCanvasUpdates } from '../canvas-sync.js';
import { operationFailure } from './routes.js';
import { withCanvasOperations } from './scope.js';

import type {
  CanvasOperationCommit,
  CanvasOperationStreamEvent,
  CanvasOperationStreamQuery,
} from '@huabu/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MAX_BUFFER_BYTES = 4194304;
const MAX_BUFFER_COMMITS = 200;

/** A negotiated stream never sends legacy deltas or filters out its own commits. */
export async function streamCanvasOperations(
  canvasId: string,
  query: CanvasOperationStreamQuery,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  let closed = false;
  let opened = false;
  let ready = false;
  let cursor = query.afterVersion;
  let pendingBytes = 0;
  let reviewRevision = -1;
  let pendingReviewRevision = -1;
  const pending: CanvasOperationCommit[] = [];
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    pending.length = 0;
    pendingBytes = 0;
  };
  const recover = (
    reason: Extract<
      CanvasOperationStreamEvent,
      { type: 'recovery-required' }
    >['data']['reason'],
  ) => {
    if (closed) return;
    cleanup();
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    const event: CanvasOperationStreamEvent = {
      type: 'recovery-required',
      data: { reason },
    };
    reply.raw.end(
      `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
    );
  };
  const write = (event: CanvasOperationStreamEvent) => {
    if (closed) return;
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      cleanup();
      return;
    }
    const bytes = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    if (
      reply.raw.writableLength + Buffer.byteLength(bytes) >
      MAX_BUFFER_BYTES
    ) {
      recover('buffer-overflow');
      return;
    }
    reply.raw.write(bytes);
  };
  const deliver = (commit: CanvasOperationCommit) => {
    if (closed) return;
    if (commit.spaceEpoch !== query.spaceEpoch) {
      recover('snapshot-required');
      return;
    }
    if (commit.toVersion <= cursor) return;
    if (commit.fromVersion !== cursor || commit.toVersion !== cursor + 1) {
      recover('stream-gap');
      return;
    }
    write({ type: 'commit', data: commit });
    cursor = commit.toVersion;
    if (commit.reviewRevision !== undefined)
      deliverReview(commit.reviewRevision);
  };
  const deliverReview = (revision: number) => {
    if (revision <= reviewRevision) return;
    reviewRevision = revision;
    write({
      type: 'review',
      data: { spaceEpoch: query.spaceEpoch, reviewRevision },
    });
  };
  reply.raw.once('close', cleanup);
  try {
    await withCanvasOperations(canvasId, async (operations, channel) => {
      if (closed) return;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      opened = true;
      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');
      unsubscribe = subscribeCanvasUpdates(channel, (event) => {
        if (closed) return;
        if (event.type === 'review') {
          if (event.data.spaceEpoch !== query.spaceEpoch) {
            recover('snapshot-required');
            return;
          }
          if (ready) deliverReview(event.data.reviewRevision);
          else
            pendingReviewRevision = Math.max(
              pendingReviewRevision,
              event.data.reviewRevision,
            );
          return;
        }
        if (event.type !== 'commit') return;
        if (ready) {
          deliver(event.data);
          return;
        }
        pendingBytes += Buffer.byteLength(JSON.stringify(event.data));
        if (
          pending.length >= MAX_BUFFER_COMMITS ||
          pendingBytes > MAX_BUFFER_BYTES
        ) {
          recover('buffer-overflow');
          return;
        }
        pending.push(event.data);
      });
      heartbeat = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          cleanup();
          return;
        }
        if (reply.raw.writableLength > MAX_BUFFER_BYTES - 16)
          recover('buffer-overflow');
        else if (!closed) reply.raw.write(': ping\n\n');
      }, 15000);

      const snapshot = await operations.readSnapshot();
      if (closed) return;
      if (!snapshot || snapshot.metadata.spaceEpoch !== query.spaceEpoch) {
        recover('snapshot-required');
        return;
      }
      pendingReviewRevision = Math.max(
        pendingReviewRevision,
        snapshot.metadata.reviewRevision,
      );
      let throughVersion: number | undefined;
      while (!closed) {
        const page = await operations.readCommits({
          spaceEpoch: query.spaceEpoch,
          afterVersion: cursor,
          ...(throughVersion === undefined ? {} : { throughVersion }),
          limit: MAX_BUFFER_COMMITS,
          maxBytes: MAX_BUFFER_BYTES,
        });
        if (closed) return;
        if (page.status === 'snapshot-required') {
          recover('snapshot-required');
          return;
        }
        throughVersion ??= page.throughVersion;
        if (
          page.throughVersion !== throughVersion ||
          page.spaceEpoch !== query.spaceEpoch ||
          page.fromVersion !== cursor ||
          (page.hasMore && page.commits.length === 0)
        ) {
          recover('stream-gap');
          return;
        }
        for (const commit of page.commits) deliver(commit);
        if (closed) return;
        if (
          cursor !== page.nextAfterVersion ||
          (!page.hasMore && cursor !== throughVersion)
        ) {
          recover('stream-gap');
          return;
        }
        if (!page.hasMore) break;
      }
      if (closed) return;
      for (const commit of pending) deliver(commit);
      pending.length = 0;
      pendingBytes = 0;
      if (closed) return;
      deliverReview(pendingReviewRevision);
      ready = true;
      write({
        type: 'ready',
        data: { spaceEpoch: query.spaceEpoch, version: cursor },
      });
    });
  } catch (error) {
    if (!opened) {
      cleanup();
      if (!reply.raw.destroyed) operationFailure(error, request, reply);
    } else {
      request.log.error({ err: error }, 'Operation stream recovery failed');
      recover('storage-unavailable');
    }
  }
}
