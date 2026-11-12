// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { dismissToast, toast } from '@/components/Common/Toast';
import { hasAgentStreamClaim } from '@/hooks/agentStreamCoordinator';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore, {
  adoptRemoteNodeContent,
  requestCanvasResync,
} from '@/store/canvasStore';
import { CANVAS_PAGE_ID } from '@/store/canvasStore/sync/pageId';
import { useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { subscribeCanvasSync } from './canvasSyncSubscription';

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
 *    a mutation happened before we subscribed → reload to catch up.
 *  - `update`: if `fromVersion === local version` replay the deltas via
 *    `applyDeltasFromAgent`; if we are behind (`toVersion > local`) fall
 *    back to a reload; older/stale updates are ignored.
 *
 * A reload replaces the whole Space, so it never runs while this page still
 * has structure edits waiting to be sent: `requestCanvasResync` holds it
 * until the send queue has drained.
 *
 *  - `invalidate` naming nodes: another page saved those nodes' content
 *    (body, label, summary, …) through the per-node content PUT, which no
 *    `update` carries. Each node is fetched and shown unless this page has
 *    unsaved content of its own for it; the page's own saves are skipped.
 *
 * Received updates intentionally do NOT trigger preprocessing — that
 * stays with the originating side (the server, for headless `/execute`).
 */

interface CanvasSyncState {
  canvasId: string | null;
  connect: (canvasId: string) => void;
  disconnect: () => void;
}

let unsubscribe: (() => void) | null = null;

/**
 * Nodes another page saved while this page was still loading the Space. The
 * load may have read them before that save, so they are fetched once it ends.
 */
const savedDuringLoad = new Set<string>();
let stopWaitingForLoad: (() => void) | null = null;

function forgetSavedDuringLoad(): void {
  stopWaitingForLoad?.();
  stopWaitingForLoad = null;
  savedDuringLoad.clear();
}

function adoptAfterLoad(canvasId: string, nodeIds: readonly string[]): void {
  for (const id of nodeIds) savedDuringLoad.add(id);
  if (stopWaitingForLoad) return;
  stopWaitingForLoad = useCanvasStore.subscribe((state) => {
    if (state.isLoading) return;
    const ids = [...savedDuringLoad];
    forgetSavedDuringLoad();
    if (state.canvasId === canvasId) void adoptRemoteNodeContent(canvasId, ids);
  });
}

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
function openConflictThread(threadId: string, _canvasId: string): void {
  usePanelStore.getState().requestOpenRightPanel();
  const questionNode = useCanvasStore
    .getState()
    .nodes.find(
      (n) =>
        (n.data as { threadId?: unknown } | undefined)?.threadId === threadId,
    );
  if (questionNode) {
    openPreviewNode(questionNode.id);
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

function invalidateUnclaimedAgentHistories(
  canvasId: string,
  nodes: readonly Node[],
): void {
  for (const node of nodes) {
    const data = node.data as
      | { status?: unknown; threadId?: unknown }
      | undefined;
    if (
      typeof data?.threadId !== 'string' ||
      hasAgentStreamClaim(canvasId, data.threadId)
    ) {
      continue;
    }
    useChatStore.getState().setHistoryLoaded(data.threadId, false);
  }
}

export const useCanvasSyncStore = create<CanvasSyncState>((set, get) => ({
  canvasId: null,

  connect: (canvasId) => {
    if (get().canvasId === canvasId && unsubscribe) return;
    unsubscribe?.();
    forgetSavedDuringLoad();
    set({ canvasId });
    unsubscribe = subscribeCanvasSync(canvasId, (event) => {
      // Ignore late frames after a canvas switch / disconnect.
      if (get().canvasId !== canvasId) return;
      const canvasStore = useCanvasStore.getState();
      if (canvasStore.canvasId !== canvasId) return;
      const reload = (): void =>
        requestCanvasResync(canvasId, () => {
          const current = useCanvasStore.getState();
          if (current.canvasId === canvasId) {
            invalidateUnclaimedAgentHistories(canvasId, current.nodes);
          }
        });

      if (event.type === 'snapshot') {
        // Skip the catch-up reload while an initial/primary load is
        // still in flight. On fresh open the CanvasPage mount load
        // is already fetching the latest state, but it hasn't set
        // `version` yet when this snapshot arrives — without this
        // guard the stale-version comparison below fires a second,
        // redundant `loadCanvas` that races the mount load. The
        // in-flight load already brings the
        // freshest state, so a snapshot-driven reload is only
        // meaningful once we've settled.
        if (canvasStore.isLoading) return;
        if (event.data.version !== canvasStore.version) reload();
        return;
      }

      if (event.type === 'invalidate') {
        // A node-content save by another page. An event without node ids is
        // a read-model notice, and this page already shows its own saves.
        const { nodeIds, originPageId } = event.data;
        if (!nodeIds?.length || originPageId === CANVAS_PAGE_ID) return;
        if (canvasStore.isLoading) adoptAfterLoad(canvasId, nodeIds);
        else void adoptRemoteNodeContent(canvasId, nodeIds);
        return;
      }

      if (event.type !== 'update') return;
      const { fromVersion, toVersion, deltas, pendingEffects } = event.data;
      let skippedNodeIds: string[] = [];
      // A rename: the title is not part of any node, so it is taken as is.
      // It is the server's value even when this update arrives out of step.
      if (
        event.data.title !== undefined &&
        toVersion > canvasStore.version &&
        event.data.title !== null
      ) {
        canvasStore._setStateNoAutosave({ canvasTitle: event.data.title });
        useWorkspaceStore.getState().setSpaceTitle(canvasId, event.data.title);
      }
      if (fromVersion === canvasStore.version) {
        skippedNodeIds = canvasStore.applyDeltasFromAgent(
          deltas as Delta[],
          toVersion,
          pendingEffects as SyncPendingEffects,
          event.data.agentNodeProjection,
          // Paint order the deltas cannot express; an order that cannot be
          // installed heals through the same reload as a version gap.
          { events: event.data.orderEvents, onDiverged: reload },
          // Lets the store recognise the echo of this page's own batch and
          // tell a person's edit from an agent's.
          {
            ...(event.data.operationId
              ? { operationId: event.data.operationId }
              : {}),
            ...(event.data.source ? { source: event.data.source } : {}),
          },
        );
      } else if (toVersion > canvasStore.version) {
        // Gap (missed an earlier update). A blind `loadCanvas` would
        // clobber un-persisted local edits, so skip it while the user
        // is mid-editing a body, and hold it until queued structure edits
        // have been sent. Incremental gap-heal (delta-log backfill) is
        // deferred to P2.
        if (canvasStore.pendingContentNodeIds().length === 0) reload();
      }
      // else: stale/older update — ignore.

      // Draw the user's attention *at the moment* an agent write was
      // dropped because they were editing that node — a passive card
      // badge alone is easy to miss mid-edit.
      notifySkippedAgentWrites(skippedNodeIds, event.data.threadId, canvasId);

      // Attribute change-review records to the originating ACP
      // conversation's card. `skippedNodeIds` marks the rows whose
      // agent write was blocked by a local edit, so the card
      // can flag them as conflicts instead of silently listing them
      // as applied.
      if (event.data.threadId && Array.isArray(event.data.changes)) {
        useAcpThreadChangesStore
          .getState()
          .replaceFromBroadcast(
            event.data.threadId,
            event.data.changes as CanvasChangeRecord[],
            skippedNodeIds,
          );
      }
      invalidateUnclaimedAgentHistories(
        canvasId,
        (pendingEffects as SyncPendingEffects).mutatedNodes.filter(
          (node) =>
            (node.data as { status?: unknown } | undefined)?.status ===
            'running',
        ),
      );
    });
  },

  disconnect: () => {
    unsubscribe?.();
    unsubscribe = null;
    forgetSavedDuringLoad();
    // Clear any lingering conflict toast — it's bound to the canvas we're
    // leaving and shouldn't bleed onto the next one.
    if (conflictToastId) {
      dismissToast(conflictToastId);
      conflictToastId = null;
    }
    set({ canvasId: null });
  },
}));
