// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { fingerprintNodeFields } from '@huabu/shared/canvas-engine';

import {
  acceptThreadChange,
  getThreadChanges,
  revertThreadChange,
} from '@/api/threadChanges';
import useCanvasStore from '@/store/canvasStore';

import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';
import type { Node, Edge } from '@xyflow/react';

/**
 * Pure revertability check for a single change against a canvas snapshot.
 *
 * Decided entirely by the change's inverse delta vs the CURRENT nodes /
 * edges — no "content vs system field" classification:
 *   • structural changes (create/delete/connect/disconnect/edge-update)
 *     are existence-based: the revert is meaningful only while its target
 *     is still in the state the agent left it.
 *   • an update compares ONLY the fields the agent actually changed
 *     (`fingerprintKeys`); fields the agent didn't touch can't conflict
 *     with reverting the agent's edit.
 *
 * Exported (not just the store method) so React components can call it
 * with reactively-subscribed `nodes` / `edges` and re-render when the
 * canvas changes — the store method reads a snapshot imperatively and
 * would not by itself trigger a re-render.
 */
export function isChangeStale(
  record: CanvasChangeRecord,
  nodes: readonly Node[],
  edges: readonly Edge[],
): boolean {
  const rd = record.revertDeltas[0];
  if (!rd) return false;
  const hasNode = (id: string) => nodes.some((n) => n.id === id);
  const hasEdge = (id: string) => edges.some((e) => e.id === id);
  switch (rd.type) {
    // Revert of CREATE deletes the node → stale once it's gone, OR once
    // its authored body (content / src) has been edited since (deleting
    // it would then wipe the user's newer edit).
    case 'DELETE_NODE': {
      const cur = nodes.find((n) => n.id === rd.node.id);
      if (!cur) return true;
      const keys = record.fingerprintKeys ?? [];
      if (keys.length === 0) return false;
      return fingerprintNodeFields(cur, keys) !== record.appliedFingerprint;
    }
    // Revert of DELETE reinserts the node → only meaningful while absent.
    case 'INSERT_NODE':
      return hasNode(rd.node.id);
    // Revert of an UPDATE restores the pre-agent node. `rd.prev` is the
    // agent's applied state; stale iff the node is gone OR one of the
    // fields this edit changed was modified again since.
    case 'REPLACE_NODE': {
      const cur = nodes.find((n) => n.id === rd.prev.id);
      if (!cur) return true;
      const keys = record.fingerprintKeys ?? [];
      if (keys.length === 0) return false;
      return fingerprintNodeFields(cur, keys) !== record.appliedFingerprint;
    }
    // Revert of CONNECT deletes the edge → only meaningful while it exists.
    case 'DELETE_EDGE':
      return !hasEdge(rd.edge.id);
    // Revert of DISCONNECT reinserts the edge → only meaningful while absent.
    case 'INSERT_EDGE':
      return hasEdge(rd.edge.id);
    // Revert of an edge-update restores the prior edge → needs it present.
    case 'REPLACE_EDGE':
      return !hasEdge(rd.prev.id);
    default:
      return false;
  }
}

/**
 * Per-conversation (ACP thread) change-review records — the "what the
 * agent changed" card shown above the chat input.
 *
 * Records arrive two ways:
 *  - on thread open: `load()` fetches the persisted (coalesced) sidecar.
 *  - live: Phase 4 broadcasts a bounded invalidation and
 *    `refreshFromBroadcast()` reloads the dedicated endpoint. The legacy
 *    `replaceFromBroadcast()` path remains for rolling-upgrade servers that
 *    still put the full list on SSE.
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
  /** Fetch persisted records for a thread (replaces local list). */
  load: (canvasId: string, threadId: string) => Promise<void>;
  /** Replace a thread's list with the coalesced set pushed via broadcast. */
  replaceFromBroadcast: (
    threadId: string,
    records: CanvasChangeRecord[],
    skippedNodeIds?: string[],
  ) => void;
  /** Mark live conflicts, then reload the invalidated durable review list. */
  refreshFromBroadcast: (
    canvasId: string,
    threadId: string,
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
      set((s) => ({
        byThread: { ...s.byThread, [threadId]: records },
        conflictedByThread: {
          ...s.conflictedByThread,
          [threadId]: conflicted,
        },
      }));
    },

    refreshFromBroadcast: (canvasId, threadId, skippedNodeIds = []) => {
      // Record transient local-first conflicts before starting the request.
      // `load()` preserves them and prunes ids that are not represented by the
      // canonical coalesced list it receives. A newer invalidation increments
      // load's generation, so a slower older response cannot overwrite it.
      set((s) => ({
        conflictedByThread: {
          ...s.conflictedByThread,
          [threadId]: Array.from(new Set(skippedNodeIds)),
        },
      }));
      void get().load(canvasId, threadId);
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
