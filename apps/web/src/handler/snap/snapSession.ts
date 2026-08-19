// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Gesture-scoped state for the smart-snap engine (covers both drag
 * and single-node resize).
 *
 * Owns the transient cache built by `beginSnapSession` (candidate
 * index, id→node map, absolute-position getter, bypass flag, abort
 * controller for window-level Alt listeners) and the per-frame
 * snap pass that downstream consumers invoke:
 *
 *   • Drag      — `applySnap(changes, zoom)` rewrites the React Flow
 *                 `NodeChange[]` batch on each `onNodesChange`.
 *   • Resize    — `applyResizeProposal(rawLocal, zoom)` is called
 *                 from `NodeWrapper.handleResize` (which fires
 *                 *before* RF emits its NodeChange batch — see
 *                 XYResizer drag callback in @xyflow/system). It
 *                 derives `activeEdges` from the cached start rect,
 *                 runs the snap engine, anchors the non-moving edge,
 *                 caches the snapped result, and returns it so the
 *                 child auto-fit listener (e.g. text font-size) gets
 *                 the snapped values immediately. `applySnap` then
 *                 reads that cache to REWRITE the dim/pos changes RF
 *                 emits for the resize node, so a single
 *                 `applyNodeChanges` write delivers the snapped
 *                 geometry to the store — no inline `setState` from
 *                 the wrapper, no double-write per frame.
 *
 * ── Why a plain module instead of a Zustand store ──────────────────
 *
 * None of this state is React-reactive:
 *
 *   • No component subscribes to the candidate index, gesture-ids
 *     set, or bypass flag. They're consumed exclusively by command
 *     callbacks (`onNodeDragStart`, `onNodesChange`, `onNodeDragStop`,
 *     `NodeWrapper.handleResize*`) and an internal window keyboard
 *     listener.
 *   • Pushing them through `set/get` would churn the canvas autosave
 *     middleware many times per frame for purely transient data.
 *   • The visible part — alignment guides — already lives in
 *     `gesturePreviewStore`, which IS subscribed by the SVG overlay.
 *     That split is intentional: render state belongs in Zustand,
 *     engine working memory does not.
 *
 * Lifecycle is fully contained within a single gesture:
 *
 *   beginSnapSession()  ← onNodeDragStart / handleResizeStart
 *     applySnap(...)            ← drag tick (RF NodeChange[])
 *     computeSnapForRect(...)   ← resize tick (NodeWrapper)
 *     ...
 *   endSnapSession()    ← dragging:false / resizing:false commit OR
 *                         onNodeDragStop / handleResizeEnd (safety) OR
 *                         Canvas unmount via endActiveDragSession()
 *
 * `endSnapSession` is idempotent so the "may fire twice" pattern is
 * safe.
 */

import {
  createAbsolutePositionGetter,
  indexById,
  getNodeSize,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import {
  SNAP_MAX_GUIDES_PER_FRAME,
  SNAP_THRESHOLD_SCREEN_PX,
} from '@/config/canvas';
import { buildCandidateIndex, computeSnap } from '@/handler/snap/snapEngine';
import { isEditableTarget } from '@/hooks/shortcuts/isEditableTarget';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import type { ActiveEdges, Rect, SnapIndex } from '@/handler/snap/types';
import type {
  NodeChange,
  NodeDimensionChange,
  NodePositionChange,
  XYPosition,
} from '@xyflow/react';

/** Which gesture is currently driving the snap session. */
export type GestureKind = 'drag' | 'resize';

/**
 * Pre-resize geometry captured at `handleResizeStart`. Stable for
 * the entire gesture: the resized node's bounds in absolute
 * flow-space (`startRect`), the resized node's pre-resize local
 * position (so `applySnap` can detect whether snap moved it without
 * a sentinel comparison), and the parent's absolute offset (used to
 * convert per-frame proposals from local → absolute before feeding
 * the snap engine).
 */
export type ResizeContext = {
  nodeId: string;
  startRect: Rect;
  startLocalPos: XYPosition;
  parentOffset: XYPosition;
  /**
   * When `true`, the node's width/height ratio is locked (media
   * nodes rendered with `keepAspectRatio` — image/video). Smart-snap
   * would otherwise nudge a single edge and break the ratio, which
   * shows up as letterboxing (empty bars) for `object-contain`
   * content and drifts the screen-space selection outline off the
   * node box. `applyResizeProposal` skips snapping entirely for these
   * nodes so the committed size stays exactly proportional.
   */
  lockAspect?: boolean;
};

/**
 * Candidate index built once per gesture from the non-gesture sibling
 * set. `null` when snap is disabled for the gesture (e.g. dragged
 * nodes span multiple parents — see `beginSnapSession`).
 */
let _index: SnapIndex | null = null;

/**
 * Ids currently participating in the gesture (dragged or resized).
 * Used by `applySnap` to filter the React Flow change batch down to
 * updates that belong to the current gesture (e.g. a hover-induced
 * reflow on an unrelated node mid-drag should not move with the snap
 * delta).
 */
let _gestureIds: Set<string> = new Set();

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
 * When true, Space is currently held during a drag — used to bypass
 * auto-reparenting (entering / leaving frames) so the user can
 * reposition a node freely without changing parent membership. This
 * is the "opt out of auto reparent" gesture, matching common canvas-editor
 * Space-drag semantics. Always false outside an active drag session.
 */
let _reparentBypassed = false;

/** Whether Cmd (macOS) or Ctrl (Windows/Linux) allows nested Frame entry. */
let _nestedFrameEntryAllowed = false;

/**
 * Snapshot taken inside `endSnapSession` so `onNodeDragStop` can
 * still recover decisions / flags that lived in the active session.
 * The teardown order is normally `onNodesChange` → `endSnapSession`
 * → `onNodeDragStop`, so the stop handler reads from this slot
 * after the active session has already been wiped. Cleared on
 * single-read via the `consumeLast*` accessors so a follow-up drag
 * cannot inherit stale values.
 *
 * `null` outside the window between teardown and the stop event.
 */
interface LastEndedSnapshot {
  /** Space-bypass state at the moment the gesture ended. */
  reparentBypass: boolean;
  /** Cmd/Ctrl nested-Frame entry state when the gesture ended. */
  nestedFrameEntryAllowed: boolean;
  /** Per-node frame-membership decisions from the last preview tick. */
  dragDecisions: Map<string, DragDecision> | null;
}
let _lastEnded: LastEndedSnapshot | null = null;

/**
 * Per-dragged-node frame-membership decision captured by the live
 * preview tick (`onNodeDrag` rAF callback). The drop resolver reads
 * this map at `onNodeDragStop` and uses it verbatim — bypassing its
 * own `wouldUnframe` / `wouldAutoFrame` recomputation — so the
 * committed result always matches the **last rendered preview** the
 * user saw, even when smart-snap rewrote the dragged node's
 * position or the mouseup pointer drifted a few pixels past the
 * halo edge in the ≤16 ms between the last `rAF` tick and release.
 *
 * The cache is the single source of truth for "did the gesture
 * cross a frame boundary?" — every other input (current store
 * positions, mouseup pointer, halo math) is ignored when the
 * decision exists. See the WYSIWYG argument in the design doc.
 */
export interface DragDecision {
  /**
   * True iff the dragged node should detach from its current
   * parent at drop-time. `false` means "stay parented" (the
   * pointer-halo / overlap test said the node belongs in its
   * current frame).
   *
   * Only meaningful when the node had a parent at preview time —
   * otherwise the field is `false`.
   */
  unframe: boolean;
  /**
   * Frame id the dragged node should enter at drop-time, or `null`
   * when no entry was decided. Covers both root → frame and
   * cross-frame moves. The resolver trusts this value over its own
   * `findBestFrameForNode` recomputation.
   */
  enterFrameId: string | null;
}

/**
 * Working cache for the active drag — written every `rAF` tick of
 * `onNodeDrag` via {@link writeDragDecision}, cleared at the start
 * of each tick via {@link clearDragDecisions}. Held here (not in
 * Zustand) for the same reason as the rest of the snap-session
 * state: no component subscribes, so passing it through React
 * state would churn the autosave middleware many times per second.
 *
 * Becomes `null` outside an active drag. The atomic "clear then
 * re-write inside one rAF tick" pattern guarantees the cache always
 * reflects the latest fully-computed preview frame — never a
 * partial mix of two ticks.
 */
let _dragDecisions: Map<string, DragDecision> | null = null;

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
 * the duration of a gesture (currently Alt keydown/keyup for bypass).
 *
 * Tracking Alt at window-level (rather than only sampling the
 * gesture-start event) lets users press / release Alt mid-gesture
 * without dropping it — the same UX professional canvas editors offer.
 *
 * Using a single AbortController per gesture instead of separate
 * handler refs is what makes cleanup robust against:
 *
 *   • RF swallowing `onNodeDragStop` (Esc cancel, Alt+Tab during
 *     drag, mid-drag unmount, browser tab hidden) — the *next*
 *     `beginSnapSession` defensively calls `endSnapSession()` and
 *     aborts the stale controller, so leaked listeners can stack at
 *     most one pair deep instead of growing per gesture.
 *   • Component unmount — the consumer (Canvas) calls
 *     `endSnapSession()` on teardown via its own store binding.
 */
let _abortController: AbortController | null = null;

function invalidateFrameDragPreview(): void {
  clearDragDecisions();
  _structuredSuppressed = false;
  const preview = useGesturePreviewStore.getState();
  preview.clearFrameFitPreview();
  preview.clearStructuredDropPreview();
  preview.clearNodeGeometryPreviews();
}

function setNestedFrameEntryAllowed(allowed: boolean): void {
  if (_nestedFrameEntryAllowed === allowed) return;
  _nestedFrameEntryAllowed = allowed;
  invalidateFrameDragPreview();
}

/**
 * Which gesture is driving the session. Default `'drag'` matches
 * the historical behaviour for callers that don't pass `kind`.
 * `'resize'` enables the dim/pos suppression branch in `applySnap`
 * and switches the equal-spacing default off.
 */
let _kind: GestureKind = 'drag';

/**
 * When `true`, the drag path in `applySnap` skips both the snap delta
 * and the alignment guides. Set per drag tick by the canvas store when
 * the dragged node currently hovers a structured (column / row / grid) frame:
 * there the drop position is decided by the layout solver, not free
 * placement, so smart-alignment guides would point at positions the
 * node will never actually land on. The structured drop ghost takes
 * over the visual feedback instead. Reset on session end.
 */
let _structuredSuppressed = false;

/**
 * Per-resize-gesture context captured at `handleResizeStart`. Holds
 * the pre-resize bounds + parent offset for the single resized node.
 * `null` outside a resize session.
 */
let _resizeContext: ResizeContext | null = null;

/**
 * Cache of the most recent per-frame snap result for the active
 * resize gesture, in node-local coordinates (what RF expects to
 * receive in NodeChanges). Written by `applyResizeProposal` each
 * frame, read by `applySnap` (to rewrite RF's dim/pos changes) and
 * by `getResizeSnappedRect` (to commit on resize-end). `null` until
 * the first proposal arrives, or outside a resize session.
 */
let _lastResizeSnapped: {
  local: XYPosition;
  size: { width: number; height: number };
} | null = null;

export interface BeginSnapSessionOptions {
  /**
   * Snapshot of the canvas nodes at gesture-start. Used to build the
   * candidate index and the absolute-position cache. Pass-by-reference
   * is fine; the engine treats this as read-only.
   */
  nodes: NestableNode[];
  /**
   * Ids of the nodes participating in this gesture (dragged set, or
   * the single resized node). Snap candidates are filtered to
   * exclude these and any descendants of gestured frames.
   */
  gestureIds: Set<string>;
  /**
   * Whether Alt was held when the gesture started. Toggled
   * subsequently by the window-level keyboard listener installed
   * below.
   */
  altPressed: boolean;
  /** Whether Cmd/Ctrl was held when the drag started. */
  nestedFrameEntryAllowed?: boolean;
  /**
   * Gesture kind. Defaults to `'drag'` for backward compatibility
   * with the original drag-only call sites.
   */
  kind?: GestureKind;
  /**
   * Required when `kind === 'resize'`. Pre-resize bounds for the
   * single resized node in absolute flow-space, plus the parent's
   * absolute offset (stable for the duration of the gesture). The
   * engine uses this to derive `activeEdges` by diffing each
   * proposed rect against the start rect, and to cache the snapped
   * result so the commit at `handleResizeEnd` doesn't need to
   * re-derive anything.
   *
   * Ignored when `kind === 'drag'`.
   */
  resizeContext?: ResizeContext;
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

  const {
    nodes,
    gestureIds,
    altPressed,
    kind = 'drag',
    resizeContext,
    nestedFrameEntryAllowed = false,
  } = opts;

  // One shared id→node index reused by:
  //   • the mixed-parent detection below,
  //   • the absolute-position getter we cache for per-frame snap,
  //   • the snap candidate index (which builds its own getter
  //     internally — keeping it independent so the engine remains a
  //     pure module callable from tests).
  const nodeById = indexById(nodes);

  // Compute the common parent of the gesture set. When all gesture
  // nodes share one parent we restrict snap candidates to siblings
  // inside that frame; otherwise (mixed parents) we disable snap for
  // this gesture to avoid cross-context noise. Resize always has a
  // single node so this resolves to the resized node's own parent.
  let firstParent: string | null | undefined = undefined;
  let mixedParents = false;
  for (const id of gestureIds) {
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
  _gestureIds = gestureIds;
  _nodeById = nodeById;
  _absPosGetter = createAbsolutePositionGetter(nodeById);
  _index = mixedParents
    ? null
    : buildCandidateIndex(nodes, gestureIds, _parentId);
  _bypass = altPressed;
  _nestedFrameEntryAllowed = nestedFrameEntryAllowed;
  _kind = kind;
  // Resize-only state. Callers that pass `kind: 'resize'` MUST also
  // pass `resizeContext`; we don't synthesise it from `nodes` because
  // the start rect must be captured from RF's resize handle params,
  // not from the (already mutating mid-gesture) store state.
  _resizeContext = kind === 'resize' ? (resizeContext ?? null) : null;
  _lastResizeSnapped = null;
  // Reset drag-decision caches for a fresh gesture. Both the working
  // cache (written by every rAF tick) and the post-gesture snapshot
  // (consumed by `onNodeDragStop`) must start empty so a previous
  // drag's decisions can never bleed into this one.
  _dragDecisions = null;
  _lastEnded = null;

  // Flip a body-level class for the duration of a resize gesture.
  // The frame node CSS uses this to suppress its `width/height`
  // auto-layout smoothing transition (~200ms ease-out) — otherwise
  // the frame body visibly lags behind the resize handle and
  // selection outline during the gesture.
  if (kind === 'resize' && typeof document !== 'undefined') {
    document.body.classList.add('canvas-resize-active');
  }

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
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Meta' || e.key === 'Control') {
          setNestedFrameEntryAllowed(true);
        }
      },
      { signal },
    );
    window.addEventListener(
      'keyup',
      (e: KeyboardEvent) => {
        if (e.key === 'Meta' || e.key === 'Control') {
          setNestedFrameEntryAllowed(e.key === 'Meta' ? e.ctrlKey : e.metaKey);
        }
      },
      { signal },
    );
    // Space-while-dragging opts out of auto-reparenting (entering /
    // leaving frames). `preventDefault` swallows the native scroll
    // and stops the canvas's global Space-to-pan shortcut from
    // switching tools mid-drag — Space's drag-context interpretation
    // takes precedence. Outside a drag, the global listener still
    // owns Space.
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (
          (e.key === ' ' || e.code === 'Space') &&
          !isEditableTarget(e.target)
        ) {
          _reparentBypassed = true;
          e.preventDefault();
        }
      },
      { signal },
    );
    window.addEventListener(
      'keyup',
      (e: KeyboardEvent) => {
        if (
          (e.key === ' ' || e.code === 'Space') &&
          !isEditableTarget(e.target)
        ) {
          _reparentBypassed = false;
          e.preventDefault();
        }
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
 *   3. Canvas component unmount, via the store's `endActiveDragSession`.
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
  _gestureIds = new Set();
  _parentId = undefined;
  _bypass = false;
  _nodeById = null;
  _absPosGetter = null;
  _kind = 'drag';
  _resizeContext = null;
  _lastResizeSnapped = null;
  _structuredSuppressed = false;
  // Snapshot the post-teardown state (Space-bypass flag + per-node
  // drag decisions) into a single slot for `onNodeDragStop` to read
  // *after* this teardown runs (typical order: `onNodesChange` →
  // `endSnapSession` → `onNodeDragStop`). The stop handler consumes
  // this slot via `consumeLast*` accessors which clear it on read,
  // so the next gesture starts fresh.
  _lastEnded = {
    reparentBypass: _reparentBypassed,
    nestedFrameEntryAllowed: _nestedFrameEntryAllowed,
    dragDecisions: _dragDecisions,
  };
  _reparentBypassed = false;
  _nestedFrameEntryAllowed = false;
  _dragDecisions = null;
  // Drop the resize-gesture marker (idempotent — safe when not set).
  if (typeof document !== 'undefined') {
    document.body.classList.remove('canvas-resize-active');
  }
  // Aborting the controller detaches every listener registered with
  // its signal in one shot. Safe to call when null (no active drag)
  // or when the controller is already aborted (idempotent).
  _abortController?.abort();
  _abortController = null;
  useGesturePreviewStore.getState().clearSnapGuides();
}

/**
 * Cheap predicate the consumer uses to gate the per-frame snap
 * call. False when no gesture is active OR when the gesture was
 * started with mixed-parent dragged nodes (snap disabled by design).
 */
export function isSnapSessionActive(): boolean {
  return _index !== null && _gestureIds.size > 0;
}

/**
 * Toggle structured-frame snap suppression for the active drag. Called
 * every drag tick by the canvas store: `true` while the dragged node
 * hovers a column / row / grid frame (solver decides the slot, so alignment
 * guides are misleading), `false` otherwise. No-op outside a drag
 * session; always reset by `endSnapSession`.
 */
export function setSnapStructuredSuppressed(suppressed: boolean): void {
  _structuredSuppressed = suppressed;
}

/**
 * True while the user is holding Space during an active drag —
 * meaning auto-reparenting (entering / leaving frames) should be
 * skipped for this gesture. Mirrors the common Space-drag opt-out.
 * Always false outside a drag session.
 */
export function isReparentBypassed(): boolean {
  return _reparentBypassed;
}

/** True while Cmd/Ctrl explicitly requests entry into a nested Frame. */
export function isNestedFrameEntryAllowed(): boolean {
  return _nestedFrameEntryAllowed;
}

/**
 * Read-and-clear accessor for the post-`endSnapSession` snapshot of
 * `_reparentBypassed`. Use this from `onNodeDragStop` (which fires
 * *after* `endSnapSession`) to recover the value the user pressed
 * before release. Returns `false` outside a just-ended drag.
 */
export function consumeLastDragReparentBypass(): boolean {
  const v = _lastEnded?.reparentBypass ?? false;
  if (_lastEnded) _lastEnded.reparentBypass = false;
  return v;
}

/** Read and clear the Cmd/Ctrl state captured when the drag ended. */
export function consumeLastNestedFrameEntryAllowed(): boolean {
  const value = _lastEnded?.nestedFrameEntryAllowed ?? false;
  if (_lastEnded) _lastEnded.nestedFrameEntryAllowed = false;
  return value;
}

/**
 * Record the live preview's frame-membership decision for one
 * dragged node. Called from `canvasStore.onNodeDrag` inside the
 * `rAF` tick that just finished computing the per-node
 * `wouldUnframe` / `wouldAutoFrame` predicates — the cache is
 * cleared via {@link clearDragDecisions} at the start of the same
 * tick so multi-node drags always commit a coherent snapshot.
 *
 * No-op outside an active drag (the cache stays `null` so
 * `consumeLastDragDecisions` returns `null` and the resolver
 * falls back to fresh recomputation).
 */
export function writeDragDecision(
  nodeId: string,
  decision: DragDecision,
): void {
  if (!_dragDecisions) _dragDecisions = new Map();
  _dragDecisions.set(nodeId, decision);
}

/**
 * Wipe the working drag-decision cache. Call from the `rAF` tick
 * *before* re-writing per-node decisions so a node that no longer
 * has a decision (e.g. removed from the dragged set, or now in a
 * Space-bypass state) can't carry forward a stale entry from the
 * previous tick.
 */
export function clearDragDecisions(): void {
  _dragDecisions = null;
}

/**
 * Read-and-clear accessor for the post-`endSnapSession` snapshot of
 * `_dragDecisions`. Returns `null` (not an empty map) when no
 * decisions were recorded — distinguishing "preview ran and decided
 * nothing for this drag" from "preview never ran" so the resolver
 * can pick the right fallback. Single-read by design: the cache
 * belongs to one drop event and a follow-up drag must not see it.
 */
export function consumeLastDragDecisions(): Map<string, DragDecision> | null {
  const v = _lastEnded?.dragDecisions ?? null;
  if (_lastEnded) _lastEnded.dragDecisions = null;
  return v;
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
 * Returns false when no session is active OR when the active
 * session is a resize (resize uses `isSnapSessionResizeEndCommit`).
 */
export function isSnapSessionDragEndCommit(changes: NodeChange[]): boolean {
  if (_kind !== 'drag') return false;
  if (_gestureIds.size === 0) return false;
  return changes.some(
    (c) =>
      c.type === 'position' &&
      (c as NodePositionChange).dragging === false &&
      _gestureIds.has(c.id),
  );
}

/**
 * True when `changes` contains the final `resizing:false` commit
 * for any node the current resize session is tracking. Mirror of
 * `isSnapSessionDragEndCommit` for the resize lifecycle.
 *
 * Returns false when no session is active OR when the active
 * session is a drag.
 */
export function isSnapSessionResizeEndCommit(changes: NodeChange[]): boolean {
  if (_kind !== 'resize') return false;
  if (_gestureIds.size === 0) return false;
  return changes.some(
    (c) =>
      c.type === 'dimensions' &&
      (c as NodeDimensionChange).resizing === false &&
      _gestureIds.has(c.id),
  );
}

/**
 * Shared per-frame snap evaluator. Consumed by:
 *
 *   • `applySnap` for drag (passes the union bbox of the dragged set,
 *     activeEdges `{ both, both }`).
 *   • `NodeWrapper.handleResize` for single-node resize (passes the
 *     proposed post-resize rect, activeEdges narrowed to the
 *     actually-moving edge).
 *
 * Writes the resulting guides into `gesturePreviewStore` as a side
 * effect so the SVG overlay picks them up. Returns zero deltas and
 * clears guides when no session is active — callers can call this
 * unconditionally without a separate `isSnapSessionActive` check
 * (kept cheap: the bypass branch in `computeSnap` returns early).
 *
 * Equal-spacing detection is silently disabled for resize sessions
 * because its geometry assumes the whole rect moves — a single
 * growing edge would otherwise produce confusing "≡" guides that
 * compete with the obvious edge-alignment intent.
 */
export function computeSnapForRect(
  rect: Rect,
  activeEdges: ActiveEdges,
  zoom: number,
): { deltaX: number; deltaY: number } {
  if (_index === null) {
    useGesturePreviewStore.getState().clearSnapGuides();
    return { deltaX: 0, deltaY: 0 };
  }
  const thresholdFlow = SNAP_THRESHOLD_SCREEN_PX / Math.max(zoom, 0.0001);
  const result = computeSnap(rect, _index, {
    thresholdFlow,
    bypass: _bypass,
    activeEdges,
    // Resize callers should never see equal-spacing guides — they
    // assume the rect moves rigidly, which it doesn't during an
    // edge-handle resize.
    enableEqualSpacing: _kind === 'drag',
  });
  useGesturePreviewStore
    .getState()
    .setSnapGuides(result.guides.slice(0, SNAP_MAX_GUIDES_PER_FRAME));
  return { deltaX: result.deltaX, deltaY: result.deltaY };
}

export function applySnap(changes: NodeChange[], zoom: number): NodeChange[] {
  if (_index === null) return changes;

  if (_kind === 'resize') {
    // Resize path: `applyResizeProposal` (called by
    // `NodeWrapper.handleResize` earlier in the same XYResizer drag
    // tick — see XYResizer in @xyflow/system which fires `onResize`
    // before `onChange`) has cached the snapped local rect in
    // `_lastResizeSnapped`. We rewrite RF's raw dim/pos changes for
    // the resize node to use those snapped values, so the single
    // `applyNodeChanges` write that lands in the store delivers a
    // pre-snapped geometry. Non-tracked changes pass through, and the
    // final `resizing:false` flag is preserved so end-of-gesture
    // detection still works.
    //
    // Drop child position changes that XYResizer auto-emits during
    // a non-BR-handle drag (TL/T/L/TR/BL): the underlying
    // `@xyflow/system` XYResizer translates direct children by
    // `-(x_new - x_prev)` every tick so they stay visually stationary
    // in absolute space (pure-translation model). For frame nodes we
    // instead want children to SCALE proportionally with the frame
    // (handled by `applyFrameResizeScale` → RESIZE_NODE → setNodeGeometry),
    // so the auto-translate emissions must be filtered out — otherwise
    // `applyNodeChanges` overwrites our scaled child positions in the
    // same tick and the children visually misalign while the user
    // drags a non-BR handle.
    //
    // Filter by `c.id !== ctx.nodeId`: during a resize gesture, the
    // only position changes that reach onNodesChange are XYResizer's
    // own emissions for the resized node + its direct children. ResizeObserver
    // emits dimension changes (not position), and no drag can run
    // concurrently with a resize.
    const ctx = _resizeContext;
    const snapped = _lastResizeSnapped;
    if (!ctx) return changes;
    if (!snapped) return changes;
    const filtered = changes.filter(
      (c) => !(c.type === 'position' && 'id' in c && c.id !== ctx.nodeId),
    );
    return filtered.map((c) => {
      if (!('id' in c) || c.id !== ctx.nodeId) return c;
      if (c.type === 'dimensions') {
        const dim = c as NodeDimensionChange;
        if (!dim.dimensions) return c;
        return {
          ...dim,
          dimensions: {
            width: snapped.size.width,
            height: snapped.size.height,
          },
        } satisfies NodeDimensionChange;
      }
      if (c.type === 'position') {
        const pos = c as NodePositionChange;
        if (!pos.position) return c;
        return {
          ...pos,
          position: { x: snapped.local.x, y: snapped.local.y },
        } satisfies NodePositionChange;
      }
      return c;
    });
  }

  // ── Drag path ────────────────────────────────────────────────────
  // Structured-frame target: the layout solver picks the final slot, so
  // free-alignment snapping (and its guides) would be misleading. Skip
  // both — the structured drop ghost is the feedback there instead.
  if (_structuredSuppressed) {
    useGesturePreviewStore.getState().clearSnapGuides();
    return changes;
  }

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
    if (!_gestureIds.has(c.id)) continue;
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
    useGesturePreviewStore.getState().clearSnapGuides();
    return changes;
  }

  const { deltaX, deltaY } = computeSnapForRect(
    { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    { x: 'both', y: 'both' },
    zoom,
  );

  if (deltaX === 0 && deltaY === 0) return changes;

  return changes.map((c) => {
    if (!isDragPositionChange(c)) return c;
    if (!_gestureIds.has(c.id)) return c;
    const position = c.position;
    if (!position) return c;
    return {
      ...c,
      position: {
        x: position.x + deltaX,
        y: position.y + deltaY,
      },
    };
  });
}

/**
 * Per-frame resize handler called by `NodeWrapper.handleResize` with
 * RF's raw NodeResizer proposal (node-local coordinates).
 *
 * Pipeline:
 *
 *   1. Convert local → absolute using the cached `parentOffset`.
 *   2. Diff against the cached `startRect` (eps = 0.5 px) to derive
 *      which edge(s) are moving this frame — only the active edge(s)
 *      participate in the snap probe so e.g. dragging the right
 *      handle never snaps the left edge.
 *   3. Run `computeSnapForRect` to get a correction delta and push
 *      alignment guides into `gesturePreviewStore`.
 *   4. Anchor the non-moving edge: `'min'` shifts position by the
 *      delta and shrinks size by the same amount; `'max'` grows size
 *      only. `'none'` means no edge moved enough to register or both
 *      flags fired (treated as a no-op rather than guessing an anchor
 *      — see the active-edges derivation below).
 *   5. Cache the snapped local rect in `_lastResizeSnapped` so the
 *      subsequent `applySnap` call (later in the same XYResizer
 *      drag tick, when RF emits its NodeChange batch) rewrites
 *      RF's raw dim/pos changes with the snapped values.
 *   6. Return the snapped local rect so the caller can forward the
 *      snapped width/height to the child auto-fit listener (e.g.
 *      text font-size) without a 1-frame lag.
 *
 * No-op (returns the input unchanged) when no resize session is
 * active or the snap index was disabled (e.g. parent context
 * inconsistent at gesture start).
 */
export function applyResizeProposal(
  rawLocal: { x: number; y: number; width: number; height: number },
  zoom: number,
): { x: number; y: number; width: number; height: number } {
  const ctx = _resizeContext;
  if (_kind !== 'resize' || !ctx) return rawLocal;

  // Aspect-locked media (image / video) must never be distorted. Normalise
  // the proposal here instead of relying solely on xyflow's
  // `keepAspectRatio`: this is the canonical rectangle consumed by the live
  // preview, the RF change mirror, and the resize-end commit. The axis with
  // the larger relative change represents the user's drag intent; derive the
  // other axis from the gesture-start ratio. Per-axis snapping is skipped
  // because it would immediately break that ratio again.
  if (ctx.lockAspect) {
    useGesturePreviewStore.getState().clearSnapGuides();
    const widthScale = rawLocal.width / ctx.startRect.w;
    const heightScale = rawLocal.height / ctx.startRect.h;
    const widthChanged = Math.abs(widthScale - 1);
    const heightChanged = Math.abs(heightScale - 1);
    const size =
      widthChanged >= heightChanged
        ? {
            width: rawLocal.width,
            height: rawLocal.width * (ctx.startRect.h / ctx.startRect.w),
          }
        : {
            width: rawLocal.height * (ctx.startRect.w / ctx.startRect.h),
            height: rawLocal.height,
          };
    _lastResizeSnapped = {
      local: { x: rawLocal.x, y: rawLocal.y },
      size,
    };
    return { x: rawLocal.x, y: rawLocal.y, ...size };
  }

  const absX = ctx.parentOffset.x + rawLocal.x;
  const absY = ctx.parentOffset.y + rawLocal.y;

  // 0.5 flow-px tolerance prevents floating-point noise on the
  // non-moving edge from registering as movement. The active-edge
  // narrowing is what makes the engine ignore alignment targets on
  // the static edge during edge-handle resizes.
  //
  // We deliberately do NOT model a `'both'` outcome here: every
  // physical NodeResizer handle (edge OR corner) moves at most ONE
  // edge per axis, and XYResizer pins the static edge to its
  // start-of-gesture value so it cannot drift. If both flags ever
  // register on the same axis it would mean a malformed proposal —
  // we treat that as `'none'` (skip snap on that axis) rather than
  // guess at an anchor and risk mis-applying the delta.
  const eps = 0.5;
  const minXMoved = Math.abs(absX - ctx.startRect.x) > eps;
  const maxXMoved =
    Math.abs(absX + rawLocal.width - (ctx.startRect.x + ctx.startRect.w)) > eps;
  const minYMoved = Math.abs(absY - ctx.startRect.y) > eps;
  const maxYMoved =
    Math.abs(absY + rawLocal.height - (ctx.startRect.y + ctx.startRect.h)) >
    eps;

  const activeX: ActiveEdges['x'] =
    minXMoved && !maxXMoved ? 'min' : !minXMoved && maxXMoved ? 'max' : 'none';
  const activeY: ActiveEdges['y'] =
    minYMoved && !maxYMoved ? 'min' : !minYMoved && maxYMoved ? 'max' : 'none';

  // computeSnapForRect side-effects guides into gesturePreviewStore and
  // returns zero deltas when no candidate is in range or bypass is on.
  const { deltaX, deltaY } = computeSnapForRect(
    { x: absX, y: absY, w: rawLocal.width, h: rawLocal.height },
    { x: activeX, y: activeY },
    zoom,
  );

  let snappedX = rawLocal.x;
  let snappedY = rawLocal.y;
  let snappedW = rawLocal.width;
  let snappedH = rawLocal.height;

  if (deltaX !== 0) {
    if (activeX === 'min') {
      snappedX = rawLocal.x + deltaX;
      snappedW = rawLocal.width - deltaX;
    } else if (activeX === 'max') {
      snappedW = rawLocal.width + deltaX;
    }
  }
  if (deltaY !== 0) {
    if (activeY === 'min') {
      snappedY = rawLocal.y + deltaY;
      snappedH = rawLocal.height - deltaY;
    } else if (activeY === 'max') {
      snappedH = rawLocal.height + deltaY;
    }
  }

  _lastResizeSnapped = {
    local: { x: snappedX, y: snappedY },
    size: { width: snappedW, height: snappedH },
  };

  return { x: snappedX, y: snappedY, width: snappedW, height: snappedH };
}

/**
 * Read-only accessor for the active resize context (captured at
 * `handleResizeStart`). Returns `null` when no resize session is
 * active. Used by `handleResizeEnd` to decide whether the final
 * commit needs a position update (snap may not have moved the node's
 * top-left, in which case dispatching a position change would create
 * a no-op undo entry).
 */
export function getResizeContext(): ResizeContext | null {
  return _resizeContext;
}

/**
 * Read-only accessor for the most recent snapped resize result (in
 * node-local coordinates). Returns `null` when no resize session is
 * active or no proposal has been processed yet. Used by
 * `handleResizeEnd` to commit the snapped values via
 * `setNodeGeometry` rather than RF's raw cursor-derived params.
 */
export function getResizeSnappedRect(): {
  local: XYPosition;
  size: { width: number; height: number };
} | null {
  return _lastResizeSnapped;
}
