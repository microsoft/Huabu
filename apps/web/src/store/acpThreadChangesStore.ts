import { create } from 'zustand';

import { fingerprintNode } from '@sediment/shared/canvas-engine';

import {
  acceptThreadChange,
  getThreadChanges,
  revertThreadChange,
} from '@/api/threadChanges';
import useCanvasStore from '@/store/canvasStore';

import type { CanvasChangeRecord } from '@sediment/shared/canvas-engine';

/**
 * Per-conversation (ACP thread) change-review records — the "what the
 * agent changed" card shown above the chat input.
 *
 * Records arrive two ways:
 *  - on thread open: `load()` fetches the persisted sidecar.
 *  - live: `appendFromBroadcast()` is called by `canvasSyncStore` when a
 *    thread-attributed `update` event arrives.
 *
 * Accept removes a record (server + local). Revert applies the inverse
 * deltas server-side (which broadcasts the canvas change back), then
 * removes the record.
 */

interface AcpThreadChangesState {
  byThread: Record<string, CanvasChangeRecord[]>;
  /** Fetch persisted records for a thread (replaces local list). */
  load: (canvasId: string, threadId: string) => Promise<void>;
  /** Append live records pushed via the sync broadcast. */
  appendFromBroadcast: (
    threadId: string,
    records: CanvasChangeRecord[],
  ) => void;
  /** Accept (keep) — discard the review record without touching the canvas. */
  accept: (
    canvasId: string,
    threadId: string,
    changeId: string,
  ) => Promise<void>;
  /** Accept all records for a thread. */
  acceptAll: (canvasId: string, threadId: string) => Promise<void>;
  /** Revert one change (server applies inverse deltas + broadcasts). */
  revert: (
    canvasId: string,
    threadId: string,
    changeId: string,
  ) => Promise<void>;
  /** Revert every non-stale change in a thread (reverse order). */
  revertAll: (canvasId: string, threadId: string) => Promise<void>;
  /** True when the change targets a node modified since (revert unsafe). */
  isStale: (record: CanvasChangeRecord) => boolean;
}

function removeFrom(
  byThread: Record<string, CanvasChangeRecord[]>,
  threadId: string,
  changeId: string,
): Record<string, CanvasChangeRecord[]> {
  const list = byThread[threadId];
  if (!list) return byThread;
  return { ...byThread, [threadId]: list.filter((r) => r.id !== changeId) };
}

export const useAcpThreadChangesStore = create<AcpThreadChangesState>(
  (set, get) => ({
    byThread: {},

    load: async (canvasId, threadId) => {
      try {
        const records = await getThreadChanges(canvasId, threadId);
        set((s) => ({ byThread: { ...s.byThread, [threadId]: records } }));
      } catch (err) {
        console.error('[acpThreadChanges] load failed', err);
      }
    },

    appendFromBroadcast: (threadId, records) => {
      if (records.length === 0) return;
      set((s) => {
        const existing = s.byThread[threadId] ?? [];
        // Dedupe by id in case a record arrives twice.
        const seen = new Set(existing.map((r) => r.id));
        const merged = [...existing];
        for (const r of records) if (!seen.has(r.id)) merged.push(r);
        return { byThread: { ...s.byThread, [threadId]: merged } };
      });
    },

    accept: async (canvasId, threadId, changeId) => {
      // Optimistic removal; reconcile on failure by reloading.
      set((s) => ({ byThread: removeFrom(s.byThread, threadId, changeId) }));
      try {
        await acceptThreadChange(canvasId, threadId, changeId);
      } catch (err) {
        console.error('[acpThreadChanges] accept failed', err);
        void get().load(canvasId, threadId);
      }
    },

    acceptAll: async (canvasId, threadId) => {
      const list = get().byThread[threadId] ?? [];
      set((s) => ({ byThread: { ...s.byThread, [threadId]: [] } }));
      await Promise.allSettled(
        list.map((r) => acceptThreadChange(canvasId, threadId, r.id)),
      );
    },

    revert: async (canvasId, threadId, changeId) => {
      set((s) => ({ byThread: removeFrom(s.byThread, threadId, changeId) }));
      try {
        // The canvas change itself lands via the sync broadcast that the
        // server emits while applying the inverse deltas.
        await revertThreadChange(canvasId, threadId, changeId);
      } catch (err) {
        console.error('[acpThreadChanges] revert failed', err);
        void get().load(canvasId, threadId);
      }
    },

    revertAll: async (canvasId, threadId) => {
      const list = get().byThread[threadId] ?? [];
      // Only revert non-stale changes; leave stale ones for manual review.
      const revertable = list.filter((r) => !get().isStale(r));
      if (revertable.length === 0) return;
      const revertableIds = new Set(revertable.map((r) => r.id));
      // Optimistically drop the revertable rows; keep stale ones.
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: (s.byThread[threadId] ?? []).filter(
            (r) => !revertableIds.has(r.id),
          ),
        },
      }));
      // Reverse order so dependent changes (e.g. an edge added after a
      // node) are undone before their prerequisites.
      let failed = false;
      for (let i = revertable.length - 1; i >= 0; i--) {
        try {
          await revertThreadChange(canvasId, threadId, revertable[i].id);
        } catch (err) {
          console.error('[acpThreadChanges] revertAll item failed', err);
          failed = true;
        }
      }
      if (failed) void get().load(canvasId, threadId);
    },

    isStale: (record) => {
      // Only node content changes carry a fingerprint; edge changes are
      // never considered stale (applyDeltas is fail-open for them).
      if (!record.appliedFingerprint || !record.nodeId) return false;
      const node = useCanvasStore
        .getState()
        .nodes.find((n) => n.id === record.nodeId);
      // A deleted target node can't be safely compared — treat as stale.
      if (!node) return true;
      return fingerprintNode(node) !== record.appliedFingerprint;
    },
  }),
);
