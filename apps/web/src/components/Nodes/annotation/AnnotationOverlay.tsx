import { createId } from '@sediment/shared';
import { useCallback, useRef, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';

import { pointsToPath, ANNOTATION_OPTIONS } from './annotationPath';

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

  // Add stroke thickness padding
  const pad = ANNOTATION_OPTIONS.size * 0.5;
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
 * Renders a live SVG preview of the current stroke, then creates an
 * annotation node on pointer-up.
 */
export function AnnotationOverlay({
  rfInstance,
}: {
  rfInstance: ReactFlowInstance | null;
}) {
  const addNode = useCanvasStore((s) => s.addNode);

  // Two parallel arrays:
  // - screenPtsRef: raw clientX/clientY for screenToFlowPosition (node creation)
  // - points (state): overlay-relative coords for live SVG preview
  const screenPtsRef = useRef<number[][]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<number[][]>([]);

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
      );

      const nodeId = createId('node');

      addNode({
        id: nodeId,
        nodeType: 'annotation',
        // placementPoint is the top-left of the new node, which here is
        // the top-left of the stroke's bounding box.
        placementPoint: {
          x: result.position.x,
          y: result.position.y,
        },
        size: { width: result.width, height: result.height },
        data: {
          type: 'annotation',
          points: result.points,
          initialSize: result.initialSize,
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
    [rfInstance, addNode],
  );

  const zoom = rfInstance?.getViewport().zoom ?? 1;

  // Pencil cursor with white outline (drawn first, thick) + black inner
  // stroke (drawn on top, thin) so it stays legible on any background.
  // The pencil tip in the SVG sits near (3, 21), so we hot-spot the cursor
  // there: drawing starts exactly under the rendered tip.
  const pencilCursor =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'><g stroke='white' stroke-width='3.5'><path d='M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'/><path d='m15 5 4 4'/></g><g stroke='black' stroke-width='1.5'><path d='M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'/><path d='m15 5 4 4'/></g></svg>\") 3 21, crosshair";

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-4"
      style={{ cursor: pencilCursor }}
      onPointerDown={handlePointerDown}
      onPointerMove={points.length > 0 ? handlePointerMove : undefined}
      onPointerUp={handlePointerUp}
    >
      <svg className="h-full w-full">
        {points.length > 0 && (
          <path d={pointsToPath(points, zoom)} fill="#000000" />
        )}
      </svg>
    </div>
  );
}
