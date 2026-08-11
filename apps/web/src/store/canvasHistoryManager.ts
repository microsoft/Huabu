// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  stripTransientNodeFields,
  stripTransientEdgeFields,
  TRANSIENT_NODE_FIELDS,
} from '@huabu/shared/canvas-engine';

import { ApiError, deleteNode } from '../api';
import { toast } from '../components/Common/Toast';

import type {
  DeleteNodeResponse,
  ExecuteOriginator,
  RecentAction,
} from '@huabu/shared';
import type { Node, Edge } from '@xyflow/react';

const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of the canvas for undo / redo.
 *  Contains nodes and edges with ReactFlow runtime fields
 *  (`selected`, `dragging`, `measured`, `resizing`) stripped out. */
export type CanvasSnapshot = {
  nodes: Node[];
  edges: Edge[];
};

/** Extended snapshot that also captures action history for preview/restore. */
export type CanvasPreviewSnapshot = CanvasSnapshot & {
  actionHistory: RecentAction[];
};

/**
 * Callback the store provides so the history manager can trigger
 * preprocessing for nodes that reappear after undo/redo.
 */
export type TriggerPreprocessingFn = (node: Node) => void;

export type DeleteNodeMutationOptions = {
  originator?: ExecuteOriginator;
  onResponse?: (canvasId: string, response: DeleteNodeResponse) => void;
};

// ---------------------------------------------------------------------------
// Error message mapping
// ---------------------------------------------------------------------------

/**
 * Translate a thrown error from `deleteNode()` into a user-facing toast
 * string. Drives off the shared `CanvasErrorCode` contract — never off
 * the HTTP `message`, which the server only owns as a developer-facing
 * fallback. See `packages/shared/src/types/api/canvas.ts`.
 *
 * Buckets the three real failure modes:
 * - **`NODE_FILE_DELETE_FAILED` (500)** — `.md` unlink threw (Windows
 *   EPERM / EBUSY from AV or a file-watcher).
 * - **`CANVAS_NOT_FOUND` (404)** — canvas vanished server-side
 *   (deleted from another tab, reset, etc.).
 * - **Network / unknown** — `fetch` itself threw (offline, server
 *   down, origin guard, timeout), so there is no `ApiError` to read.
 */
function describeDeleteFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NODE_FILE_DELETE_FAILED') {
      return "Couldn't delete a node's file on disk — it may be locked by another process.";
    }
    if (error.code === 'CANVAS_NOT_FOUND') {
      return 'This Space no longer exists on the server.';
    }
    // Unknown server-emitted code: fall back to the server's English
    // message so the user at least sees *something* meaningful.
    return error.message;
  }
  return "Couldn't reach the server to delete this node.";
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Strip ReactFlow transient internals (selected, dragging, measured,
 *  resizing) while preserving all other props (draggable, zIndex, extent,
 *  etc.) that are actively managed by the app. Uses the shared canonical
 *  field list so undo dedup and the server-side diff strip identically. */
export function createSnapshot(nodes: Node[], edges: Edge[]): CanvasSnapshot {
  return {
    nodes: nodes.map((n) => stripTransientNodeFields(n)),
    edges: edges.map((e) => stripTransientEdgeFields(e)),
  };
}

/**
 * Content-level comparison of two snapshots by JSON-stringifying each
 * node/edge.  The snapshots are already stripped of transient internals,
 * so we only compare the fields that matter for undo.
 */
function snapshotsEqual(a: CanvasSnapshot, b: CanvasSnapshot): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length)
    return false;
  for (let i = 0; i < a.nodes.length; i++) {
    if (JSON.stringify(a.nodes[i]) !== JSON.stringify(b.nodes[i])) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    if (JSON.stringify(a.edges[i]) !== JSON.stringify(b.edges[i])) return false;
  }
  return true;
}

/**
 * Question nodes own a conversational `data` payload (`content`,
 * `threadId`, `status`, `viewed`, `agentBinding`, `agentMode`,
 * `errorMessage`, `responseSummary`, plus the `label` derived from
 * `content`). That payload is entirely system-driven — authored on
 * send and mutated by the agent runner via `patchNodeSilent` — never a
 * deliberate canvas edit. Undo/redo therefore restores a question
 * node's geometry (position / size / parent, all top-level props) but
 * must NOT rewind its `data` to a stale snapshot value: undoing a move
 * should not wipe the thread binding or answer the node already holds.
 *
 * So for every question node that still exists in the live canvas we
 * keep its current `data` and take only the structural props from the
 * restored snapshot. Question nodes absent from the live canvas (undo
 * is resurrecting a deleted node) fall back to the snapshot's `data` —
 * the only source available, and the correct pre-deletion value.
 *
 * Direction-neutral: both undo and redo pop a target snapshot and own
 * the live `currentNodes`, so the same merge applies to either.
 */
function preserveLiveQuestionData(
  restoredNodes: Node[],
  currentNodes: Node[],
): Node[] {
  const liveById = new Map(currentNodes.map((n) => [n.id, n]));
  return restoredNodes.map((node) => {
    if (node.type !== 'question') return node;
    const live = liveById.get(node.id);
    // Resurrection (no live node) → snapshot data is the correct source.
    if (!live) return node;
    return { ...node, data: live.data };
  });
}

/**
 * Snapshots strip React Flow runtime fields (selection / drag / measure),
 * so a restored node carries none of them. Restoring it verbatim would
 * therefore clear the user's current selection on every undo/redo. Re-
 * apply the live transient fields for each node that still exists so an
 * undo of a content/geometry change leaves selection untouched.
 *
 * Direction-neutral: both undo and redo own the live `currentNodes`.
 */
function preserveLiveTransient(
  restoredNodes: Node[],
  currentNodes: Node[],
): Node[] {
  const liveById = new Map(currentNodes.map((n) => [n.id, n]));
  return restoredNodes.map((node) => {
    const live = liveById.get(node.id) as Record<string, unknown> | undefined;
    if (!live) return node;
    const merged = { ...node } as Record<string, unknown>;
    for (const k of TRANSIENT_NODE_FIELDS) {
      if (k in live) merged[k] = live[k];
    }
    return merged as Node;
  });
}

// ---------------------------------------------------------------------------
// Canvas History Manager
// ---------------------------------------------------------------------------

/**
 * Self-contained undo/redo history manager for the canvas.
 *
 * All snapshot stacks, dedup logic, resize debounce timers, and server-side
 * sync (in-flight DELETE abort / re-ingestion) live here — keeping the
 * canvas store focused on CRUD.
 *
 * Usage from canvasStore:
 *   import { canvasHistoryManager } from './canvasHistoryManager';
 *   canvasHistoryManager.takeSnapshot(nodes, edges);
 *   const result = canvasHistoryManager.undo(nodes, edges);
 */
class CanvasHistoryManager {
  // ---- Snapshot stacks (kept outside zustand to avoid subscriber noise) ----
  private undoStack: CanvasSnapshot[] = [];
  private redoStack: CanvasSnapshot[] = [];

  // ---- In-flight DELETE requests (abortable on undo) ----
  private inflightDeletes = new Map<string, AbortController>();

  // ---- Gesture snapshot tracking ----
  /** True when `beginGesture` has been called but the resulting command
   *  batch has not yet been executed. Used by the executor to verify
   *  that `snapshot: 'caller'` commands are properly paired. */
  private _gestureSnapshotTaken = false;

  /** Whether the pending gesture's `takeSnapshot` actually pushed a new
   *  entry (vs. being deduped). Drives `rollbackGestureSnapshot` so we
   *  only pop a snapshot this gesture created. */
  private _gestureSnapshotPushed = false;

  get gestureSnapshotTaken(): boolean {
    return this._gestureSnapshotTaken;
  }

  /** Mark that a gesture snapshot was consumed by the executor. */
  consumeGestureSnapshot(): void {
    this._gestureSnapshotTaken = false;
    this._gestureSnapshotPushed = false;
  }

  /** Mark that a caller-managed snapshot was taken for the upcoming command.
   *  `pushed` records whether `takeSnapshot` actually added a stack entry
   *  (vs. dedup), so a later `rollbackGestureSnapshot` can pop exactly the
   *  entry this gesture created. Omit `pushed` to merely re-arm the "taken"
   *  flag (e.g. resize preview ticks) without disturbing the recorded push
   *  state. */
  markGestureSnapshot(pushed?: boolean): void {
    this._gestureSnapshotTaken = true;
    if (pushed !== undefined) this._gestureSnapshotPushed = pushed;
  }

  /**
   * Discard the snapshot the current gesture optimistically took when the
   * gesture turns out to have mutated nothing (e.g. a click that merely
   * selects a node still fires `onNodeDragStart` → `beginGesture`). Without
   * this, that snapshot captures the *result* of a prior un-snapshotted
   * free-node move and becomes a phantom "empty" undo step.
   *
   * No-op unless a snapshot is still pending (not consumed by a real
   * command) AND it actually pushed a stack entry.
   */
  rollbackGestureSnapshot(): void {
    if (this._gestureSnapshotTaken && this._gestureSnapshotPushed) {
      this.undoStack.pop();
    }
    this._gestureSnapshotTaken = false;
    this._gestureSnapshotPushed = false;
  }

  // ---------- Public getters ----------

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ---------- Snapshot recording ----------

  /**
   * Record the current canvas state to the undo stack.
   * Skipped when the stripped snapshot content is identical to the last
   * pushed snapshot — this prevents selection-only changes (which replace
   * the nodes array reference but leave positions/data untouched) from
   * filling the stack with duplicate entries.
   *
   * @returns `true` if a new snapshot was pushed, `false` if deduped.
   */
  takeSnapshot(nodes: Node[], edges: Edge[]): boolean {
    const candidate = createSnapshot(nodes, edges);
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && snapshotsEqual(top, candidate)) return false;

    this.undoStack.push(candidate);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  // ---------- Undo / Redo ----------

  /**
   * Pop the most recent undo snapshot and return it.
   * The current state is pushed to the redo stack.
   * Returns `null` if there is nothing to undo.
   */
  undo(currentNodes: Node[], currentEdges: Edge[]): CanvasSnapshot | null {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return null;

    this.redoStack.push(createSnapshot(currentNodes, currentEdges));
    return {
      ...snapshot,
      nodes: preserveLiveTransient(
        preserveLiveQuestionData(snapshot.nodes, currentNodes),
        currentNodes,
      ),
    };
  }

  /**
   * Pop the most recent redo snapshot and return it.
   * The current state is pushed to the undo stack.
   * Returns `null` if there is nothing to redo.
   */
  redo(currentNodes: Node[], currentEdges: Edge[]): CanvasSnapshot | null {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return null;

    this.undoStack.push(createSnapshot(currentNodes, currentEdges));
    return {
      ...snapshot,
      nodes: preserveLiveTransient(
        preserveLiveQuestionData(snapshot.nodes, currentNodes),
        currentNodes,
      ),
    };
  }

  /** Clear all history (e.g. after loading a new canvas). */
  clear(): void {
    // Clear undo/redo stacks.
    this.undoStack.length = 0;
    this.redoStack.length = 0;

    // Abort any in-flight delete requests and clear the tracking map.
    for (const controller of this.inflightDeletes.values()) {
      controller.abort();
    }
    this.inflightDeletes.clear();
  }

  // ---------- Server-side sync after undo/redo ----------

  /**
   * After an undo/redo restores a snapshot, synchronise the server-side
   * state:
   * - Nodes that reappear → abort any in-flight DELETE, then re-ingest.
   * - Nodes that disappear → fire a DELETE (tracked with AbortController
   *   so a subsequent redo can cancel it).
   */
  syncServerAfterRestore(
    canvasId: string,
    prevNodes: Node[],
    restoredNodes: Node[],
    triggerPreprocessing: TriggerPreprocessingFn,
    mutationOptions?: DeleteNodeMutationOptions,
  ): void {
    const prevIds = new Set(prevNodes.map((n) => n.id));
    const restoredIds = new Set(restoredNodes.map((n) => n.id));

    // Nodes that reappear after undo/redo
    for (const node of restoredNodes) {
      if (!prevIds.has(node.id)) {
        const controller = this.inflightDeletes.get(node.id);
        if (controller) {
          controller.abort();
          this.inflightDeletes.delete(node.id);
        }
        triggerPreprocessing(node);
      }
    }

    // Nodes that disappear after undo/redo
    for (const node of prevNodes) {
      if (!restoredIds.has(node.id)) {
        this.inflightDeletes.get(node.id)?.abort();

        const controller = new AbortController();
        this.inflightDeletes.set(node.id, controller);

        void deleteNode(canvasId, node.id, {
          signal: controller.signal,
          originator: mutationOptions?.originator,
        })
          .then((response) => {
            if (response) mutationOptions?.onResponse?.(canvasId, response);
          })
          .catch((error) => {
            if (error instanceof DOMException && error.name === 'AbortError')
              return;
            console.error(
              'Failed to delete node after undo/redo:',
              node.id,
              error,
            );
            toast(describeDeleteFailure(error), { tone: 'danger' });
          })
          .finally(() => {
            if (this.inflightDeletes.get(node.id) === controller) {
              this.inflightDeletes.delete(node.id);
            }
          });
      }
    }
  }

  // ---------- In-flight delete management (used by onNodesChange) ----------

  /**
   * Track a node deletion with an AbortController so it can be cancelled
   * by a subsequent undo.  Aborts any previous in-flight delete for the
   * same nodeId.  Returns the new AbortController.
   */
  trackDelete(
    canvasId: string,
    nodeId: string,
    mutationOptions?: DeleteNodeMutationOptions,
  ): AbortController {
    this.inflightDeletes.get(nodeId)?.abort();

    const controller = new AbortController();
    this.inflightDeletes.set(nodeId, controller);

    void deleteNode(canvasId, nodeId, {
      signal: controller.signal,
      originator: mutationOptions?.originator,
    })
      .then((response) => {
        if (response) mutationOptions?.onResponse?.(canvasId, response);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
        console.error('Failed to delete node:', nodeId, error);
        toast(describeDeleteFailure(error), { tone: 'danger' });
      })
      .finally(() => {
        if (this.inflightDeletes.get(nodeId) === controller) {
          this.inflightDeletes.delete(nodeId);
        }
      });

    return controller;
  }
}

export class CanvasHistoryRegistry {
  private activeCanvasId: string | null = null;
  private readonly managers = new Map<string, CanvasHistoryManager>();

  private get active(): CanvasHistoryManager {
    const key = this.activeCanvasId ?? '__unbound__';
    let manager = this.managers.get(key);
    if (!manager) {
      manager = new CanvasHistoryManager();
      this.managers.set(key, manager);
    }
    return manager;
  }

  /**
   * Switch history scope. Returning to a previously visited Canvas restores
   * its stacks. Authoritative reload callers may explicitly reset stale stacks.
   */
  activate(canvasId: string, reset = false): void {
    this.activeCanvasId = canvasId;
    if (!this.managers.has(canvasId)) {
      this.managers.set(canvasId, new CanvasHistoryManager());
    }
    if (reset) this.active.clear();
  }

  get gestureSnapshotTaken(): boolean {
    return this.active.gestureSnapshotTaken;
  }

  get canUndo(): boolean {
    return this.active.canUndo;
  }

  get canRedo(): boolean {
    return this.active.canRedo;
  }

  consumeGestureSnapshot(): void {
    this.active.consumeGestureSnapshot();
  }

  markGestureSnapshot(pushed?: boolean): void {
    this.active.markGestureSnapshot(pushed);
  }

  rollbackGestureSnapshot(): void {
    this.active.rollbackGestureSnapshot();
  }

  takeSnapshot(nodes: Node[], edges: Edge[]): boolean {
    return this.active.takeSnapshot(nodes, edges);
  }

  undo(nodes: Node[], edges: Edge[]): CanvasSnapshot | null {
    return this.active.undo(nodes, edges);
  }

  redo(nodes: Node[], edges: Edge[]): CanvasSnapshot | null {
    return this.active.redo(nodes, edges);
  }

  clear(): void {
    this.active.clear();
  }

  clearCanvas(canvasId: string): void {
    this.managers.get(canvasId)?.clear();
  }

  syncServerAfterRestore(
    canvasId: string,
    prevNodes: Node[],
    restoredNodes: Node[],
    triggerPreprocessing: TriggerPreprocessingFn,
    mutationOptions?: DeleteNodeMutationOptions,
  ): void {
    this.active.syncServerAfterRestore(
      canvasId,
      prevNodes,
      restoredNodes,
      triggerPreprocessing,
      mutationOptions,
    );
  }

  trackDelete(
    canvasId: string,
    nodeId: string,
    mutationOptions?: DeleteNodeMutationOptions,
  ): AbortController {
    return this.active.trackDelete(canvasId, nodeId, mutationOptions);
  }
}

/** Canvas-keyed history registry used by the single active canvas store. */
export const canvasHistoryManager = new CanvasHistoryRegistry();
