import { deleteNode } from '../api';

import type { RecentAction } from '@sediment/shared';
import type { Node, Edge } from '@xyflow/react';

const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of the canvas for undo / redo.
 *  Contains nodes and edges with ReactFlow internals
 *  (`selected`, `dragging`, `measured`, `internals`) stripped out. */
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
 * ingestion for nodes that reappear after undo/redo.
 */
export type TriggerIngestionFn = (node: Node) => void;

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Strip ReactFlow transient internals (selected, dragging, measured,
 *  internals) while preserving all other props (draggable, zIndex, extent,
 *  etc.) that are actively managed by the app. */
export function createSnapshot(nodes: Node[], edges: Edge[]): CanvasSnapshot {
  return {
    nodes: nodes.map(
      ({ selected: _, dragging: _d, measured: _m, ...rest }) => rest,
    ),
    edges: edges.map(({ selected: _, ...rest }) => rest),
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

  get gestureSnapshotTaken(): boolean {
    return this._gestureSnapshotTaken;
  }

  /** Mark that a gesture snapshot was consumed by the executor. */
  consumeGestureSnapshot(): void {
    this._gestureSnapshotTaken = false;
  }

  /** Mark that a caller-managed snapshot was taken for the upcoming command. */
  markGestureSnapshot(): void {
    this._gestureSnapshotTaken = true;
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
   */
  takeSnapshot(nodes: Node[], edges: Edge[]): void {
    const candidate = createSnapshot(nodes, edges);
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && snapshotsEqual(top, candidate)) return;

    this.undoStack.push(candidate);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
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
    return snapshot;
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
    return snapshot;
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
    triggerIngestion: TriggerIngestionFn,
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
        triggerIngestion(node);
      }
    }

    // Nodes that disappear after undo/redo
    for (const node of prevNodes) {
      if (!restoredIds.has(node.id)) {
        this.inflightDeletes.get(node.id)?.abort();

        const controller = new AbortController();
        this.inflightDeletes.set(node.id, controller);

        void deleteNode(canvasId, node.id, { signal: controller.signal })
          .catch((error) => {
            if (error instanceof DOMException && error.name === 'AbortError')
              return;
            console.error(
              'Failed to delete node after undo/redo:',
              node.id,
              error,
            );
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
  trackDelete(canvasId: string, nodeId: string): AbortController {
    this.inflightDeletes.get(nodeId)?.abort();

    const controller = new AbortController();
    this.inflightDeletes.set(nodeId, controller);

    void deleteNode(canvasId, nodeId, { signal: controller.signal })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
        console.error('Failed to delete node:', nodeId, error);
      })
      .finally(() => {
        if (this.inflightDeletes.get(nodeId) === controller) {
          this.inflightDeletes.delete(nodeId);
        }
      });

    return controller;
  }
}

/** Singleton instance used by the canvas store. */
export const canvasHistoryManager = new CanvasHistoryManager();
