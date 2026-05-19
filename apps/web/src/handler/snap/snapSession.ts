/**
 * Gesture-scoped drag-time state for the smart-snap engine.
 *
 * Owns the transient cache built by `beginSnapSession` (candidate
 * index, id→node map, absolute-position getter, bypass flag, abort
 * controller for window-level Alt listeners) and the per-frame
 * `applySnap` pass that React Flow drives via `onNodesChange`.
 *
 * ── Why a plain module instead of a Zustand store ──────────────────
 *
 * None of this state is React-reactive:
 *
 *   • No component subscribes to the candidate index, dragged-ids
 *     set, or bypass flag. They're consumed exclusively by command
 *     callbacks (`onNodeDragStart`, `onNodesChange`, `onNodeDragStop`)
 *     and an internal window keyboard listener.
 *   • Pushing them through `set/get` would churn the canvas autosave
 *     middleware many times per frame for purely transient data.
 *   • The visible part — alignment guides — already lives in
 *     `dragPreviewStore`, which IS subscribed by the SVG overlay.
 *     That split is intentional: render state belongs in Zustand,
 *     engine working memory does not.
 *
 * Lifecycle is fully contained within a single drag gesture:
 *
 *   beginSnapSession()  ← onNodeDragStart
 *     applySnap(...)    ← onNodesChange   (every drag tick)
 *     applySnap(...)
 *     ...
 *   endSnapSession()    ← onNodesChange (drag-end commit) OR
 *                         onNodeDragStop (safety net) OR
 *                         Canvas unmount via cancelActiveDrag()
 *
 * `endSnapSession` is idempotent so the "may fire twice" pattern is
 * safe.
 */

import {
  SNAP_MAX_GUIDES_PER_FRAME,
  SNAP_THRESHOLD_SCREEN_PX,
} from '@/config/canvas';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '@/handler/canvasCommand/utils/frame';
import { buildCandidateIndex, computeSnap } from '@/handler/snap/snapEngine';
import { useDragPreviewStore } from '@/store/dragPreviewStore';
import { getNodeSize } from '@/utils/node/size';

import type { SnapIndex } from '@/handler/snap/types';
import type { NodeChange, NodePositionChange, XYPosition } from '@xyflow/react';

/**
 * Candidate index built once per drag from the non-dragged sibling
 * set. `null` when snap is disabled for the gesture (e.g. dragged
 * nodes span multiple parents — see `beginSnapSession`).
 */
let _index: SnapIndex | null = null;

/**
 * Ids currently being dragged. Used by `applySnap` to filter the
 * React Flow change batch down to position updates that belong to
 * the current gesture (e.g. a hover-induced reflow on an unrelated
 * node mid-drag should not move with the snap delta).
 */
let _draggedIds: Set<string> = new Set();

/**
 * Common parent id of the dragged set when all dragged nodes share
 * one (or all are top-level), otherwise `undefined`. Drives the
 * candidate-filter rule that limits snap targets to siblings.
 */
let _parentId: string | undefined = undefined;

/**
 * When true, the Alt key was held at drag-start (or pressed during
 * the drag) — used to bypass snapping for fine-grained positioning.
 */
let _bypass = false;

/**
 * Cached id→node map and absolute-position getter for the duration
 * of a drag. Built once in `beginSnapSession` so the per-frame
 * `applySnap` pass doesn't pay an O(N) `Array.find` and an O(N)
 * `indexById` rebuild for every dragged node every frame.
 *
 * Safe to cache for the lifetime of a drag because:
 *   • Dragged node `size`/`parentId` don't change mid-drag (only
 *     `position`, which we read from the React Flow change object).
 *   • Non-dragged ancestors (parents of dragged nodes) are by
 *     definition outside the dragged set, so their positions stay
 *     put.
 */
let _nodeById: Map<string, NestableNode> | null = null;
let _absPosGetter: ((nodeId: string) => XYPosition | null) | null = null;

/**
 * AbortController bound to every window-level listener attached for
 * the duration of a drag (currently Alt keydown/keyup for bypass).
 *
 * Tracking Alt at window-level (rather than only sampling the
 * drag-start event) lets users press / release Alt mid-drag without
 * dropping the gesture — the same UX Figma offers.
 *
 * Using a single AbortController per gesture instead of separate
 * handler refs is what makes cleanup robust against:
 *
 *   • RF swallowing `onNodeDragStop` (Esc cancel, Alt+Tab during
 *     drag, mid-drag unmount, browser tab hidden) — the *next*
 *     `beginSnapSession` defensively calls `endSnapSession()` and
 *     aborts the stale controller, so leaked listeners can stack at
 *     most one pair deep instead of growing per drag.
 *   • Component unmount — the consumer (Canvas) calls
 *     `endSnapSession()` on teardown via its own store binding.
 */
let _abortController: AbortController | null = null;

export interface BeginSnapSessionOptions {
  /**
   * Snapshot of the canvas nodes at drag-start. Used to build the
   * candidate index and the absolute-position cache. Pass-by-reference
   * is fine; the engine treats this as read-only.
   */
  nodes: NestableNode[];
  /**
   * Ids of the nodes currently being dragged. Snap candidates are
   * filtered to exclude these and any descendants of dragged frames.
   */
  draggedIds: Set<string>;
  /**
   * Whether Alt was held when the drag started. Toggled subsequently
   * by the window-level keyboard listener installed below.
   */
  altPressed: boolean;
}

/**
 * Begin a smart-snap gesture. Always defensively ends any previous
 * session first so leftover state from an aborted gesture (RF
 * swallowed the stop event, component unmounted mid-drag, etc.) can
 * never bleed into the new one.
 *
 * No-op when called in a non-window environment for the listener
 * portion; the snap math still runs.
 */
export function beginSnapSession(opts: BeginSnapSessionOptions): void {
  // Defensive cleanup — see comments above. Cheap when idle.
  endSnapSession();

  const { nodes, draggedIds, altPressed } = opts;

  // One shared id→node index reused by:
  //   • the mixed-parent detection below,
  //   • the absolute-position getter we cache for per-frame snap,
  //   • the snap candidate index (which builds its own getter
  //     internally — keeping it independent so the engine remains a
  //     pure module callable from tests).
  const nodeById = indexById(nodes);

  // Compute the common parent of the dragged set. When all dragged
  // nodes share one parent we restrict snap candidates to siblings
  // inside that frame; otherwise (mixed parents) we disable snap for
  // this gesture to avoid cross-context noise.
  let firstParent: string | null | undefined = undefined;
  let mixedParents = false;
  for (const id of draggedIds) {
    const parent = nodeById.get(id)?.parentId ?? null;
    if (firstParent === undefined) firstParent = parent;
    else if (firstParent !== parent) {
      mixedParents = true;
      break;
    }
  }

  _parentId = mixedParents
    ? undefined
    : ((firstParent ?? undefined) as string | undefined);
  _draggedIds = draggedIds;
  _nodeById = nodeById;
  _absPosGetter = createAbsolutePositionGetter(nodeById);
  _index = mixedParents
    ? null
    : buildCandidateIndex(nodes, draggedIds, _parentId);
  _bypass = altPressed;

  // Attach window-level Alt listeners so users can toggle bypass
  // mid-drag. Bound to a fresh AbortController whose `signal` is
  // passed to every `addEventListener` call — a single
  // `controller.abort()` in `endSnapSession()` detaches all of them
  // (including any future listeners we add here) with zero
  // bookkeeping per listener.
  if (typeof window !== 'undefined') {
    const controller = new AbortController();
    _abortController = controller;
    const { signal } = controller;
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Alt') _bypass = true;
      },
      { signal },
    );
    window.addEventListener(
      'keyup',
      (e: KeyboardEvent) => {
        if (e.key === 'Alt') _bypass = false;
      },
      { signal },
    );
  }
}

/**
 * Tear down every piece of drag-time snap state in one place. Called
 * from three paths that may race:
 *
 *   1. `onNodesChange` when the final `dragging:false` commit
 *      arrives — this is the normal path and runs *after* the snap
 *      delta has been applied to that commit, so the user sees a
 *      clean snapped release. Detected via `isDragEndCommit`.
 *   2. `onNodeDragStop` as an idempotent safety net for paths where
 *      RF swallows the final commit (Esc cancel, mid-drag unmount).
 *   3. Canvas component unmount, via the store's `cancelActiveDrag`.
 *
 * Decoupling cleanup from `onNodeDragStop` is what protects the
 * engine from React Flow's event-ordering. If we cleared snap state
 * inside `onNodeDragStop` *before* the final `onNodesChange`, the
 * release commit would land at the raw cursor position — the exact
 * "looks aligned mid-drag, jumps back on release" symptom we want to
 * prevent.
 *
 * Idempotent: calling repeatedly is a no-op.
 */
export function endSnapSession(): void {
  _index = null;
  _draggedIds = new Set();
  _parentId = undefined;
  _bypass = false;
  _nodeById = null;
  _absPosGetter = null;
  // Aborting the controller detaches every listener registered with
  // its signal in one shot. Safe to call when null (no active drag)
  // or when the controller is already aborted (idempotent).
  _abortController?.abort();
  _abortController = null;
  useDragPreviewStore.getState().clearSnapGuides();
}

/**
 * Cheap predicate the consumer uses to gate the per-frame `applySnap`
 * call. False when no gesture is active OR when the gesture was
 * started with mixed-parent dragged nodes (snap disabled by design).
 */
export function isSnapSessionActive(): boolean {
  return _index !== null && _draggedIds.size > 0;
}

/**
 * Type guard: narrows a generic `NodeChange` to a drag-originated
 * position change.
 *
 * React Flow emits position changes from two distinct sources:
 *   1. `updateNodePositions(dragItems, true)`  — fired per drag tick
 *      with `dragging: true` and the cursor-derived position.
 *   2. `updateNodePositions(dragItems, false)` — fired once on
 *      drag-stop with `dragging: false`, again carrying the
 *      cursor-derived position (NOT the snapped position we wrote
 *      to `node.position` in the last live tick).
 *
 * We must intercept BOTH: if we only snap (1), the commit change in
 * (2) overwrites our snapped position with the raw cursor position,
 * which is exactly the "looks aligned mid-drag, jumps back on
 * release" symptom. Programmatic position changes (from `setNodes`,
 * animations, layout solvers) omit `dragging` entirely (`undefined`)
 * — we leave those untouched.
 */
function isDragPositionChange(c: NodeChange): c is NodePositionChange {
  if (c.type !== 'position') return false;
  const pos = c as NodePositionChange;
  return Boolean(pos.position) && typeof pos.dragging === 'boolean';
}

/**
 * True when `changes` contains the final `dragging:false` commit for
 * any node the current snap session was tracking. Used by the
 * consumer to know when to call `endSnapSession()` at the commit
 * site (so cleanup runs strictly *after* the last snap pass has
 * landed in the store).
 *
 * Returns false when no session is active.
 */
export function isSnapSessionDragEndCommit(changes: NodeChange[]): boolean {
  if (_draggedIds.size === 0) return false;
  return changes.some(
    (c) =>
      c.type === 'position' &&
      (c as NodePositionChange).dragging === false &&
      _draggedIds.has(c.id),
  );
}

/**
 * Apply the smart-snap correction to a batch of React Flow node
 * changes. Pure with respect to the input array (does not mutate);
 * side-effects are limited to pushing guides into `dragPreviewStore`.
 *
 * Algorithm:
 *   1. Pull the proposed new positions out of `changes` (these are
 *      parent-relative — we add the parent's absolute position to
 *      get the source rect in flow-space).
 *   2. Compute the union bounding rect of the dragged set in
 *      absolute flow-space.
 *   3. Hand that rect to `computeSnap`.
 *   4. Add the returned (deltaX, deltaY) to every dragged position
 *      change.
 *   5. Push the resulting guides into `dragPreviewStore` so the
 *      overlay can render them.
 *
 * When the bounding rect cannot be assembled (e.g. dragged nodes
 * not yet measured) the batch is returned untouched and guides are
 * cleared, so behaviour gracefully degrades to no-snap.
 *
 * @param changes The React Flow change batch from `onNodesChange`.
 * @param zoom    Current viewport zoom (from `rfInstance.getZoom()`).
 *                Passed in by the caller to avoid coupling this
 *                module back to the canvas store — the screen→flow
 *                threshold conversion needs it.
 */
export function applySnap(changes: NodeChange[], zoom: number): NodeChange[] {
  if (_index === null) return changes;

  const dragChanges = changes.filter(isDragPositionChange);
  if (dragChanges.length === 0) return changes;

  // Both maps are built once in `beginSnapSession` and stay valid
  // for the whole gesture (dragged nodes' size/parentId don't change
  // mid-drag, and parent positions don't either). If they're missing
  // we degrade to no-snap rather than fall back to a per-frame O(N)
  // scan over the node list.
  const nodeById = _nodeById;
  const getAbs = _absPosGetter;
  if (!nodeById || !getAbs) return changes;

  // Build the source bounding rect in absolute flow-space.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const c of dragChanges) {
    if (!_draggedIds.has(c.id)) continue;
    const node = nodeById.get(c.id);
    if (!node) continue;
    const size = getNodeSize(node);
    if (size.width <= 0 || size.height <= 0) continue;

    const position = c.position;
    if (!position) continue;

    let parentOffset: XYPosition = { x: 0, y: 0 };
    if (node.parentId) {
      const parentAbs = getAbs(node.parentId);
      if (parentAbs) parentOffset = parentAbs;
    }

    const absX = parentOffset.x + position.x;
    const absY = parentOffset.y + position.y;

    minX = Math.min(minX, absX);
    minY = Math.min(minY, absY);
    maxX = Math.max(maxX, absX + size.width);
    maxY = Math.max(maxY, absY + size.height);
  }

  if (!Number.isFinite(minX)) {
    useDragPreviewStore.getState().clearSnapGuides();
    return changes;
  }

  // Convert the screen-space threshold to flow-space using the
  // current viewport zoom (so the perceived snap radius stays
  // constant regardless of zoom level).
  const thresholdFlow = SNAP_THRESHOLD_SCREEN_PX / Math.max(zoom, 0.0001);

  const sourceRect = {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
  const result = computeSnap(sourceRect, _index, {
    thresholdFlow,
    bypass: _bypass,
  });

  // Push guides into the overlay store (sliced to the per-frame cap).
  useDragPreviewStore
    .getState()
    .setSnapGuides(result.guides.slice(0, SNAP_MAX_GUIDES_PER_FRAME));

  if (result.deltaX === 0 && result.deltaY === 0) return changes;

  return changes.map((c) => {
    if (!isDragPositionChange(c)) return c;
    if (!_draggedIds.has(c.id)) return c;
    const position = c.position;
    if (!position) return c;
    return {
      ...c,
      position: {
        x: position.x + result.deltaX,
        y: position.y + result.deltaY,
      },
    };
  });
}
