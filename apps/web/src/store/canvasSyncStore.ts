// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { readTypedSSEStream } from '@/api/_sse';
import { canvasSyncStreamUrl } from '@/api/canvasSync';
import { dismissToast, toast } from '@/components/Common/Toast';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore, { reloadCanvasWhenSafe } from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';

import {
  createCanvasSnapshotCatchup,
  runCanvasSyncReconnectLoop,
} from './canvasSyncLifecycle';

import type { CanvasSyncEvent } from '@huabu/shared';
import type { AgentBinding } from '@huabu/shared';
import type { CanvasChangeRecord, Delta } from '@huabu/shared/canvas-engine';
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
 *  - Phase 4 `update.commit`: use the same adjacent-version gate as HTTP
 *    mutation acknowledgements, dedupe by commit id, and replay only remote
 *    payloads. Legacy updates retain the delta fallback.
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
let canvasStoreUnsubscribe: (() => void) | null = null;

const snapshotCatchup = createCanvasSnapshotCatchup({
  getState: () => {
    const state = useCanvasStore.getState();
    return {
      canvasId: state.canvasId,
      version: state.version,
      isLoading: state.isLoading,
      structureDirtyGeneration: state.structureDirtyGeneration,
      structureSyncedGeneration: state.structureSyncedGeneration,
      pendingContentNodeIds: state.pendingContentNodeIds(),
    };
  },
  reload: async (canvasId) => {
    await reloadCanvasWhenSafe(canvasId);
  },
});

type SyncPendingEffects = {
  mutatedNodes: Node[];
  deletedNodeIds: string[];
  contentEditedNodeIds: string[];
  deferredFitFrameIds: string[];
};

// Single active "agent edit skipped" toast. The conflict is transient
// (local-first already kept the user's edit) but we surface it *now*,
// while the user is still editing, so they can decide whether to re-run
// the agent. Persistent (no auto-fade) + dismissible so a moment of
// inattention doesn't lose the notice; a module-scoped id keeps at most
// one on screen even when an agent writes repeatedly during an edit.
let conflictToastId: string | null = null;

/**
 * Open the conversation that authored the skipped write. When a question
 * node owns the thread, enter its replay; otherwise just reveal the chat
 * panel (the built-in / ACP canvas thread's change card renders there).
 */
function openConflictThread(threadId: string, canvasId: string): void {
  usePanelStore.getState().requestOpenRightPanel();
  const questionNode = useCanvasStore
    .getState()
    .nodes.find(
      (n) =>
        (n.data as { threadId?: unknown } | undefined)?.threadId === threadId,
    );
  if (questionNode) {
    const binding = (questionNode.data as { agentBinding?: AgentBinding })
      .agentBinding;
    useChatStore.getState().openQuestionThread(
      {
        presentationAnchor: { canvasId, nodeId: questionNode.id },
        conversationOwner: {
          canvasId,
          nodeId: questionNode.id,
          threadId,
        },
      },
      binding,
      canvasId,
    );
  }
}

function notifySkippedAgentWrites(
  skippedNodeIds: readonly string[],
  threadId: string | undefined,
  canvasId: string,
): void {
  if (skippedNodeIds.length === 0) return;
  const nodes = useCanvasStore.getState().nodes;
  const labelOf = (id: string): string => {
    const data = nodes.find((n) => n.id === id)?.data as
      | { label?: unknown }
      | undefined;
    const label = data?.label;
    return typeof label === 'string' && label.trim() ? label : 'a note';
  };
  const names = skippedNodeIds.map(labelOf);
  const message =
    names.length === 1
      ? `The agent's change to “${names[0]}” was skipped because you were editing it — your version was kept.`
      : `The agent's changes to ${names.length} nodes were skipped because you were editing them — your versions were kept.`;
  if (conflictToastId) dismissToast(conflictToastId);
  conflictToastId = toast(message, {
    tone: 'warning',
    duration: 0,
    ...(threadId
      ? {
          action: {
            label: 'Open conversation',
            onClick: () => openConflictThread(threadId, canvasId),
          },
        }
      : {}),
  });
}

export const useCanvasSyncStore = create<CanvasSyncState>((set, get) => ({
  canvasId: null,

  connect: (canvasId) => {
    if (get().canvasId === canvasId && abortController) return;
    const previousCanvasId = get().canvasId;
    abortController?.abort();
    if (previousCanvasId !== canvasId) snapshotCatchup.clear();
    canvasStoreUnsubscribe?.();
    const controller = new AbortController();
    abortController = controller;
    const signal = controller.signal;
    set({ canvasId });
    const unsubscribe = useCanvasStore.subscribe(() => {
      void snapshotCatchup.reconcile();
    });
    canvasStoreUnsubscribe = unsubscribe;

    void runCanvasSyncReconnectLoop({
      signal,
      isActive: () =>
        abortController === controller && get().canvasId === canvasId,
      connectOnce: async () => {
        let receivedEvent = false;
        const response = await fetch(canvasSyncStreamUrl(canvasId), { signal });
        if (!response.ok) return false;
        await readTypedSSEStream<CanvasSyncEvent>(
          response,
          (event) => {
            receivedEvent = true;
            // Ignore late frames after a canvas switch / disconnect.
            if (get().canvasId !== canvasId) return;
            const canvasStore = useCanvasStore.getState();
            if (canvasStore.canvasId !== canvasId) return;

            if (event.type === 'snapshot') {
              // A primary GET may already have read an older version and be
              // delayed in transit. Retain this snapshot through the loading
              // state; the store subscription reconciles it immediately after
              // that GET settles instead of silently dropping the only v2
              // signal that predates our stream subscription.
              void snapshotCatchup.observe(canvasId, event.data.version);
              return;
            }

            if (canvasStore.isLoading) {
              // An update can race the same delayed primary GET as a
              // snapshot. Applying it to the pre-load store would only have
              // the GET overwrite it moments later, so retain its target
              // version and heal from one authoritative post-load snapshot.
              void snapshotCatchup.observe(canvasId, event.data.toVersion);
              return;
            }

            // event.type === 'update'
            const { fromVersion, toVersion, deltas, pendingEffects } =
              event.data;
            let skippedNodeIds: string[] = [];
            if (event.data.commit) {
              const consumed = canvasStore.consumeCommit({
                kind: 'event',
                commit: event.data.commit,
                pendingEffects: pendingEffects as SyncPendingEffects,
              });
              skippedNodeIds = consumed.skippedNodeIds;
              if (consumed.shouldReload) {
                void reloadCanvasWhenSafe(canvasId);
              }
            } else if (fromVersion === canvasStore.version) {
              // Compatibility path for Phase 3 / rolling-upgrade producers.
              skippedNodeIds = canvasStore.applyDeltasFromAgent(
                deltas as Delta[],
                toVersion,
                pendingEffects as SyncPendingEffects,
              );
            } else if (toVersion > canvasStore.version) {
              // Legacy gap: preserve both kinds of unsaved local work.
              const hasUnsavedStructure =
                canvasStore.structureDirtyGeneration !==
                canvasStore.structureSyncedGeneration;
              if (
                !hasUnsavedStructure &&
                canvasStore.pendingContentNodeIds().length === 0
              ) {
                void reloadCanvasWhenSafe(canvasId);
              }
            }
            // else: stale/older update — ignore.

            // Draw the user's attention *at the moment* an agent write was
            // dropped because they were editing that node — a passive card
            // badge alone is easy to miss mid-edit.
            notifySkippedAgentWrites(
              skippedNodeIds,
              event.data.commit?.originator.threadId ?? event.data.threadId,
              canvasId,
            );

            // Attribute change-review state to the originating ACP
            // conversation's card. Phase 4 sends a bounded invalidation and
            // reloads the canonical list; `skippedNodeIds` flags writes that
            // lost local-first arbitration. Legacy servers may still send
            // the complete coalesced list inline.
            const threadId =
              event.data.commit?.originator.threadId ?? event.data.threadId;
            if (threadId && event.data.changesInvalidated === true) {
              useAcpThreadChangesStore
                .getState()
                .refreshFromBroadcast(canvasId, threadId, skippedNodeIds);
            } else if (threadId && Array.isArray(event.data.changes)) {
              // Rolling-upgrade compatibility for legacy servers that still
              // broadcast full review records instead of an invalidation.
              useAcpThreadChangesStore
                .getState()
                .replaceFromBroadcast(
                  threadId,
                  event.data.changes as CanvasChangeRecord[],
                  skippedNodeIds,
                );
            }
          },
          signal,
        );
        // A response that immediately reaches EOF without even its mandatory
        // snapshot is a failed connection. Let the reconnect loop increase
        // backoff instead of opening a hot request loop every 250 ms.
        return receivedEvent;
      },
    }).finally(() => {
      if (abortController !== controller) return;
      abortController = null;
      if (canvasStoreUnsubscribe === unsubscribe) {
        unsubscribe();
        canvasStoreUnsubscribe = null;
      }
    });
  },

  disconnect: () => {
    abortController?.abort();
    abortController = null;
    canvasStoreUnsubscribe?.();
    canvasStoreUnsubscribe = null;
    snapshotCatchup.clear();
    // Clear any lingering conflict toast — it's bound to the canvas we're
    // leaving and shouldn't bleed onto the next one.
    if (conflictToastId) {
      dismissToast(conflictToastId);
      conflictToastId = null;
    }
    set({ canvasId: null });
  },
}));
