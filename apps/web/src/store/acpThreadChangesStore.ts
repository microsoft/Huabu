// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { isChangeStale } from '@huabu/shared/canvas-engine';

import {
  acceptThreadChange,
  getThreadChanges,
  querySpaceChanges,
  revertThreadChange,
} from '@/api/threadChanges';
import useCanvasStore from '@/store/canvasStore';

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';
export { isChangeStale };

/**
 * Per-conversation (ACP thread) change-review records — the "what the
 * agent changed" card shown above the chat input.
 *
 * Records arrive two ways:
 *  - on thread open: `load()` fetches the persisted (coalesced) sidecar.
 *  - live: `replaceFromBroadcast()` is called by `canvasSyncStore` when a
 *    thread-attributed `update` event arrives — the server broadcasts the
 *    thread's FULL coalesced list, so this replaces the local list.
 *
 * Accept removes a record (server + local). Revert applies the inverse
 * deltas server-side (which broadcasts the canvas change back), then
 * removes the record.
 */

interface AcpThreadChangesState {
  byThread: Record<string, CanvasChangeRecord[]>;
  /**
   * Node ids per thread whose incoming agent write was SKIPPED because
   * the user was mid-editing them. The matching
   * change row is rendered as a conflict ("skipped — you were editing")
   * instead of a normal applied change.
   */
  conflictedByThread: Record<string, string[]>;
  /**
   * Threads told of by a broadcast while this page was open, each with the
   * turn of its latest broadcast: a higher number spoke later. What they
   * hold may have just happened, unlike what a page finds when it opens.
   */
  liveThreads: Record<string, number>;
  /** Fetch persisted records for a thread (replaces local list). */
  load: (canvasId: string, threadId: string) => Promise<void>;
  /**
   * Fetch the records of a Space's conversations in one request, for the
   * marks on what Agents changed. A thread this page already holds — opened,
   * or told of by a broadcast meanwhile — keeps what it has. Resolves to
   * whether the records were read, so a caller can ask again.
   */
  loadSpace: (
    canvasId: string,
    threadIds: readonly string[],
  ) => Promise<boolean>;
  /** Replace a thread's list with the coalesced set pushed via broadcast. */
  replaceFromBroadcast: (
    threadId: string,
    records: CanvasChangeRecord[],
    skippedNodeIds?: string[],
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

/** As many threads as one Space query names; the route refuses more. */
const SPACE_QUERY_BATCH = 500;

const loadGenerationByThread = new Map<string, number>();

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
    conflictedByThread: {},
    liveThreads: {},

    load: async (canvasId, threadId) => {
      const key = `${canvasId}\0${threadId}`;
      const generation = (loadGenerationByThread.get(key) ?? 0) + 1;
      loadGenerationByThread.set(key, generation);
      try {
        const records = await getThreadChanges(canvasId, threadId);
        if (loadGenerationByThread.get(key) !== generation) return;
        set((s) => {
          // Preserve in-session conflict flags across a reload so opening
          // the conversation (which triggers this load) still shows the
          // "skipped" annotation. Prune only ids no longer represented in
          // the freshly-loaded records. A real page refresh starts with an
          // empty store, so nothing is preserved then — the conflict
          // notice is intentionally session-scoped.
          const recordNodeIds = new Set(
            records.map((r) => r.nodeId).filter((id): id is string => !!id),
          );
          const conflicted = (s.conflictedByThread[threadId] ?? []).filter(
            (id) => recordNodeIds.has(id),
          );
          return {
            byThread: { ...s.byThread, [threadId]: records },
            conflictedByThread: {
              ...s.conflictedByThread,
              [threadId]: conflicted,
            },
          };
        });
      } catch (err) {
        console.error('[acpThreadChanges] load failed', err);
      }
    },

    loadSpace: async (canvasId, threadIds) => {
      try {
        // The route takes a bounded list; a Space may hold more.
        for (let at = 0; at < threadIds.length; at += SPACE_QUERY_BATCH) {
          const threads = await querySpaceChanges(
            canvasId,
            threadIds.slice(at, at + SPACE_QUERY_BATCH),
          );
          if (useCanvasStore.getState().canvasId !== canvasId) return true;
          set((s) => ({ byThread: { ...threads, ...s.byThread } }));
        }
        return true;
      } catch (err) {
        console.error('[acpThreadChanges] Space load failed', err);
        return false;
      }
    },

    replaceFromBroadcast: (threadId, records, skippedNodeIds = []) => {
      // The broadcast carries the thread's full coalesced list (one net
      // record per entity), so replace rather than append — this also
      // drops rows whose net effect became nothing (e.g. create+delete).
      // Only keep conflict flags for nodes actually represented in this
      // batch's records so a stale id can't linger.
      const recordNodeIds = new Set(
        records.map((r) => r.nodeId).filter((id): id is string => !!id),
      );
      const conflicted = Array.from(
        new Set(skippedNodeIds.filter((id) => recordNodeIds.has(id))),
      );
      // What a broadcast says is newer than any read still in flight for
      // this thread; that read's answer must not replace it.
      const key = `${useCanvasStore.getState().canvasId}\0${threadId}`;
      loadGenerationByThread.set(
        key,
        (loadGenerationByThread.get(key) ?? 0) + 1,
      );
      set((s) => ({
        byThread: { ...s.byThread, [threadId]: records },
        conflictedByThread: {
          ...s.conflictedByThread,
          [threadId]: conflicted,
        },
        liveThreads: {
          ...s.liveThreads,
          [threadId]: Math.max(0, ...Object.values(s.liveThreads)) + 1,
        },
      }));
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
      const { nodes, edges } = useCanvasStore.getState();
      return isChangeStale(record, nodes, edges);
    },
  }),
);
