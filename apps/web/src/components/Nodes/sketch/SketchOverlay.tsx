// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createId, resolveAccent } from '@huabu/shared';

import { SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX } from '@/config/canvas';
import { resolveFrameAtPoint } from '@/handler/canvasCommand/utils';
import {
  beginCanvasGesture,
  canTouchTakeOverCanvasGesture,
  endCanvasGesture,
  updateCanvasGesture,
  type CanvasPointerType,
} from '@/handler/canvasGestureSession';
import { readEffectiveInputMode } from '@/hooks/useInputMode';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import { useToolStore } from '@/store/toolStore';

import { findSketchStrokeHits } from './sketchHitTest';
import {
  buildEraseCommands,
  buildMergeCommands,
  findMergeTarget,
} from './sketchMerge';
import {
  pointsToPath,
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_SIZE,
} from './sketchPath';
import { shouldCommitSketchStroke } from './sketchStrokeCommit';
import {
  getStylusRawTouchOverlayStyle,
  isSupersededByStylusRawTouch,
  useStylusRawTouch,
} from './stylusRawTouch';

import type { SketchPointer } from './stylusRawTouch';
import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';
import type { ReactFlowInstance } from '@xyflow/react';

/**
 * Number of animation frames to wait before clearing the live overlay
 * preview after a stroke commits. Two frames is the smallest delay
 * that reliably covers ReactFlow's node sync (one commit later via
 * useEffect) AND its `onlyRenderVisibleElements` ResizeObserver pass
 * (next paint). Anything less causes a brief "flash" where the
 * preview vanishes one paint before the committed SketchNode renders.
 */
const PREVIEW_CLEAR_DELAY_FRAMES = 2;
export const CANCEL_SKETCH_GESTURE_EVENT = 'huabu:cancel-sketch-gesture';

/**
 * Run `cb` after `frames` animation frames have elapsed. Used to defer
 * preview cleanup until ReactFlow has actually mounted the new node
 * (see {@link PREVIEW_CLEAR_DELAY_FRAMES}).
 */
function runAfterFrames(frames: number, cb: () => void): void {
  if (frames <= 0) {
    cb();
    return;
  }
  requestAnimationFrame(() => runAfterFrames(frames - 1, cb));
}

/**
 * Process raw screen-space points into flow-space node data.
 * Returns bounding box position/size and normalised point array.
 */
function processPoints(
  points: number[][],
  screenToFlowPosition: (pos: { x: number; y: number }) => {
    x: number;
    y: number;
  },
  strokeSize: number,
) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;

  const flowPoints: number[][] = [];

  for (const pt of points) {
    const { x, y } = screenToFlowPosition({ x: pt[0], y: pt[1] });
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
    flowPoints.push([x, y, pt[2]]);
  }

  // Add stroke thickness padding so the bounding box leaves room for the
  // halo of the painted stroke (perfect-freehand paints up to `size` wide).
  const pad = strokeSize * 0.5;
  x1 -= pad;
  y1 -= pad;
  x2 += pad;
  y2 += pad;

  // Normalise points relative to the bounding box origin
  for (const fp of flowPoints) {
    fp[0] -= x1;
    fp[1] -= y1;
  }

  const width = x2 - x1;
  const height = y2 - y1;

  return {
    position: { x: x1, y: y1 },
    width,
    height,
    points: flowPoints,
    initialSize: { width, height },
  };
}

/**
 * Full-screen overlay that captures pointer events for freehand drawing.
 * Renders a live SVG preview of the current stroke, then creates a
 * sketch node on pointer-up.
 *
 * When `sketchDraft.mode === 'erase'` the overlay switches into eraser
 * mode: dragging the pointer over existing sketch nodes deletes any whose
 * strokes intersect the eraser path.
 */
export function SketchOverlay({
  rfInstance,
}: {
  rfInstance: ReactFlowInstance | null;
}) {
  const addNode = useCanvasStore((s) => s.addNode);
  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const sketchDraft = useToolStore((s) => s.sketchDraft);

  // Drop any prior canvas selection the moment the sketch tool
  // activates so a stale selection isn't sent as context on the next
  // chat turn or surfaced in selection-aware toolbars. The sketch tool
  // only draws/erases: node selection lives in the Select tool (finger)
  // and the pen/finger split (pen mode), never in this overlay.
  useEffect(() => {
    selectNodes([], false);
  }, [selectNodes]);
  const strokeColor = sketchDraft.strokeColor || DEFAULT_STROKE_COLOR;
  const strokeSize = sketchDraft.strokeSize || DEFAULT_STROKE_SIZE;
  const mode = sketchDraft.mode ?? 'draw';
  const zoom = rfInstance?.getViewport().zoom ?? 1;
  // Eraser hit radius is a fixed screen-space size (decoupled from the
  // picked stroke thickness), so the on-screen target stays predictable
  // regardless of zoom or whatever the user last drew with. The radius
  // itself is user-tunable via the eraser slider in
  // `SketchSettingsPanel` (persisted on `sketchDraft.eraserSize`). The
  // flow-space radius (used by `findSketchStrokeHits`) divides out zoom
  // so the brush always covers the same number of on-screen pixels.
  const eraserScreenRadius = sketchDraft.eraserSize;
  const eraserFlowRadius = eraserScreenRadius / zoom;
  // Live-preview fill: resolve the stored palette token to a CSS color.
  // `resolveAccent` passes legacy hex strings through unchanged.
  const resolvedColor = resolveAccent(strokeColor) ?? strokeColor;

  // Raw clientX/clientY, fed to screenToFlowPosition on commit to build the
  // node. Kept alongside `livePtsRef` (the same stroke in overlay-relative
  // coords) so neither has to be re-derived per event.
  const screenPtsRef = useRef<number[][]>([]);
  // The overlay node lives in state rather than a ref so the raw-touch effect
  // can depend on it and follow a remounted element. A ref would be no more
  // synchronous here: the ref callback and the state update land in the same
  // commit, and pointer events only arrive after it.
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const [points, setPoints] = useState<number[][]>([]);
  // Live overlay-relative buffer backing `points`. Every pointermove appends
  // here, but the buffer is published to state at most once per animation
  // frame: republishing re-runs perfect-freehand over the *whole* stroke, and
  // the pointer stream can outrun the display badly — the raw-touch engine
  // replays stylus contacts straight off `touchmove` (~240 Hz on an iPad),
  // and even a plain pen reports far above the refresh rate. Renders beyond
  // one per frame are work no one can ever see.
  const livePtsRef = useRef<number[][]>([]);
  const pointsFlushRef = useRef<number | null>(null);
  // Monotonic token to invalidate pending "clear preview" callbacks when a
  // new stroke starts before the previous clear runs (see `handlePointerUp`).
  const clearTokenRef = useRef(0);
  // ID of the pointer currently driving the stroke / eraser drag. Used to
  // enforce single-touch interaction: a second finger landing while we're
  // already tracking one cancels the in-progress action so the underlying
  // ReactFlow can handle the pinch-zoom / two-finger pan cleanly, without
  // the first finger's coordinates being dragged around by the gesture and
  // leaving stray strokes behind.
  const activePointerIdRef = useRef<number | null>(null);
  const eraseHitsRef = useRef<Map<string, Set<string>>>(new Map());
  // Middle-mouse pan state. The overlay sits on top of ReactFlow and
  // swallows all pointer events, so ReactFlow's built-in `panOnDrag={[1]}`
  // never sees a middle-mouse press. We re-implement that gesture here
  // by tracking the drag and driving `rfInstance.setViewport` directly,
  // so middle-mouse pan keeps working while the sketch / eraser tool is
  // active.
  const panStateRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewport: { x: number; y: number; zoom: number };
  } | null>(null);
  // Whether the eraser is actively being dragged (mouse / pen / touch held).
  const [erasing, setErasing] = useState(false);
  // Last cursor position in overlay-relative coords for the eraser indicator.
  const [eraserPos, setEraserPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  const acceptsPointer = useCallback((e: SketchPointer) => {
    // The mouse always draws; other pointers follow the input-mode routing.
    if (e.pointerType === 'mouse') return true;
    // Resolved from live store state rather than a render-time value: a stylus
    // contact replayed by the raw-touch engine has just flipped `penObserved`,
    // and a value captured during the previous render would still read `finger`
    // under `auto` — dropping the very first stroke.
    const effective = readEffectiveInputMode();
    if (effective === 'mouse') return false;
    return effective === 'pen'
      ? e.pointerType === 'pen'
      : e.pointerType === 'touch';
  }, []);

  const cancelPointsFlush = useCallback(() => {
    if (pointsFlushRef.current === null) return;
    cancelAnimationFrame(pointsFlushRef.current);
    pointsFlushRef.current = null;
  }, []);

  /** Queue a publish of the live buffer for the next frame (idempotent). */
  const schedulePointsFlush = useCallback(() => {
    if (pointsFlushRef.current !== null) return;
    pointsFlushRef.current = requestAnimationFrame(() => {
      pointsFlushRef.current = null;
      // Copy: React bails out on an unchanged array identity, and the buffer
      // keeps being appended to in place after this render.
      setPoints(livePtsRef.current.slice());
    });
  }, []);

  /** Publish the live buffer right away, dropping any queued frame. */
  const flushPointsNow = useCallback(() => {
    cancelPointsFlush();
    setPoints(livePtsRef.current.slice());
  }, [cancelPointsFlush]);

  /**
   * Drop the in-progress stroke and any frame queued for it.
   *
   * Both buffers are reassigned rather than truncated: `handlePointerUp`
   * hands the old `screenPtsRef` array straight to `processPoints`, which
   * must not see it emptied underneath during the deferred clear.
   */
  const resetStroke = useCallback(() => {
    cancelPointsFlush();
    livePtsRef.current = [];
    screenPtsRef.current = [];
    setPoints([]);
  }, [cancelPointsFlush]);

  const cancelActiveGesture = useCallback(() => {
    const pointerId = activePointerIdRef.current;
    if (pointerId !== null) endCanvasGesture(pointerId);
    activePointerIdRef.current = null;
    eraseHitsRef.current.clear();
    useGesturePreviewStore.getState().clearSketchErasePreview();
    clearTokenRef.current++;
    resetStroke();
    setErasing(false);
  }, [resetStroke]);

  useEffect(() => {
    window.addEventListener(CANCEL_SKETCH_GESTURE_EVENT, cancelActiveGesture);
    return () => {
      window.removeEventListener(
        CANCEL_SKETCH_GESTURE_EVENT,
        cancelActiveGesture,
      );
      cancelActiveGesture();
    };
  }, [cancelActiveGesture]);

  // Cached overlay origin. `getBoundingClientRect()` forces a synchronous
  // layout, and a pointermove handler is the worst possible place to ask for
  // one: the stroke we just rendered has already invalidated layout, so every
  // event paid for a full style + layout recalc of the document before it
  // could even record a point. The overlay is `absolute inset-0` over the
  // canvas, so its origin only moves when the container resizes or an
  // ancestor scrolls — never while a stroke is in flight.
  const overlayOriginRef = useRef<{ left: number; top: number } | null>(null);

  const refreshOverlayOrigin = useCallback(() => {
    if (!overlayEl) {
      overlayOriginRef.current = null;
      return;
    }
    const rect = overlayEl.getBoundingClientRect();
    overlayOriginRef.current = { left: rect.left, top: rect.top };
  }, [overlayEl]);

  useEffect(() => {
    refreshOverlayOrigin();
    if (!overlayEl) return;
    const observer = new ResizeObserver(refreshOverlayOrigin);
    observer.observe(overlayEl);
    window.addEventListener('resize', refreshOverlayOrigin);
    // Capture phase: a scroll on any ancestor shifts the overlay too.
    window.addEventListener('scroll', refreshOverlayOrigin, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', refreshOverlayOrigin);
      window.removeEventListener('scroll', refreshOverlayOrigin, true);
    };
  }, [overlayEl, refreshOverlayOrigin]);

  /** Convert clientX/clientY to overlay-relative coordinates. */
  const toLocal = useCallback((clientX: number, clientY: number) => {
    const origin = overlayOriginRef.current;
    if (!origin) return { lx: clientX, ly: clientY };
    return { lx: clientX - origin.left, ly: clientY - origin.top };
  }, []);

  /**
   * Begin a middle-mouse pan. Returns true if the event was consumed as
   * a pan-start so the caller can short-circuit its draw/erase path.
   * Browsers default middle-button-down to the auto-scroll cursor, which
   * we suppress with `preventDefault()`.
   *
   * NOTE: this is a *compensating* implementation, not a sketch-specific
   * feature. Middle-mouse pan is provided canvas-wide by React Flow's
   * `panOnDrag={[1]}` (see `Canvas.tsx`). This full-screen overlay sits on
   * top of React Flow and swallows the pointer stream while the sketch
   * tool is active, so React Flow never sees the middle-button drag —
   * we re-implement the same behavior here purely to stay consistent with
   * the rest of the canvas. It is intentionally duplicated: the two paths
   * use different mechanisms (React Flow config vs. this overlay handler)
   * and cannot be cleanly shared without replacing React Flow's own pan.
   */
  const tryStartPan = useCallback(
    (e: SketchPointer): boolean => {
      if (e.button !== 1 || !rfInstance) return false;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture may fail on some pen / touch backends; ignore and
        // rely on bubbling pointermove/up.
      }
      panStateRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startViewport: rfInstance.getViewport(),
      };
      return true;
    },
    [rfInstance],
  );

  /**
   * Drive the in-progress middle-mouse pan from a pointermove. Returns
   * true if the event belongs to the active pan (so the caller can
   * short-circuit its draw/erase path).
   */
  const tryUpdatePan = useCallback(
    (e: SketchPointer): boolean => {
      const s = panStateRef.current;
      if (!s || e.pointerId !== s.pointerId || !rfInstance) return false;
      const dx = e.clientX - s.startClientX;
      const dy = e.clientY - s.startClientY;
      rfInstance.setViewport(
        {
          x: s.startViewport.x + dx,
          y: s.startViewport.y + dy,
          zoom: s.startViewport.zoom,
        },
        { duration: 0 },
      );
      return true;
    },
    [rfInstance],
  );

  /**
   * End the middle-mouse pan on pointerup / pointercancel. Returns true
   * if the event belongs to the active pan.
   */
  const tryEndPan = useCallback((e: SketchPointer): boolean => {
    const s = panStateRef.current;
    if (!s || e.pointerId !== s.pointerId) return false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be lost; ignore.
    }
    panStateRef.current = null;
    return true;
  }, []);

  const handlePointerDown = useCallback(
    (e: SketchPointer) => {
      // Where the raw-touch engine runs it owns the stylus, so the browser's
      // own (lossy) pen pointer stream is dropped to avoid handling a contact
      // twice. Contacts replayed by the engine pass through.
      if (isSupersededByStylusRawTouch(e)) return;
      // Middle mouse button → start a viewport pan instead of a stroke.
      // We have to handle this here because the overlay sits on top of
      // ReactFlow and swallows the event before its built-in panOnDrag
      // handler can see it.
      if (tryStartPan(e)) return;
      // Only the primary button (left mouse / pen tip / first touch) draws.
      // Other buttons (right click etc.) fall through with no action.
      if (e.button !== 0 || !e.isPrimary) return;
      if (!acceptsPointer(e)) return;
      // Single-touch only: if another pointer is already drawing, treat
      // this as the second finger of a pinch-zoom / pan gesture. Abort the
      // in-progress stroke (release capture, drop preview) so the gesture
      // is handled cleanly by ReactFlow underneath instead of producing a
      // jittery line as the first finger gets dragged around.
      if (activePointerIdRef.current !== null) {
        if (!canTouchTakeOverCanvasGesture()) return;
        try {
          e.currentTarget.releasePointerCapture(activePointerIdRef.current);
        } catch {
          // Capture may already be lost; ignore.
        }
        activePointerIdRef.current = null;
        resetStroke();
        clearTokenRef.current++;
        return;
      }
      if (
        !beginCanvasGesture(
          'sketch-draw',
          e.pointerId,
          e.pointerType as CanvasPointerType,
          { x: e.clientX, y: e.clientY },
        )
      ) {
        return;
      }
      activePointerIdRef.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      // Invalidate any pending "clear preview" callback from the previous
      // stroke so it can't wipe the first point of the new one.
      clearTokenRef.current++;
      // Re-measure once per gesture, so a layout shift that dodged the
      // observers can never skew a whole stroke.
      refreshOverlayOrigin();
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      screenPtsRef.current = [[e.clientX, e.clientY, e.pressure]];
      livePtsRef.current = [[lx, ly, e.pressure]];
      flushPointsNow();
    },
    [
      acceptsPointer,
      flushPointsNow,
      refreshOverlayOrigin,
      resetStroke,
      toLocal,
      tryStartPan,
    ],
  );

  const handlePointerMove = useCallback(
    (e: SketchPointer) => {
      if (isSupersededByStylusRawTouch(e)) return;
      if (tryUpdatePan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      if (e.pointerType === 'mouse' && e.buttons !== 1) return;
      updateCanvasGesture(e.pointerId, { x: e.clientX, y: e.clientY });
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      // Append in place — rebuilding both arrays per event made recording a
      // point O(n), so a single stroke cost O(n²) just to accumulate.
      screenPtsRef.current.push([e.clientX, e.clientY, e.pressure]);
      livePtsRef.current.push([lx, ly, e.pressure]);
      schedulePointsFlush();
    },
    [schedulePointsFlush, toLocal, tryUpdatePan],
  );

  const handlePointerUp = useCallback(
    (e: SketchPointer) => {
      if (isSupersededByStylusRawTouch(e)) return;
      if (tryEndPan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      const phase = updateCanvasGesture(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });
      activePointerIdRef.current = null;
      endCanvasGesture(e.pointerId);
      e.currentTarget.releasePointerCapture(e.pointerId);
      // The stroke deliberately ends at the last pointermove. A pointerup
      // carries its own coordinates, but as the tip leaves the digitizer the
      // reported position degrades and lands several px off the real one —
      // appending it hooked a visible tail onto the end of every stroke, and
      // `streamline` can't smooth away a terminal outlier. Nothing is lost by
      // dropping it: the final pointermove is already buffered, and the flush
      // below publishes it.
      const pts = screenPtsRef.current;

      // Sketch is an explicit ink tool, so a normal release commits even when
      // the gesture stayed below the drag threshold. This preserves dots and
      // short marks while pending gestures remain cancellable by pinch takeover.
      if (!shouldCommitSketchStroke(phase, pts.length)) {
        resetStroke();
        return;
      }
      // Publish now rather than waiting on the queued frame: the preview has
      // to be complete for the whole handoff window opened below.
      flushPointsNow();

      const result = processPoints(
        pts,
        (pos) =>
          rfInstance?.screenToFlowPosition(pos, { snapToGrid: false }) ?? pos,
        strokeSize,
      );

      const now = Date.now();
      // Whiteboard-style stroke merging: append this stroke onto the
      // nearest existing sketch region instead of creating a fresh node,
      // keeping a continuous piece of handwriting in one region. Merging
      // is purely spatial — no time window — so a mid-writing think-pause
      // never splits a line across nodes. Cross-frame merging is forbidden
      // so a sketch trapped inside a frame can't unexpectedly absorb a
      // freshly-drawn one outside it. See sketchMerge.ts. (`now` is still
      // used below as each stroke's `createdAt` — intra-region metadata
      // that no longer influences the region boundary.)
      //
      // Resolve the parent frame (if any) from the new stroke's bbox
      // top-left so we match the exact same auto-nesting that
      // `addNode` (via resolveAddNodes) would do for the fallback path.
      // Both `findMergeTarget` and `buildMergeCommands` compare
      // against `node.position`, which is parent-local for parented
      // nodes \u2014 so for the parented case we convert `newBboxFlow`
      // into the parent's local space before passing it down.
      const storeNodes = useCanvasStore.getState().nodes;
      const frameHit = resolveFrameAtPoint(
        storeNodes as never,
        result.position,
      );
      const newParentId = (frameHit?.parentId ?? null) as CanvasNodeId | null;
      const parentOrigin = frameHit?.absolutePosition ?? { x: 0, y: 0 };
      const newBboxFlow = {
        x: result.position.x - parentOrigin.x,
        y: result.position.y - parentOrigin.y,
        width: result.width,
        height: result.height,
      };
      // Zoom-aware proximity threshold: keep the snap radius constant
      // on screen by converting the screen-space constant to flow-space
      // via the current zoom (mirrors how `eraserScreenRadius` /
      // `eraserFlowRadius` are tied together below).
      const mergeMaxDistance =
        SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX / zoom;

      const targetId = findMergeTarget(
        newBboxFlow,
        newParentId,
        mergeMaxDistance,
      );

      // Try the Whiteboard-style merge first; only fall through to a
      // fresh node when no candidate was found OR the builder declined
      // to produce commands (e.g. the candidate's `parentId` shifted
      // between `findMergeTarget` and `buildMergeCommands` so the
      // coord-space invariant no longer holds). Without this fallback
      // the user's stroke would be silently dropped on the rare race.
      let merged = false;
      if (targetId) {
        const strokeId = createId('stroke');
        const commands = buildMergeCommands(
          targetId,
          newParentId,
          result.points,
          newBboxFlow,
          strokeColor,
          strokeSize,
          now,
          strokeId,
        );
        if (commands.length > 0) {
          // SET_NODE_GEOMETRY uses snapshot:'caller' \u2014 take the undo
          // snapshot now so the merge folds into a single undo entry
          // alongside the data merge. Without this, the canvasStore
          // executor warns about a missing beginGesture.
          useCanvasStore.getState().beginGesture('SET_NODE_GEOMETRY');
          useCanvasStore.getState().executeCommands(commands, 'ui');
          merged = true;
        } else {
          // The builder already logged the specific reason; this just
          // surfaces that we're recovering by creating a fresh node.
          console.warn(
            '[SketchOverlay] merge target rejected by builder; falling back to a fresh sketch node so the stroke is preserved',
            targetId,
          );
        }
      }

      if (!merged) {
        const nodeId = createId('node');

        addNode({
          id: nodeId,
          nodeType: 'sketch',
          // A freshly drawn sketch must NOT auto-select: the selection box
          // would interrupt continuous freehand drawing (and, unselected,
          // the node keeps stroke-only hit-testing so it never shadows
          // nodes beneath its transparent bbox).
          selectOnCreate: false,
          // placementPoint is the top-left of the new node, which here
          // is the top-left of the stroke's bounding box. Passed in
          // flow-space coords; resolveAddNodes re-runs the same
          // resolveFrameAtPoint hit-test and converts to parent-local
          // coords if it lands inside a frame.
          placementPoint: {
            x: result.position.x,
            y: result.position.y,
          },
          size: { width: result.width, height: result.height },
          data: {
            type: 'sketch',
            strokes: [
              {
                id: createId('stroke'),
                points: result.points,
                color: strokeColor,
                size: strokeSize,
                createdAt: now,
              },
            ],
            initialSize: result.initialSize,
            origin: { type: 'user-created' },
          },
        });
      }

      // Keep the overlay preview painted until ReactFlow has actually
      // mounted and measured the new SketchNode (see
      // PREVIEW_CLEAR_DELAY_FRAMES). The token guard prevents a stale
      // clear from wiping a brand-new stroke if the user starts drawing
      // again before the deferred callback fires.
      const token = ++clearTokenRef.current;
      runAfterFrames(PREVIEW_CLEAR_DELAY_FRAMES, () => {
        if (clearTokenRef.current !== token) return;
        resetStroke();
      });
    },
    [
      rfInstance,
      addNode,
      strokeColor,
      strokeSize,
      zoom,
      flushPointsNow,
      resetStroke,
      tryEndPan,
    ],
  );

  const collectEraseHits = useCallback(
    (clientX: number, clientY: number) => {
      const flow = rfInstance?.screenToFlowPosition(
        {
          x: clientX,
          y: clientY,
        },
        { snapToGrid: false },
      );
      if (!flow) return;
      // Per-stroke eraser: a swipe over a single stroke removes ONLY
      // that stroke, leaving the rest of the (possibly multi-stroke)
      // sketch node intact. If every stroke in a node ends up erased,
      // buildEraseCommands returns a DELETE_NODES command instead.
      const hits = findSketchStrokeHits(flow.x, flow.y, eraserFlowRadius);
      if (hits.length === 0) return;

      let changed = false;
      for (const h of hits) {
        let set = eraseHitsRef.current.get(h.nodeId);
        if (!set) {
          set = new Set();
          eraseHitsRef.current.set(h.nodeId, set);
        }
        const previousSize = set.size;
        set.add(h.strokeId);
        changed ||= set.size !== previousSize;
      }
      if (changed) {
        useGesturePreviewStore
          .getState()
          .setSketchErasePreview(
            Object.fromEntries(
              Array.from(eraseHitsRef.current, ([nodeId, strokeIds]) => [
                nodeId,
                Array.from(strokeIds),
              ]),
            ),
          );
      }
    },
    [rfInstance, eraserFlowRadius],
  );

  const commitEraseHits = useCallback(() => {
    const hitsByNode = eraseHitsRef.current;
    eraseHitsRef.current = new Map();
    useGesturePreviewStore.getState().clearSketchErasePreview();
    if (hitsByNode.size === 0) return;

    const commands: CanvasCommand[] = [];
    for (const [nodeId, strokeIds] of hitsByNode) {
      commands.push(...buildEraseCommands(nodeId as CanvasNodeId, strokeIds));
    }
    if (commands.length === 0) return;

    const hasGeometry = commands.some((c) => c.type === 'SET_NODE_GEOMETRY');
    const store = useCanvasStore.getState();
    if (hasGeometry) store.beginGesture('SET_NODE_GEOMETRY');
    store.executeCommands(commands, 'ui');
  }, []);

  const handleEraserPointerDown = useCallback(
    (e: SketchPointer) => {
      if (isSupersededByStylusRawTouch(e)) return;
      // Middle mouse button → viewport pan (see handlePointerDown).
      if (tryStartPan(e)) return;
      // Only the primary button (left mouse / pen tip / first touch) erases.
      if (e.button !== 0 || !e.isPrimary) return;
      if (!acceptsPointer(e)) return;
      // Single-touch only: a second finger lands -> abort the eraser drag
      // and let the underlying canvas handle the pinch / pan gesture.
      if (activePointerIdRef.current !== null) {
        if (!canTouchTakeOverCanvasGesture()) return;
        try {
          e.currentTarget.releasePointerCapture(activePointerIdRef.current);
        } catch {
          // Capture may already be lost; ignore.
        }
        activePointerIdRef.current = null;
        eraseHitsRef.current.clear();
        useGesturePreviewStore.getState().clearSketchErasePreview();
        setErasing(false);
        return;
      }
      if (
        !beginCanvasGesture(
          'sketch-erase',
          e.pointerId,
          e.pointerType as CanvasPointerType,
          { x: e.clientX, y: e.clientY },
        )
      ) {
        return;
      }
      activePointerIdRef.current = e.pointerId;
      eraseHitsRef.current.clear();
      useGesturePreviewStore.getState().clearSketchErasePreview();
      e.currentTarget.setPointerCapture(e.pointerId);
      setErasing(true);
      refreshOverlayOrigin();
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      setEraserPos({ x: lx, y: ly });
      collectEraseHits(e.clientX, e.clientY);
    },
    [
      acceptsPointer,
      collectEraseHits,
      refreshOverlayOrigin,
      toLocal,
      tryStartPan,
    ],
  );

  const handleEraserPointerMove = useCallback(
    (e: SketchPointer) => {
      if (isSupersededByStylusRawTouch(e)) return;
      // Always update the visual indicator position first, regardless of
      // whether this move belongs to a middle-mouse pan. Otherwise the
      // indicator stays frozen at the pre-pan position throughout the
      // drag and snaps to the cursor only on the next move after pan
      // ends \u2014 a visible jump.
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      setEraserPos({ x: lx, y: ly });
      if (tryUpdatePan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      if (e.pointerType === 'mouse' && e.buttons !== 1) return;
      updateCanvasGesture(e.pointerId, { x: e.clientX, y: e.clientY });
      collectEraseHits(e.clientX, e.clientY);
    },
    [collectEraseHits, toLocal, tryUpdatePan],
  );

  const handleEraserPointerUp = useCallback(
    (e: SketchPointer) => {
      if (isSupersededByStylusRawTouch(e)) return;
      if (tryEndPan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      const phase = updateCanvasGesture(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });
      activePointerIdRef.current = null;
      endCanvasGesture(e.pointerId);
      e.currentTarget.releasePointerCapture(e.pointerId);
      setErasing(false);
      if (phase === 'locked') {
        collectEraseHits(e.clientX, e.clientY);
        commitEraseHits();
      } else {
        eraseHitsRef.current.clear();
        useGesturePreviewStore.getState().clearSketchErasePreview();
      }
    },
    [collectEraseHits, commitEraseHits, tryEndPan],
  );

  const handleEraserPointerLeave = useCallback(() => {
    setEraserPos(null);
  }, []);

  const handlePointerCancel = useCallback(
    (e: SketchPointer) => {
      if (isSupersededByStylusRawTouch(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      cancelActiveGesture();
    },
    [cancelActiveGesture],
  );

  // Draw-mode cursor: a filled dot in the active stroke color sized to
  // match the on-screen stroke thickness (`strokeSize * zoom`, mirroring
  // `pointsToPath`), with a 1px white halo so it stays visible on dark
  // backgrounds. Hot-spot is the dot's centre so the painted stroke
  // starts exactly under the cursor.
  //
  // Visual diameter is clamped to a usable range: a hard min keeps the
  // cursor findable for hairline strokes, and the max stays inside the
  // ~128px ceiling that browsers reliably honour for custom cursors
  // (Chromium silently falls back to the system cursor above that).
  const dotCursor = useMemo(() => {
    const CURSOR_MIN_PX = 4;
    const CURSOR_MAX_PX = 64;
    const diameter = Math.max(
      CURSOR_MIN_PX,
      Math.min(CURSOR_MAX_PX, Math.round(strokeSize * zoom)),
    );
    // 1px halo on each side; +1 extra so the antialiased edge isn't
    // clipped by the SVG bounds.
    const svgSize = diameter + 3;
    const center = svgSize / 2;
    const dotRadius = diameter / 2;
    const haloRadius = dotRadius + 1;
    // Only `#` from hex colors needs URL-encoding inside an SVG data URI;
    // palette tokens like `rgb(...)` / named colors pass through fine.
    const safeColor = resolvedColor.replace(/#/g, '%23');
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='${svgSize}' height='${svgSize}' viewBox='0 0 ${svgSize} ${svgSize}'>` +
      `<circle cx='${center}' cy='${center}' r='${haloRadius}' fill='white'/>` +
      `<circle cx='${center}' cy='${center}' r='${dotRadius}' fill='${safeColor}'/>` +
      `</svg>`;
    return `url("data:image/svg+xml;utf8,${svg}") ${center} ${center}, crosshair`;
  }, [resolvedColor, strokeSize, zoom]);

  // Tessellate only when the stroke buffer is actually republished (once per
  // frame at most). Computing this inline in the JSX re-ran perfect-freehand
  // over the whole stroke on *every* render, including ones the stroke had no
  // part in — eraser indicator moves, tool changes, store updates.
  const livePath = useMemo(
    () => (points.length > 0 ? pointsToPath(points, zoom, strokeSize) : ''),
    [points, zoom, strokeSize],
  );

  // Raw-touch stylus engine. Where the browser's synthesized pen pointer
  // stream is lossy (WebKit drops light / fast Apple-Pencil contacts), stylus
  // contacts are replayed into these very handlers as synthetic pen events, so
  // all draw / erase / commit / merge logic is reused verbatim. Inert on every
  // other device — see `stylusRawTouch.ts` for the capability gate.
  useStylusRawTouch(
    overlayEl,
    mode === 'erase'
      ? {
          onDown: handleEraserPointerDown,
          onMove: handleEraserPointerMove,
          onUp: handleEraserPointerUp,
          onCancel: handlePointerCancel,
        }
      : {
          onDown: handlePointerDown,
          onMove: handlePointerMove,
          onUp: handlePointerUp,
          onCancel: handlePointerCancel,
        },
  );

  if (mode === 'erase') {
    // Eraser indicator and hit area are both defined in screen-space px
    // (`eraserScreenRadius`), so they match exactly and stay constant on
    // screen as the user pans/zooms.
    return (
      <div
        ref={setOverlayEl}
        className="absolute inset-0 z-4"
        style={{ cursor: 'none', ...getStylusRawTouchOverlayStyle() }}
        onPointerDown={handleEraserPointerDown}
        onPointerMove={handleEraserPointerMove}
        onPointerUp={handleEraserPointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handleEraserPointerLeave}
      >
        {eraserPos && (
          <svg className="pointer-events-none h-full w-full">
            <circle
              cx={eraserPos.x}
              cy={eraserPos.y}
              r={eraserScreenRadius}
              fill={erasing ? 'rgba(0,0,0,0.08)' : 'none'}
              stroke="currentColor"
              strokeWidth={1.5}
              className="text-fg-muted"
            />
          </svg>
        )}
      </div>
    );
  }

  return (
    <div
      ref={setOverlayEl}
      className="absolute inset-0 z-4"
      style={{ cursor: dotCursor, ...getStylusRawTouchOverlayStyle() }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <svg className="h-full w-full">
        {livePath !== '' && <path d={livePath} fill={resolvedColor} />}
      </svg>
    </div>
  );
}
