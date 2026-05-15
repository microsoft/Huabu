import useCanvasStore from '@/store/canvasStore';

import { DEFAULT_STROKE_SIZE } from './sketchPath';

import type { CanvasSketchNodeData } from '../types';

/**
 * Result of a sketch hit-test at a flow-space point.
 *
 * `hits` is ordered bottom-to-top in z-order (matching the canvas
 * `nodes` array order, which mirrors render order). The last entry is
 * the visually-topmost sketch whose stroke is under the cursor.
 */
export interface SketchHitResult {
  /** All sketch nodes whose stroke is within `hitRadius` of the point. */
  hits: string[];
  /** Visually topmost stroke hit (or `null` if no hit). */
  topmost: string | null;
}

/**
 * Find every sketch node whose stroke is within `hitRadius` of the given
 * flow-space point.
 *
 * Mirrors the geometry the eraser uses (see `SketchOverlay.findHitSketchNodes`):
 *  - cheap bounding-box reject (expanded by hit radius)
 *  - then iterate the stored input points (scaled by any user resize)
 *  - distance test folds in half stroke thickness so thicker strokes are
 *    easier to hit
 *
 * @param flowX     Flow-space X coordinate of the test point.
 * @param flowY     Flow-space Y coordinate of the test point.
 * @param hitRadius Extra radius around the point in flow-space units.
 *                  Use a small value (e.g. 2–4) for hover, larger (12+)
 *                  for the eraser brush.
 */
export function findSketchHits(
  flowX: number,
  flowY: number,
  hitRadius: number,
): SketchHitResult {
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
    const r = hitRadius + halfStroke;

    // Bounding-box reject (expanded by hit radius)
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

  return {
    hits,
    topmost: hits.length > 0 ? hits[hits.length - 1] : null,
  };
}
