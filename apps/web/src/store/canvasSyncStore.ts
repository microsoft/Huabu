// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { getCanvasContentChanges } from '@/api/canvasSync';
import { dismissToast, toast } from '@/components/Common/Toast';
import { hasAgentStreamClaim } from '@/hooks/agentStreamCoordinator';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore, {
  adoptRemoteNodeContent,
  isDeletedElsewhere,
  requestCanvasResync,
} from '@/store/canvasStore';
import { MD_BACKED_NODE_TYPES } from '@/store/canvasStore/save/nodeContentFields';
import { CANVAS_PAGE_ID } from '@/store/canvasStore/sync/pageId';
import { useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import { useSeenChangesStore } from '@/store/seenChangesStore';
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
 *    `applyServerDeltas`; if we are behind (`toVersion > local`) fall
 *    back to a reload; older/stale updates are ignored.
 *
 * A reload replaces the whole Space, so it never runs while this page still
 * has structure edits waiting to be sent: `requestCanvasResync` holds it
 * until the send queue has drained.
 *
 *  - Content saved before the stream was open (a content save does not
 *    change the version): every snapshot — the first and each reconnect —
 *    and every load that ends with the stream open asks the server which
 *    nodes were saved after the content position the page's content is
 *    valid from (`canvasStore.contentPosition`, set by the load). The named
 *    nodes are fetched like the nodes of an `invalidate`, and the position
 *    moves on to the answer's. So nothing saved between the load's read and
 *    the subscription is missed, in either order of the two. The position
 *    is the server's stored record of node writes, so it holds across a
 *    server restart. Should the server be unable to compare it all the same
 *    (`reset`: the Space was created anew, or moved to another storage
 *    backend), every node with saved content is fetched, a few at a time.
 *    The Space is never loaded again for content.
 *
 *  - A load that ends behind the stream: a snapshot that arrives while the
 *    Space is loading is not compared, since the load is expected to bring
 *    that version. If the load then ends with an older version than the
 *    stream has named — its read was made before a commit that preceded the
 *    subscription — the Space is loaded again.
 *
 *  - `invalidate` naming nodes: another page saved those nodes' content
 *    (body, label, summary, …) through the per-node content PUT, which no
 *    `update` carries. Each node is fetched and shown unless this page has
 *    unsaved content of its own for it; the page's own saves are skipped.
 *
 *  - `preprocess`: a preprocessing run the server started for a node
 *    began or ended; shown as the node's ingestion state.
 *
 * No received event makes this page request preprocessing: the server
 * starts it where a write is committed and stores the result itself.
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

const CONTENT_FETCH_CONCURRENCY = 4;
/** Waits before asking again after a failed content check. */
const CONTENT_CHECK_RETRY_MS = [1_000, 2_000, 4_000];

/** What the stream has said since `connect`, and the content check's run. */
interface Connection {
  canvasId: string;
  /** A snapshot has arrived: the server is delivering events to this page. */
  streamSeen: boolean;
  /** The highest Space version the stream has named. */
  streamVersion: number | null;
  /** The stream version a load that ended behind it was last reloaded for. */
  reloadedFor: number | null;
  checking: boolean;
  checkAgain: boolean;
  failedChecks: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  stopWatchingLoads: () => void;
}
let connection: Connection | null = null;

function closeConnection(): void {
  if (!connection) return;
  if (connection.retryTimer) clearTimeout(connection.retryTimer);
  connection.stopWatchingLoads();
  connection = null;
}

/**
 * Ask the server which nodes had their content saved after the position the
 * page's content is valid from, fetch them, and move the position on.
 *
 * Called when the stream has (re)connected and when a load ends with the
 * stream open. By then the server delivers every later save as an event, so
 * what this asks for is exactly what no event could have carried. One run at
 * a time; a call during a run makes it ask once more. The position moves
 * only when every named node was fetched, so a failed request or fetch is
 * asked for again (a few times, then at the next snapshot or load).
 */
function catchUpContent(current: Connection): void {
  if (current.checking) {
    current.checkAgain = true;
    return;
  }
  if (current.retryTimer) {
    clearTimeout(current.retryTimer);
    current.retryTimer = null;
  }
  const { canvasId } = current;
  const live = (): boolean =>
    connection === current && useCanvasStore.getState().canvasId === canvasId;
  current.checking = true;
  void (async () => {
    try {
      do {
        current.checkAgain = false;
        if (!live()) return;
        const store = useCanvasStore.getState();
        const since = store.contentPosition;
        // While loading, the load's end asks. Without a position there is
        // nothing to ask from.
        if (store.isLoading || !since) return;
        const answer = await getCanvasContentChanges(canvasId, since);
        if (!live()) return;
        // A load that began meanwhile brings fresher content and its own
        // position; its end asks again.
        if (useCanvasStore.getState().isLoading) return;
        if (useCanvasStore.getState().contentPosition !== since) {
          current.checkAgain = true;
          continue;
        }
        let nodeIds = answer.changedNodeIds ?? [];
        // The server cannot compare the position: fetch every node that has
        // saved content. Never a whole-Space load, which would drop the
        // page's undo history for content it may well already show.
        if (answer.reset)
          nodeIds = useCanvasStore
            .getState()
            .nodes.filter((node) => MD_BACKED_NODE_TYPES.has(node.type ?? ''))
            .map((node) => node.id);
        for (
          let start = 0;
          start < nodeIds.length;
          start += CONTENT_FETCH_CONCURRENCY
        ) {
          const outcomes = await adoptRemoteNodeContent(
            canvasId,
            nodeIds.slice(start, start + CONTENT_FETCH_CONCURRENCY),
          );
          if (!live()) return;
          if (outcomes.includes('failed'))
            throw new Error('A saved node could not be fetched');
        }
        const now = useCanvasStore.getState();
        if (now.isLoading) return;
        if (now.contentPosition !== since) {
          current.checkAgain = true;
          continue;
        }
        now._setStateRaw({ contentPosition: answer.position });
        current.failedChecks = 0;
      } while (current.checkAgain);
    } catch (error) {
      if (!live()) return;
      console.warn('[canvasSync] content check failed', error);
      const wait = CONTENT_CHECK_RETRY_MS[current.failedChecks];
      current.failedChecks += 1;
      if (wait !== undefined)
        current.retryTimer = setTimeout(() => {
          current.retryTimer = null;
          if (connection === current) catchUpContent(current);
        }, wait);
    } finally {
      current.checking = false;
    }
  })();
}

type SyncPendingEffects = {
  mutatedNodeIds: string[];
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
  withheldNodeIds: readonly string[],
  threadId: string | undefined,
  canvasId: string,
): void {
  // A deletion kept back for a node being edited has its own notice.
  const skippedNodeIds = withheldNodeIds.filter(
    (id) => !isDeletedElsewhere(id),
  );
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
    closeConnection();
    set({ canvasId });
    const reload = (): void =>
      requestCanvasResync(canvasId, () => {
        const current = useCanvasStore.getState();
        if (current.canvasId === canvasId) {
          invalidateUnclaimedAgentHistories(canvasId, current.nodes);
        }
      });
    let wasLoading = useCanvasStore.getState().isLoading;
    let seenGeneration = useCanvasStore.getState().loadGeneration;
    const current: Connection = {
      canvasId,
      streamSeen: false,
      streamVersion: null,
      reloadedFor: null,
      checking: false,
      checkAgain: false,
      failedChecks: 0,
      retryTimer: null,
      // A load that ends while the stream is open. Its content is valid from
      // its own position, which may be before the subscription; and its
      // version may be behind what the stream named while it was in flight.
      // A refresh in place never enters `isLoading`; it is seen through the
      // load counter.
      stopWatchingLoads: useCanvasStore.subscribe((state) => {
        const ended =
          (wasLoading && !state.isLoading) ||
          (!state.isLoading && state.loadGeneration !== seenGeneration);
        wasLoading = state.isLoading;
        seenGeneration = state.loadGeneration;
        if (!ended || state.canvasId !== canvasId || !current.streamSeen)
          return;
        if (
          current.streamVersion !== null &&
          current.streamVersion > state.version &&
          current.reloadedFor !== current.streamVersion
        ) {
          // Once per version named, so a load that cannot catch up does not
          // loop; the reload's own end comes back here.
          current.reloadedFor = current.streamVersion;
          reload();
          return;
        }
        catchUpContent(current);
      }),
    };
    connection = current;
    /** Nodes shown as pending for a run the server announced. */
    const serverPreprocessing = new Set<string>();
    unsubscribe = subscribeCanvasSync(canvasId, (event) => {
      // Ignore late frames after a canvas switch / disconnect.
      if (get().canvasId !== canvasId) return;
      const canvasStore = useCanvasStore.getState();
      if (canvasStore.canvasId !== canvasId) return;
      if (event.type === 'preprocess') {
        // Preprocessing the server runs after a write: show it on the node
        // until it ends. What it derived arrives as node content does.
        const { nodeId, status } = event.data;
        if (status === 'pending') {
          serverPreprocessing.add(nodeId);
          canvasStore.setNodeIngestion(nodeId, { status: 'pending' });
        } else {
          // Done or failed: either way the run is over.
          serverPreprocessing.delete(nodeId);
          canvasStore.clearNodeIngestion(nodeId);
        }
        return;
      }
      if (event.type !== 'invalidate')
        current.streamVersion = Math.max(
          current.streamVersion ?? 0,
          event.type === 'snapshot' ? event.data.version : event.data.toVersion,
        );

      if (event.type === 'snapshot') {
        current.streamSeen = true;
        // A (re)connection: the end of a run announced on the previous
        // connection may have been missed, so nothing stays pending for it.
        for (const nodeId of serverPreprocessing)
          canvasStore.clearNodeIngestion(nodeId);
        serverPreprocessing.clear();
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
        // Content saved before this (re)connection: a content save does not
        // change the version, so the comparison above does not see it.
        // While a load is in flight — the one in progress above, or the
        // reload just started — its end asks instead. A reload that is held
        // back (unsent edits, unsaved text) is not waited for.
        catchUpContent(current);
        return;
      }

      if (event.type === 'invalidate') {
        // A node-content save by another page. An event without node ids is
        // a read-model notice, and this page already shows its own saves.
        const { nodeIds, originPageId, reviewThreadId, seenChanged } =
          event.data;
        // The person may have seen something on another device.
        if (seenChanged) void useSeenChangesStore.getState().refresh(canvasId);
        // A review record kept or reverted on another page: the list this
        // page holds for that conversation is out of date.
        if (reviewThreadId)
          void useAcpThreadChangesStore
            .getState()
            .load(canvasId, reviewThreadId);
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
        canvasStore._setStateRaw({ canvasTitle: event.data.title });
        useWorkspaceStore.getState().setSpaceTitle(canvasId, event.data.title);
      }
      if (fromVersion === canvasStore.version) {
        skippedNodeIds = canvasStore.applyServerDeltas(
          deltas as Delta[],
          toVersion,
          pendingEffects as SyncPendingEffects,
          event.data.agentNodeProjection,
          // Lets the store recognise the echo of this page's own batch and
          // tell a person's edit from an agent's.
          {
            ...(event.data.operationId
              ? { operationId: event.data.operationId }
              : {}),
            ...(event.data.source ? { source: event.data.source } : {}),
            // The stored revision of every node whose content it changed.
            ...(event.data.nodeContentRevisions
              ? { nodeContentRevisions: event.data.nodeContentRevisions }
              : {}),
          },
        );
      } else if (toVersion > canvasStore.version) {
        // Gap (missed an earlier update). A blind `loadCanvas` would
        // clobber un-persisted local edits, so the reload is held — not
        // dropped — until queued structure edits have been sent and until
        // a body being edited has been saved (`requestCanvasResync`).
        reload();
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
      // The update names the nodes it changed; this page holds them now.
      const mutatedIds = new Set(
        (pendingEffects as SyncPendingEffects).mutatedNodeIds,
      );
      invalidateUnclaimedAgentHistories(
        canvasId,
        useCanvasStore
          .getState()
          .nodes.filter(
            (node) =>
              mutatedIds.has(node.id) &&
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
    closeConnection();
    // Clear any lingering conflict toast — it's bound to the canvas we're
    // leaving and shouldn't bleed onto the next one.
    if (conflictToastId) {
      dismissToast(conflictToastId);
      conflictToastId = null;
    }
    set({ canvasId: null });
  },
}));
