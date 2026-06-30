import { create } from 'zustand';

import { readTypedSSEStream } from '@/api/_sse';
import { canvasSyncStreamUrl } from '@/api/canvasSync';
import useCanvasStore from '@/store/canvasStore';

import type { CanvasSyncEvent } from '@sediment/shared';
import type { Delta } from '@sediment/shared/canvas-engine';
import type { Node } from '@xyflow/react';

/**
 * Canvas real-time sync store.
 *
 * Subscribes to `GET /api/canvas/:canvasId/sync/stream` and replays
 * server-authored canvas mutations into `canvasStore` so out-of-band
 * writers (e.g. an ACP agent via the reachback `/execute` route) auto-
 * refresh the live canvas without a manual reload.
 *
 * Reconciliation:
 *  - `snapshot` (on connect): if the server version differs from local,
 *    a mutation happened before we subscribed → `loadCanvas` to catch up.
 *  - `update`: if `fromVersion === local version` replay the deltas via
 *    `applyDeltasFromAgent`; if we are behind (`toVersion > local`) fall
 *    back to `loadCanvas`; older/stale updates are ignored.
 *
 * Received updates intentionally do NOT trigger preprocessing — that
 * stays with the originating side (the server, for headless `/execute`).
 */

interface CanvasSyncState {
  canvasId: string | null;
  connect: (canvasId: string) => void;
  disconnect: () => void;
}

let abortController: AbortController | null = null;

type SyncPendingEffects = {
  mutatedNodes: Node[];
  deletedNodeIds: string[];
  contentEditedNodeIds: string[];
  deferredFitFrameIds: string[];
};

export const useCanvasSyncStore = create<CanvasSyncState>((set, get) => ({
  canvasId: null,

  connect: (canvasId) => {
    if (get().canvasId === canvasId && abortController) return;
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    set({ canvasId });

    void (async () => {
      try {
        const response = await fetch(canvasSyncStreamUrl(canvasId), { signal });
        if (!response.ok) return;
        await readTypedSSEStream<CanvasSyncEvent>(
          response,
          (event) => {
            // Ignore late frames after a canvas switch / disconnect.
            if (get().canvasId !== canvasId) return;
            const canvasStore = useCanvasStore.getState();
            if (canvasStore.canvasId !== canvasId) return;

            if (event.type === 'snapshot') {
              if (event.data.version !== canvasStore.version) {
                void canvasStore.loadCanvas(canvasId);
              }
              return;
            }

            // event.type === 'update'
            const { fromVersion, toVersion, deltas, pendingEffects } =
              event.data;
            if (fromVersion === canvasStore.version) {
              canvasStore.applyDeltasFromAgent(
                deltas as Delta[],
                toVersion,
                pendingEffects as SyncPendingEffects,
              );
            } else if (toVersion > canvasStore.version) {
              // Gap (missed an earlier update) → full catch-up.
              void canvasStore.loadCanvas(canvasId);
            }
            // else: stale/older update — ignore.
          },
          signal,
        );
      } catch {
        /* aborted or network error — ignore */
      }
    })();
  },

  disconnect: () => {
    abortController?.abort();
    abortController = null;
    set({ canvasId: null });
  },
}));
