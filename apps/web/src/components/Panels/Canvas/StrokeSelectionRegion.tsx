import { ViewportPortal } from '@xyflow/react';
import { memo } from 'react';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

/**
 * The retained lasso loop for a stroke-level selection (Stage 2), drawn in
 * flow-space so it pans/zooms with the canvas. GoodNotes-style: the loop
 * stays after selection so the user can drag inside it to move the strokes;
 * while a move drag is in progress it follows the live offset. Purely
 * visual + non-interactive (the move gesture is claimed by the pointer
 * router via point-in-polygon, not by this element).
 */
export const StrokeSelectionRegion = memo(() => {
  const polygon = useGesturePreviewStore((s) => s.sketchSelectionPolygon);
  const move = useGesturePreviewStore((s) => s.sketchStrokeMovePreview);

  if (!polygon || polygon.length < 3) return null;

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of polygon) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const dx = move?.dx ?? 0;
  const dy = move?.dy ?? 0;
  const points = polygon.map((p) => `${p.x - x1},${p.y - y1}`).join(' ');

  return (
    <ViewportPortal>
      <svg
        className="pointer-events-none absolute overflow-visible"
        style={{ left: x1 + dx, top: y1 + dy, width: w, height: h }}
        viewBox={`0 0 ${w} ${h}`}
      >
        <polygon
          points={points}
          fill="var(--color-info)"
          fillOpacity={0.06}
          stroke="var(--color-info)"
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </ViewportPortal>
  );
});
StrokeSelectionRegion.displayName = 'StrokeSelectionRegion';
