import {
  createAbsolutePositionGetter,
  getSketchRenderedSize,
  indexById,
  type NestableNode,
} from '@sediment/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

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
  /** Visually topmost sketch hit (or `null` if no hit). */
  topmost: string | null;
}

/**
 * Per-stroke hit \u2014 used by the eraser to delete individual strokes
 * (not the whole node) when the brush passes over them.
 */
export interface SketchStrokeHit {
  nodeId: string;
  strokeId: string;
}

/**
 * Cheap bounding-box reject for a sketch node, expanded by `r`.
 *
 * Returns `null` if the (`flowX`, `flowY`) point is outside the bbox
 * after expansion; otherwise returns the node-local scale factors
 * (`scaleX`, `scaleY`) and the node origin (`x0`, `y0`) so the caller
 * can map node-local stroke points to flow coordinates without
 * recomputing them.
 *
 * `x0` / `y0` are **absolute** flow-space coordinates — when the sketch
 * is parented to a frame, `node.position` is relative to that parent,
 * so we need the resolved absolute position for the bbox to line up
 * with the pointer's flow-space hit point.
 */
type SketchStoreNode = ReturnType<
  typeof useCanvasStore.getState
>['nodes'][number];

/**
 * Resolve a sketch node's flow-space mapping — the resize scale
 * (`current size / initialSize`) plus its absolute origin (`x0`, `y0`) and
 * current size (`w`, `h`). Shared by every sketch hit-test / bounds helper
 * so the coordinate math lives in exactly one place.
 */
function sketchFlowTransform(
  node: SketchStoreNode,
  data: CanvasSketchNodeData,
  absPos: { x: number; y: number },
): {
  scaleX: number;
  scaleY: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
} {
  const baseW = data.initialSize?.width || 1;
  const baseH = data.initialSize?.height || 1;
  // Single source of truth for the rendered size (style -> measured ->
  // node.width -> initialSize). Keeps every hit-test / bounds helper aligned with
  // the geometry builders in sketchMerge; falls back to the baked base size
  // only for a degenerate node with no size info at all.
  const rendered = getSketchRenderedSize(node);
  const w = rendered.width || baseW;
  const h = rendered.height || baseH;
  return {
    scaleX: w / baseW,
    scaleY: h / baseH,
    x0: absPos.x,
    y0: absPos.y,
    w,
    h,
  };
}

/**
 * Snapshot the canvas `nodes` plus an absolute-position resolver so a walk
 * can map sketches nested inside frames (whose `node.position` is
 * parent-relative) into absolute flow coordinates. Shared boilerplate for
 * the three sketch walkers below.
 */
function getSketchAbsResolver(): {
  nodes: SketchStoreNode[];
  getAbs: ReturnType<typeof createAbsolutePositionGetter>;
} {
  const nodes = useCanvasStore.getState().nodes;
  const byId = indexById(nodes as NestableNode[]);
  return { nodes, getAbs: createAbsolutePositionGetter(byId) };
}

function nodeReject(
  node: SketchStoreNode,
  data: CanvasSketchNodeData,
  absPos: { x: number; y: number },
  flowX: number,
  flowY: number,
  r: number,
): { scaleX: number; scaleY: number; x0: number; y0: number } | null {
  const { scaleX, scaleY, x0, y0, w, h } = sketchFlowTransform(
    node,
    data,
    absPos,
  );
  if (
    flowX < x0 - r ||
    flowX > x0 + w + r ||
    flowY < y0 - r ||
    flowY > y0 + h + r
  ) {
    return null;
  }
  return { scaleX, scaleY, x0, y0 };
}

/**
 * Return value of the per-hit callback used by {@link walkSketchHits}.
 *
 * - `'next-node'` skips the rest of the current node's strokes (used by
 *   node-level consumers that only need to know "this node was hit").
 * - `'continue'` keeps walking the remaining strokes on the same node
 *   (used by the per-stroke eraser to collect every match).
 */
type HitWalkAction = 'next-node' | 'continue';

/**
 * Shared hit-test driver for sketch nodes. Walks every sketch in
 * z-order, rejects via expanded bounding box, then fires `onHit` once
 * per matching stroke. The callback's return value controls whether
 * we keep scanning the node's remaining strokes or jump to the next
 * node.
 *
 * Geometry mirrors the eraser brush:
 *  - bbox inflated by `hitRadius + maxHalfStroke` so a thick stroke's
 *    bulge that pokes past the stored points' bbox still hits;
 *  - per-stroke distance test inflates by `hitRadius + halfStroke`
 *    for the same reason.
 *
 * Iteration stops at the first matching point on a stroke (callers
 * never need a per-point list).
 */
function walkSketchHits(
  flowX: number,
  flowY: number,
  hitRadius: number,
  onHit: (nodeId: string, strokeId: string) => HitWalkAction,
): void {
  // Resolve absolute positions once per walk so sketches nested inside
  // frames (whose `node.position` is parent-relative) still hit-test
  // against the pointer's absolute flow coordinates.
  const { nodes, getAbs } = getSketchAbsResolver();

  for (const node of nodes) {
    if (node.type !== 'sketch') continue;
    const data = node.data as CanvasSketchNodeData;
    const strokes = data.strokes ?? [];
    if (strokes.length === 0) continue;

    // Inflate bbox by the thickest stroke's half-width so we don't reject
    // a point that's actually on the bulge of a fat stroke poking outside
    // the stored points' bounding box.
    const maxHalfStroke = strokes.reduce(
      (m, s) => Math.max(m, (s.size ?? 0) / 2),
      0,
    );
    const r = hitRadius + maxHalfStroke;
    const absPos = getAbs(node.id) ?? node.position;
    const reject = nodeReject(node, data, absPos, flowX, flowY, r);
    if (!reject) continue;

    let advanceToNextNode = false;
    for (const stroke of strokes) {
      if (advanceToNextNode) break;
      const halfStroke = (stroke.size ?? 0) / 2;
      const sr = hitRadius + halfStroke;
      const sr2 = sr * sr;
      for (const pt of stroke.points) {
        const px = reject.x0 + pt[0] * reject.scaleX;
        const py = reject.y0 + pt[1] * reject.scaleY;
        const dx = px - flowX;
        const dy = py - flowY;
        if (dx * dx + dy * dy <= sr2) {
          if (onHit(node.id, stroke.id) === 'next-node') {
            advanceToNextNode = true;
          }
          break;
        }
      }
    }
  }
}

/**
 * Find every sketch node whose stroke is within `hitRadius` of the given
 * flow-space point.
 *
 * Used by node-level consumers: hover routing for click-through, sketch
 * selection. The eraser uses the per-stroke variant below.
 *
 * @param flowX     Flow-space X coordinate of the test point.
 * @param flowY     Flow-space Y coordinate of the test point.
 * @param hitRadius Extra radius around the point in flow-space units.
 *                  Use a small value (e.g. 2\u20134) for hover, larger (12+)
 *                  for the eraser brush.
 */
export function findSketchHits(
  flowX: number,
  flowY: number,
  hitRadius: number,
): SketchHitResult {
  const hits: string[] = [];
  walkSketchHits(flowX, flowY, hitRadius, (nodeId) => {
    hits.push(nodeId);
    return 'next-node';
  });
  return {
    hits,
    topmost: hits.length > 0 ? hits[hits.length - 1] : null,
  };
}

/**
 * Per-stroke variant of {@link findSketchHits} \u2014 returns one entry per
 * (node, stroke) pair the brush touches.
 *
 * Used by the eraser so a single stroke can be removed without taking
 * the whole node down with it. Iteration order mirrors `findSketchHits`
 * (bottom-to-top in z-order, then back-to-front within a node).
 */
export function findSketchStrokeHits(
  flowX: number,
  flowY: number,
  hitRadius: number,
): SketchStrokeHit[] {
  const out: SketchStrokeHit[] = [];
  walkSketchHits(flowX, flowY, hitRadius, (nodeId, strokeId) => {
    out.push({ nodeId, strokeId });
    return 'continue';
  });
  return out;
}

/** Flow-space point, matching the lasso polygon's vertex shape. */
interface FlowPoint {
  x: number;
  y: number;
}

/**
 * Ray-cast point-in-polygon test (even-odd rule). `poly` is a closed
 * polygon given as an ordered vertex list; the closing edge is implied.
 */
export function isPointInFlowPolygon(
  px: number,
  py: number,
  poly: readonly FlowPoint[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Find sketch strokes whose geometry falls inside a flow-space lasso
 * polygon (Stage 2 stroke-level selection). A stroke is captured when
 * at least one of its points lands inside the polygon — lenient, which
 * matches lasso intuition.
 *
 * Returns a map of `nodeId -> strokeIds`; sketch nodes with no captured
 * stroke are omitted, so an empty result means "the lasso hit no ink".
 * Coordinates mirror {@link walkSketchHits} (absolute position + the
 * node's current resize scale) so sketches nested inside frames line up.
 */
export function findSketchStrokesInPolygon(
  flowPolygon: readonly FlowPoint[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (flowPolygon.length < 3) return out;

  const { nodes, getAbs } = getSketchAbsResolver();

  for (const node of nodes) {
    if (node.type !== 'sketch') continue;
    const data = node.data as CanvasSketchNodeData;
    const strokes = data.strokes ?? [];
    if (strokes.length === 0) continue;

    const abs = getAbs(node.id) ?? node.position;
    const { scaleX, scaleY, x0, y0 } = sketchFlowTransform(node, data, abs);

    const matched: string[] = [];
    for (const stroke of strokes) {
      for (const pt of stroke.points) {
        const px = x0 + pt[0] * scaleX;
        const py = y0 + pt[1] * scaleY;
        if (isPointInFlowPolygon(px, py, flowPolygon)) {
          matched.push(stroke.id);
          break;
        }
      }
    }
    if (matched.length > 0) out[node.id] = matched;
  }

  return out;
}

/**
 * Union bounding box (flow-space, absolute) of a stroke-level selection
 * (`nodeId -> strokeIds`), inflated by each stroke's half-width so the
 * box encloses the painted bulge. Returns `null` for an empty selection.
 * Used to anchor the stroke-selection floating toolbar.
 */
export function getSketchStrokeSelectionBounds(
  selection: Record<string, readonly string[]>,
): { x: number; y: number; width: number; height: number } | null {
  if (Object.keys(selection).length === 0) return null;

  const { nodes, getAbs } = getSketchAbsResolver();

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;

  for (const node of nodes) {
    if (node.type !== 'sketch') continue;
    const wanted = selection[node.id];
    if (!wanted || wanted.length === 0) continue;
    const wantedSet = new Set(wanted);

    const data = node.data as CanvasSketchNodeData;
    const strokes = data.strokes ?? [];
    const abs = getAbs(node.id) ?? node.position;
    const { scaleX, scaleY, x0, y0 } = sketchFlowTransform(node, data, abs);

    for (const stroke of strokes) {
      if (!wantedSet.has(stroke.id)) continue;
      const half = (stroke.size ?? 0) / 2;
      for (const pt of stroke.points) {
        const px = x0 + pt[0] * scaleX;
        const py = y0 + pt[1] * scaleY;
        x1 = Math.min(x1, px - half);
        y1 = Math.min(y1, py - half);
        x2 = Math.max(x2, px + half);
        y2 = Math.max(y2, py + half);
      }
    }
  }

  if (x1 === Infinity) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
