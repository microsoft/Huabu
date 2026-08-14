// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { readTypedSSEStream } from '@/api/_sse';
import { canvasSyncStreamUrl } from '@/api/canvasSync';
import { dismissToast, toast } from '@/components/Common/Toast';
import { hasAgentStreamClaim } from '@/hooks/agentStreamCoordinator';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import type { CanvasSyncEvent } from '@huabu/shared';
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
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;

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
    if (get().canvasId === canvasId && abortController) return;
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    set({ canvasId });

    void (async () => {
      let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      while (!signal.aborted && get().canvasId === canvasId) {
        try {
          const response = await fetch(canvasSyncStreamUrl(canvasId), {
            signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`Canvas sync failed with HTTP ${response.status}`);
          }
          await readTypedSSEStream<CanvasSyncEvent>(
            response,
            (event) => {
              reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
              // Ignore late frames after a canvas switch / disconnect.
              if (get().canvasId !== canvasId) return;
              const canvasStore = useCanvasStore.getState();
              if (canvasStore.canvasId !== canvasId) return;

              if (event.type === 'snapshot') {
                // Skip the catch-up reload while an initial/primary load is
                // still in flight. On fresh open the CanvasPage mount load
                // is already fetching the latest state, but it hasn't set
                // `version` yet when this snapshot arrives — without this
                // guard the stale-version comparison below fires a second,
                // redundant `loadCanvas` that races the mount load and
                // leaks a spurious structure PUT (resetting `updatedAt` to
                // the open time). The in-flight load already brings the
                // freshest state, so a snapshot-driven reload is only
                // meaningful once we've settled.
                if (canvasStore.isLoading) return;
                if (event.data.version !== canvasStore.version) {
                  void canvasStore
                    .loadCanvas(canvasId, { resetHistory: true })
                    .then(() => {
                      const current = useCanvasStore.getState();
                      if (current.canvasId === canvasId) {
                        invalidateUnclaimedAgentHistories(
                          canvasId,
                          current.nodes,
                        );
                      }
                    });
                }
                return;
              }

              // event.type === 'update'
              const { fromVersion, toVersion, deltas, pendingEffects } =
                event.data;
              let skippedNodeIds: string[] = [];
              if (fromVersion === canvasStore.version) {
                skippedNodeIds = canvasStore.applyDeltasFromAgent(
                  deltas as Delta[],
                  toVersion,
                  pendingEffects as SyncPendingEffects,
                );
              } else if (toVersion > canvasStore.version) {
                // Gap (missed an earlier update). A blind `loadCanvas` would
                // clobber un-persisted local edits, so skip it while the user
                // is mid-editing and let autosave's 409 path arbitrate (C3).
                // Incremental gap-heal (delta-log backfill) is deferred to P2.
                if (canvasStore.pendingContentNodeIds().length === 0) {
                  void canvasStore
                    .loadCanvas(canvasId, { resetHistory: true })
                    .then(() => {
                      const current = useCanvasStore.getState();
                      if (current.canvasId === canvasId) {
                        invalidateUnclaimedAgentHistories(
                          canvasId,
                          current.nodes,
                        );
                      }
                    });
                }
              }
              // else: stale/older update — ignore.

              // Draw the user's attention *at the moment* an agent write was
              // dropped because they were editing that node — a passive card
              // badge alone is easy to miss mid-edit.
              notifySkippedAgentWrites(
                skippedNodeIds,
                event.data.threadId,
                canvasId,
              );

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
            },
            signal,
          );
          if (!signal.aborted) {
            throw new Error('Canvas sync stream ended unexpectedly');
          }
        } catch (error) {
          if (signal.aborted || get().canvasId !== canvasId) return;
          console.warn('[canvasSync] reconnecting after stream failure', error);
        }

        await new Promise<void>((resolve) => {
          const finish = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            window.clearTimeout(timeout);
            finish();
          };
          const timeout = window.setTimeout(finish, reconnectDelay);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    })();
  },

  disconnect: () => {
    abortController?.abort();
    abortController = null;
    // Clear any lingering conflict toast — it's bound to the canvas we're
    // leaving and shouldn't bleed onto the next one.
    if (conflictToastId) {
      dismissToast(conflictToastId);
      conflictToastId = null;
    }
    set({ canvasId: null });
  },
}));
