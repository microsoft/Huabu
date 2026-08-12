// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * In-memory accumulating buffer for canvas action-log events.
 *
 * Unlike the structure / per-node-content / preprocess subsystems
 * this is NOT a debounced queue — it accumulates every event the UI
 * produces and is drained by *external* triggers:
 *
 *   1. Autosave piggy-back — `saveCanvas` calls {@link CanvasEventBuffer.flush}
 *      after a successful PUT so events ride the 1s structure cadence.
 *   2. Pre-agent flush     — exposed as the store action
 *      `flushCanvasEvents` so agent requests see the latest log.
 *   3. Page unload         — the `beforeunload` listener fires
 *      {@link CanvasEventBuffer.flushAllKeepalive}.
 *
 * Per-batch caps mirror the server (200 events; 64 KB body cap
 * enforced server-side via Fastify's `bodyLimit`).
 */

import { postCanvasEvents } from '@/api';

import type { CanvasEventInput, RecentAction } from '@huabu/shared';

const EVENT_BATCH_MAX = 200;

/**
 * Public shape returned by {@link createCanvasEventBuffer}.
 */
export type CanvasEventBuffer = {
  /** Append one event to the buffer for `canvasId`. No-op on empty id. */
  buffer(canvasId: string, action: RecentAction): void;

  /** Append many events to the buffer for `canvasId`. No-op on empty list. */
  bufferMany(canvasId: string, actions: RecentAction[]): void;

  /**
   * Drain up to {@link EVENT_BATCH_MAX} events for `canvasId` and POST
   * them. On failure the batch is re-prepended (preserving order) so
   * the next flush retries — favours duplicate-on-double-write over
   * silent loss.
   */
  flush(canvasId: string, opts?: { keepalive?: boolean }): Promise<void>;

  /**
   * Best-effort drain of *every* canvas's buffer with `keepalive: true`.
   * Used by the unload listener. Fire-and-forget; errors are swallowed.
   */
  flushAllKeepalive(): void;
};

/**
 * Build a {@link CanvasEventBuffer}. No external dependencies beyond
 * the API client; safe to instantiate at module load.
 */
export function createCanvasEventBuffer(): CanvasEventBuffer {
  const buffer = new Map<string, CanvasEventInput[]>();

  async function flush(
    canvasId: string,
    opts?: { keepalive?: boolean },
  ): Promise<void> {
    if (!canvasId) return;
    const queued = buffer.get(canvasId);
    if (!queued || queued.length === 0) return;

    // Take at most EVENT_BATCH_MAX off the front; leave the rest for
    // the next flush. Keeps each request under both server-side caps.
    const batch = queued.slice(0, EVENT_BATCH_MAX);
    const remainder = queued.slice(batch.length);
    if (remainder.length > 0) {
      buffer.set(canvasId, remainder);
    } else {
      buffer.delete(canvasId);
    }

    try {
      await postCanvasEvents(canvasId, batch, { keepalive: opts?.keepalive });
    } catch (error) {
      // Restore the failed batch so the next flush retries it. We push
      // it back to the *front* to preserve the original ordering.
      const current = buffer.get(canvasId) ?? [];
      buffer.set(canvasId, [...batch, ...current]);

      console.warn('[canvas-events] flush failed, will retry:', error);
    }
  }

  return {
    buffer(canvasId, action) {
      if (!canvasId) return;
      const list = buffer.get(canvasId) ?? [];
      list.push({ ts: Date.now(), payload: action });
      buffer.set(canvasId, list);
    },

    bufferMany(canvasId, actions) {
      if (!canvasId || actions.length === 0) return;
      const list = buffer.get(canvasId) ?? [];
      const now = Date.now();
      for (const action of actions) list.push({ ts: now, payload: action });
      buffer.set(canvasId, list);
    },

    flush,

    flushAllKeepalive() {
      for (const canvasId of Array.from(buffer.keys())) {
        void flush(canvasId, { keepalive: true });
      }
    },
  };
}
