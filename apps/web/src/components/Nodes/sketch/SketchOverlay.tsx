import { createId, resolveAccent } from '@sediment/shared';
import { useCallback, useMemo, useRef, useState } from 'react';

import { SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX } from '@/config/canvas';
import { resolveFrameAtPoint } from '@/handler/canvasCommand/utils';
import useCanvasStore from '@/store/canvasStore';

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

import type { CanvasCommand, CanvasNodeId } from '@sediment/shared';
import type { ReactFlowInstance } from '@xyflow/react';
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
  const sketchDraft = useCanvasStore((s) => s.sketchDraft);
  const strokeColor = sketchDraft.strokeColor || DEFAULT_STROKE_COLOR;
  const strokeSize = sketchDraft.strokeSize || DEFAULT_STROKE_SIZE;
  const mode = sketchDraft.mode ?? 'draw';
  const zoom = rfInstance?.getViewport().zoom ?? 1;
  // Eraser hit radius is defined in **screen-space px** so the on-screen
  // target stays the same size regardless of canvas zoom (matches user
  // intuition: "the brush is this big on my screen"). The radius scales
  // loosely with the picked stroke size so a fat brush also erases over a
  // wider visual area, with a sensible minimum for fine strokes.
  //
  // Note: `strokeSize` is nominally in flow units (1–32), but here we use
  // it directly as a screen-px multiplier — i.e. the eraser is sized to
  // match the *picked* stroke thickness rather than its zoom-projected
  // on-screen thickness. Multiplying by `zoom` here would make the eraser
  // grow on zoom-in / shrink on zoom-out, which is exactly what we want
  // to avoid.
  //
  // Flow-space radius (used by `findSketchStrokeHits`) is `screenRadius / zoom`.
  const eraserScreenRadius = Math.max(strokeSize * 2, 12);
  const eraserFlowRadius = eraserScreenRadius / zoom;
  // Live-preview fill: resolve the stored palette token to a CSS color.
  // `resolveAccent` passes legacy hex strings through unchanged.
  const resolvedColor = resolveAccent(strokeColor) ?? strokeColor;

  // Two parallel arrays:
  // - screenPtsRef: raw clientX/clientY for screenToFlowPosition (node creation)
  // - points (state): overlay-relative coords for live SVG preview
  const screenPtsRef = useRef<number[][]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<number[][]>([]);
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

  /** Convert clientX/clientY to overlay-relative coordinates */
  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return { lx: clientX, ly: clientY };
    return { lx: clientX - rect.left, ly: clientY - rect.top };
  }, []);

  /**
   * Begin a middle-mouse pan. Returns true if the event was consumed as
   * a pan-start so the caller can short-circuit its draw/erase path.
   * Browsers default middle-button-down to the auto-scroll cursor, which
   * we suppress with `preventDefault()`.
   */
  const tryStartPan = useCallback(
    (e: React.PointerEvent): boolean => {
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
    (e: React.PointerEvent): boolean => {
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
  const tryEndPan = useCallback((e: React.PointerEvent): boolean => {
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
    (e: React.PointerEvent) => {
      // Middle mouse button → start a viewport pan instead of a stroke.
      // We have to handle this here because the overlay sits on top of
      // ReactFlow and swallows the event before its built-in panOnDrag
      // handler can see it.
      if (tryStartPan(e)) return;
      // Only the primary button (left mouse / pen tip / first touch) draws.
      // Other buttons (right click etc.) fall through with no action.
      if (e.button !== 0 || !e.isPrimary) return;
      // Single-touch only: if another pointer is already drawing, treat
      // this as the second finger of a pinch-zoom / pan gesture. Abort the
      // in-progress stroke (release capture, drop preview) so the gesture
      // is handled cleanly by ReactFlow underneath instead of producing a
      // jittery line as the first finger gets dragged around.
      if (activePointerIdRef.current !== null) {
        try {
          e.currentTarget.releasePointerCapture(activePointerIdRef.current);
        } catch {
          // Capture may already be lost; ignore.
        }
        activePointerIdRef.current = null;
        screenPtsRef.current = [];
        setPoints([]);
        clearTokenRef.current++;
        return;
      }
      activePointerIdRef.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      // Invalidate any pending "clear preview" callback from the previous
      // stroke so it can't wipe the first point of the new one.
      clearTokenRef.current++;
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      screenPtsRef.current = [[e.clientX, e.clientY, e.pressure]];
      setPoints([[lx, ly, e.pressure]]);
    },
    [toLocal, tryStartPan],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (tryUpdatePan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      if (e.buttons !== 1) return;
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      screenPtsRef.current = [
        ...screenPtsRef.current,
        [e.clientX, e.clientY, e.pressure],
      ];
      setPoints((prev) => [...prev, [lx, ly, e.pressure]]);
    },
    [toLocal, tryUpdatePan],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (tryEndPan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      activePointerIdRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      const pts = screenPtsRef.current;

      // Need at least a few points to form a meaningful stroke
      if (pts.length < 3) {
        screenPtsRef.current = [];
        setPoints([]);
        return;
      }

      const result = processPoints(
        pts,
        (pos) => rfInstance?.screenToFlowPosition(pos) ?? pos,
        strokeSize,
      );

      const now = Date.now();
      // Microsoft Whiteboard-style stroke merging: if the user just
      // doodled on a nearby sketch within
      // SKETCH_STROKE_MERGE_MAX_GAP_MS, append this stroke onto that
      // node instead of creating a fresh one. Cross-frame merging is
      // forbidden so a sketch trapped inside a frame can't unexpectedly
      // absorb a freshly-drawn one outside it. See sketchMerge.ts.
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
        now,
        mergeMaxDistance,
      );

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
        }
      } else {
        const nodeId = createId('node');

        addNode({
          id: nodeId,
          nodeType: 'sketch',
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
          skipAutoLayout: true,
        });
      }

      // Sketch is now a normal persisted node. AI recognition is no longer
      // triggered by an idle timer — the user invokes it explicitly via the
      // toolbar's `Apply Sketch` button (see `requestSketchRecognition`).

      // Keep the overlay preview painted until ReactFlow has actually
      // mounted and measured the new SketchNode. Clearing it
      // synchronously creates a brief "flash": the preview vanishes one
      // commit before the committed node renders, because ReactFlow
      // syncs external `nodes` via a useEffect (one commit later) and
      // `onlyRenderVisibleElements` waits on ResizeObserver
      // measurement (next frame). Two rAFs is the smallest delay that
      // covers both steps in practice. The token guard prevents a stale
      // clear from wiping a brand-new stroke if the user starts drawing
      // again before the rAF fires.
      const token = ++clearTokenRef.current;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (clearTokenRef.current !== token) return;
          screenPtsRef.current = [];
          setPoints([]);
        });
      });
    },
    [rfInstance, addNode, strokeColor, strokeSize, zoom, tryEndPan],
  );

  const eraseAtClient = useCallback(
    (clientX: number, clientY: number) => {
      const flow = rfInstance?.screenToFlowPosition({
        x: clientX,
        y: clientY,
      });
      if (!flow) return;
      // Per-stroke eraser: a swipe over a single stroke removes ONLY
      // that stroke, leaving the rest of the (possibly multi-stroke)
      // sketch node intact. If every stroke in a node ends up erased,
      // buildEraseCommands returns a DELETE_NODES command instead.
      const hits = findSketchStrokeHits(flow.x, flow.y, eraserFlowRadius);
      if (hits.length === 0) return;

      // Group hits by node so each node produces a single coherent
      // pair of (MERGE_NODE_DATA, SET_NODE_GEOMETRY) commands rather
      // than one per stroke.
      const byNode = new Map<string, Set<string>>();
      for (const h of hits) {
        let set = byNode.get(h.nodeId);
        if (!set) {
          set = new Set();
          byNode.set(h.nodeId, set);
        }
        set.add(h.strokeId);
      }

      const commands: CanvasCommand[] = [];
      for (const [nodeId, strokeIds] of byNode) {
        commands.push(...buildEraseCommands(nodeId as CanvasNodeId, strokeIds));
      }
      if (commands.length === 0) return;

      // SET_NODE_GEOMETRY uses snapshot:'caller'. If the brush only
      // produced full deletes we don't need beginGesture, but it's
      // cheap and harmless to call when there's any geometry change.
      const hasGeometry = commands.some((c) => c.type === 'SET_NODE_GEOMETRY');
      const store = useCanvasStore.getState();
      if (hasGeometry) store.beginGesture('SET_NODE_GEOMETRY');
      store.executeCommands(commands, 'ui');
    },
    [rfInstance, eraserFlowRadius],
  );

  const handleEraserPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Middle mouse button → viewport pan (see handlePointerDown).
      if (tryStartPan(e)) return;
      // Only the primary button (left mouse / pen tip / first touch) erases.
      if (e.button !== 0 || !e.isPrimary) return;
      // Single-touch only: a second finger lands -> abort the eraser drag
      // and let the underlying canvas handle the pinch / pan gesture.
      if (activePointerIdRef.current !== null) {
        try {
          e.currentTarget.releasePointerCapture(activePointerIdRef.current);
        } catch {
          // Capture may already be lost; ignore.
        }
        activePointerIdRef.current = null;
        setErasing(false);
        return;
      }
      activePointerIdRef.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      setErasing(true);
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      setEraserPos({ x: lx, y: ly });
      eraseAtClient(e.clientX, e.clientY);
    },
    [toLocal, eraseAtClient, tryStartPan],
  );

  const handleEraserPointerMove = useCallback(
    (e: React.PointerEvent) => {
      // Always update the visual indicator position first, regardless of
      // whether this move belongs to a middle-mouse pan. Otherwise the
      // indicator stays frozen at the pre-pan position throughout the
      // drag and snaps to the cursor only on the next move after pan
      // ends \u2014 a visible jump.
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      setEraserPos({ x: lx, y: ly });
      if (tryUpdatePan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      if (e.buttons !== 1) return;
      eraseAtClient(e.clientX, e.clientY);
    },
    [toLocal, eraseAtClient, tryUpdatePan],
  );

  const handleEraserPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (tryEndPan(e)) return;
      if (e.pointerId !== activePointerIdRef.current) return;
      activePointerIdRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setErasing(false);
    },
    [tryEndPan],
  );

  const handleEraserPointerLeave = useCallback(() => {
    setEraserPos(null);
  }, []);

  // Draw-mode cursor: a small filled dot in the active stroke color, with
  // a white halo so it stays visible on dark backgrounds. Hot-spot is the
  // dot's centre so the painted stroke starts exactly under the cursor.
  const dotCursor = useMemo(() => {
    // Only `#` from hex colors needs URL-encoding inside an SVG data URI;
    // palette tokens like `rgb(...)` / named colors pass through fine.
    const safeColor = resolvedColor.replace(/#/g, '%23');
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'>` +
      `<circle cx='7' cy='7' r='5' fill='white'/>` +
      `<circle cx='7' cy='7' r='4' fill='${safeColor}'/>` +
      `</svg>`;
    return `url("data:image/svg+xml;utf8,${svg}") 7 7, crosshair`;
  }, [resolvedColor]);

  if (mode === 'erase') {
    // Eraser indicator and hit area are both defined in screen-space px
    // (`eraserScreenRadius`), so they match exactly and stay constant on
    // screen as the user pans/zooms.
    return (
      <div
        ref={overlayRef}
        className="absolute inset-0 z-4"
        style={{ cursor: 'none' }}
        onPointerDown={handleEraserPointerDown}
        onPointerMove={handleEraserPointerMove}
        onPointerUp={handleEraserPointerUp}
        onPointerCancel={handleEraserPointerUp}
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
      ref={overlayRef}
      className="absolute inset-0 z-4"
      style={{ cursor: dotCursor }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <svg className="h-full w-full">
        {points.length > 0 && (
          <path
            d={pointsToPath(points, zoom, strokeSize)}
            fill={resolvedColor}
          />
        )}
      </svg>
    </div>
  );
}
