// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore, useViewport } from '@xyflow/react';
import { memo } from 'react';
import { createPortal } from 'react-dom';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

/**
 * The retained lasso loop for a committed lasso selection. Its source polygon
 * stays in flow-space, then this component projects it into the topmost Canvas
 * HUD so it follows pan/zoom without competing with node stacking contexts.
 * GoodNotes-style: the loop stays after selection so the user can drag inside
 * it to move the whole selection; during a move it follows the live offset.
 *
 * The loop only renders when a selection's retained polygon exists, so it
 * always represents a grab-to-move affordance. The HUD is visual-only so
 * native node controls remain reachable; the pointer router claims the actual
 * move gesture from screen coordinates via point-in-polygon.
 */
export const StrokeSelectionRegion = memo(() => {
  const polygon = useGesturePreviewStore((s) => s.sketchSelectionPolygon);
  const move = useGesturePreviewStore((s) => s.sketchStrokeMovePreview);
  const { zoom, x: viewportX, y: viewportY } = useViewport();
  const domNode = useStore((state) => state.domNode);

  if (!polygon || polygon.length < 3 || !domNode) return null;

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

  return createPortal(
    <svg
      data-stroke-selection-region
      data-canvas-grounding-exclude
      className="pointer-events-none absolute z-999 overflow-visible"
      style={{
        left: (x1 + dx) * zoom + viewportX,
        top: (y1 + dy) * zoom + viewportY,
        width: w * zoom,
        height: h * zoom,
      }}
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
    </svg>,
    domNode,
  );
});
StrokeSelectionRegion.displayName = 'StrokeSelectionRegion';
