import { createId, resolveAccent } from '@sediment/shared';
import { useCallback, useMemo, useRef, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';

import {
  pointsToPath,
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_SIZE,
} from './sketchPath';

import type { CanvasSketchNodeData } from '../types';
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
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const sketchDraft = useCanvasStore((s) => s.sketchDraft);
  const strokeColor = sketchDraft.strokeColor || DEFAULT_STROKE_COLOR;
  const strokeSize = sketchDraft.strokeSize || DEFAULT_STROKE_SIZE;
  const mode = sketchDraft.mode ?? 'draw';
  // Eraser hit radius scales loosely with stroke size so a fat brush also
  // erases over a wider area, with a sensible minimum for fine strokes.
  const eraserRadius = Math.max(strokeSize * 3, 12);
  // Live-preview fill: resolve the stored palette token to a CSS color.
  // `resolveAccent` passes legacy hex strings through unchanged.
  const resolvedColor = resolveAccent(strokeColor) ?? strokeColor;

  // Two parallel arrays:
  // - screenPtsRef: raw clientX/clientY for screenToFlowPosition (node creation)
  // - points (state): overlay-relative coords for live SVG preview
  const screenPtsRef = useRef<number[][]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<number[][]>([]);
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

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      screenPtsRef.current = [[e.clientX, e.clientY, e.pressure]];
      setPoints([[lx, ly, e.pressure]]);
    },
    [toLocal],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.buttons !== 1) return;
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      screenPtsRef.current = [
        ...screenPtsRef.current,
        [e.clientX, e.clientY, e.pressure],
      ];
      setPoints((prev) => [...prev, [lx, ly, e.pressure]]);
    },
    [toLocal],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
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

      const nodeId = createId('node');

      addNode({
        id: nodeId,
        nodeType: 'sketch',
        // placementPoint is the top-left of the new node, which here is
        // the top-left of the stroke's bounding box.
        placementPoint: {
          x: result.position.x,
          y: result.position.y,
        },
        size: { width: result.width, height: result.height },
        data: {
          type: 'sketch',
          points: result.points,
          initialSize: result.initialSize,
          strokeColor,
          strokeSize,
          origin: { type: 'user-created' },
        },
        skipAutoLayout: true,
      });

      // Sketch is now a normal persisted node. AI recognition is no longer
      // triggered by an idle timer — the user invokes it explicitly via the
      // toolbar's `Apply Sketch` button (see `requestSketchRecognition`).

      screenPtsRef.current = [];
      setPoints([]);
    },
    [rfInstance, addNode, strokeColor, strokeSize],
  );

  /**
   * Find every sketch node whose stroke is hit by an eraser circle of
   * radius `eraserRadius` centred at the given flow-space point.
   *
   * Uses a quick bounding-box reject, then walks the stroke's points
   * (scaled by any user resize) and tests against the distance from the
   * eraser centre. The half-stroke thickness is folded into the radius so
   * thicker strokes are easier to hit.
   */
  const findHitSketchNodes = useCallback(
    (flowX: number, flowY: number): string[] => {
      const nodes = useCanvasStore.getState().nodes;
      const hits: string[] = [];
      for (const node of nodes) {
        if (node.type !== 'sketch') continue;
        const data = node.data as CanvasSketchNodeData;
        const baseW = data.initialSize?.width || 1;
        const baseH = data.initialSize?.height || 1;
        const w = node.measured?.width ?? node.width ?? baseW;
        const h = node.measured?.height ?? node.height ?? baseH;
        const x0 = node.position.x;
        const y0 = node.position.y;
        const halfStroke = (data.strokeSize ?? DEFAULT_STROKE_SIZE) / 2;
        const r = eraserRadius + halfStroke;

        // Bounding box reject (expanded by hit radius).
        if (
          flowX < x0 - r ||
          flowX > x0 + w + r ||
          flowY < y0 - r ||
          flowY > y0 + h + r
        ) {
          continue;
        }

        const scaleX = w / baseW;
        const scaleY = h / baseH;
        const r2 = r * r;
        const pts = data.points ?? [];
        for (const pt of pts) {
          const px = x0 + pt[0] * scaleX;
          const py = y0 + pt[1] * scaleY;
          const dx = px - flowX;
          const dy = py - flowY;
          if (dx * dx + dy * dy <= r2) {
            hits.push(node.id);
            break;
          }
        }
      }
      return hits;
    },
    [eraserRadius],
  );

  const eraseAtClient = useCallback(
    (clientX: number, clientY: number) => {
      const flow = rfInstance?.screenToFlowPosition({
        x: clientX,
        y: clientY,
      });
      if (!flow) return;
      const ids = findHitSketchNodes(flow.x, flow.y);
      if (ids.length > 0) deleteNodes(ids);
    },
    [rfInstance, findHitSketchNodes, deleteNodes],
  );

  const handleEraserPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setErasing(true);
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      setEraserPos({ x: lx, y: ly });
      eraseAtClient(e.clientX, e.clientY);
    },
    [toLocal, eraseAtClient],
  );

  const handleEraserPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const { lx, ly } = toLocal(e.clientX, e.clientY);
      setEraserPos({ x: lx, y: ly });
      if (e.buttons !== 1) return;
      eraseAtClient(e.clientX, e.clientY);
    },
    [toLocal, eraseAtClient],
  );

  const handleEraserPointerUp = useCallback((e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setErasing(false);
  }, []);

  const handleEraserPointerLeave = useCallback(() => {
    setEraserPos(null);
  }, []);

  const zoom = rfInstance?.getViewport().zoom ?? 1;

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
    // Eraser cursor radius is in screen-space px; flow-space radius is
    // multiplied by zoom so the indicator visually matches the hit area.
    const cursorRadius = eraserRadius * zoom;
    return (
      <div
        ref={overlayRef}
        className="absolute inset-0 z-4"
        style={{ cursor: 'none' }}
        onPointerDown={handleEraserPointerDown}
        onPointerMove={handleEraserPointerMove}
        onPointerUp={handleEraserPointerUp}
        onPointerLeave={handleEraserPointerLeave}
      >
        {eraserPos && (
          <svg className="pointer-events-none h-full w-full">
            <circle
              cx={eraserPos.x}
              cy={eraserPos.y}
              r={cursorRadius}
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
      onPointerMove={points.length > 0 ? handlePointerMove : undefined}
      onPointerUp={handlePointerUp}
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
