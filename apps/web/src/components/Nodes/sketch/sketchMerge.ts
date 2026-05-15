/**
 * Stroke-merge helpers for the sketch tool.
 *
 * When the user finishes a stroke, we don't always create a brand-new
 * sketch node. If there's a *recent* sketch node nearby that the user
 * was just doodling on, we instead append the new stroke onto that node
 * (Microsoft Whiteboard / Procreate behaviour). This avoids littering
 * the canvas with one node per pen lift.
 *
 * Decision rules (tuned per plan v2.1):
 *  - Time window: the candidate's most-recent stroke must have been
 *    drawn in the last `MERGE_TIME_WINDOW_MS` ms.
 *  - Proximity: the new stroke's flow-space bbox must be within
 *    `MERGE_PROXIMITY_PX` flow units of the candidate's current bbox
 *    (axis-aligned distance, zero on overlap).
 *  - Same parent only: cross-frame merging is forbidden \u2014 a sketch
 *    inside a frame never merges with one outside, and vice versa.
 *  - Cross-color is allowed: merging a black scribble onto a red one
 *    just produces a node with mixed-color strokes, since each stroke
 *    keeps its own `color` / `size`.
 *  - Tiebreak: most recently touched candidate wins; on ties, the
 *    closest bbox wins.
 *
 * If no candidate qualifies, the caller falls back to creating a new
 * sketch node.
 */

import useCanvasStore from '@/store/canvasStore';

import type { CanvasSketchNodeData } from '../types';
import type {
  CanvasCommand,
  CanvasNodeId,
  SketchStroke,
} from '@sediment/shared';

/**
 * Maximum gap, in ms, between the candidate's most-recent stroke and
 * the new stroke's pointer-up. Beyond this, the new stroke starts a
 * fresh sketch node.
 */
export const MERGE_TIME_WINDOW_MS = 1500;

/**
 * Maximum distance, in flow-space pixels, between the new stroke's
 * bbox and the candidate's current bbox. Distance is axis-aligned and
 * collapses to zero whenever the bboxes overlap.
 */
export const MERGE_PROXIMITY_PX = 80;

/** Axis-aligned bounding box in flow-space coordinates. */
export interface FlowBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Axis-aligned bbox-to-bbox distance. Zero whenever the rects overlap
 * or touch; otherwise the Euclidean distance between their nearest
 * points.
 */
function bboxDistance(a: FlowBBox, b: FlowBBox): number {
  const dx = Math.max(
    0,
    Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)),
  );
  const dy = Math.max(
    0,
    Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)),
  );
  return Math.hypot(dx, dy);
}

/**
 * Return the most-recently-touched stroke timestamp on a sketch node.
 * Returns `0` if the node has no strokes (defensive \u2014 schema requires
 * at least one).
 */
function latestStrokeAt(strokes: readonly SketchStroke[]): number {
  let max = 0;
  for (const s of strokes) {
    if (s.createdAt > max) max = s.createdAt;
  }
  return max;
}

/**
 * Find an eligible sketch node to merge a brand-new stroke into, or
 * `null` if no candidate qualifies.
 *
 * @param newBboxFlow  Flow-space bbox of the just-finished stroke.
 * @param newParentId  Parent frame ID of the new stroke (or `null` for
 *                     top-level). Cross-frame matches are rejected.
 * @param now          Wall-clock timestamp of the pointer-up event,
 *                     in ms (typically `Date.now()`).
 */
export function findMergeTarget(
  newBboxFlow: FlowBBox,
  newParentId: CanvasNodeId | null,
  now: number,
): CanvasNodeId | null {
  const nodes = useCanvasStore.getState().nodes;

  let best: { id: CanvasNodeId; touchedAt: number; dist: number } | null = null;

  for (const node of nodes) {
    if (node.type !== 'sketch') continue;
    if ((node.parentId ?? null) !== newParentId) continue;

    const data = node.data as CanvasSketchNodeData;
    const strokes = data.strokes ?? [];
    if (strokes.length === 0) continue;

    const touchedAt = latestStrokeAt(strokes);
    if (now - touchedAt > MERGE_TIME_WINDOW_MS) continue;

    const w =
      node.measured?.width ?? node.width ?? data.initialSize?.width ?? 0;
    const h =
      node.measured?.height ?? node.height ?? data.initialSize?.height ?? 0;
    const candBbox: FlowBBox = {
      x: node.position.x,
      y: node.position.y,
      width: w,
      height: h,
    };

    const dist = bboxDistance(newBboxFlow, candBbox);
    if (dist > MERGE_PROXIMITY_PX) continue;

    if (
      !best ||
      touchedAt > best.touchedAt ||
      (touchedAt === best.touchedAt && dist < best.dist)
    ) {
      best = { id: node.id as CanvasNodeId, touchedAt, dist };
    }
  }

  return best?.id ?? null;
}

/**
 * Build the commands to fold a brand-new stroke into an existing
 * sketch node.
 *
 * The merge does three things at once:
 *  1. Bake any user resize into the existing strokes' coordinates.
 *     We multiply each stored point by the current `currentSize / initialSize`
 *     scale, so all strokes end up in the same coord space again.
 *  2. Append the new stroke (translated from absolute flow coords into
 *     the merged node's local frame).
 *  3. Recompute the union bbox so the node grows just enough to enclose
 *     the new stroke; reset `initialSize` to the new size so the local
 *     scale starts at 1 again.
 *
 * Returned commands MUST be executed together (single `executeCommands`
 * call). Caller is responsible for `beginGesture('SET_NODE_GEOMETRY')`
 * beforehand so the geometry change is captured by undo.
 *
 * @param targetNodeId    Sketch node returned by {@link findMergeTarget}.
 * @param newStrokePoints New stroke's points, *local to its own bbox*
 *                        (i.e. exactly what `processPoints` returns:
 *                        [x, y, pressure?] tuples in [0..width] \u00d7
 *                        [0..height]).
 * @param newBboxFlow     Flow-space bbox of the new stroke.
 * @param color           New stroke's color.
 * @param size            New stroke's nominal size.
 * @param now             Pointer-up timestamp.
 * @param newStrokeId     Pre-allocated id for the new stroke (so the
 *                        caller can reference it later if needed).
 */
export function buildMergeCommands(
  targetNodeId: CanvasNodeId,
  newStrokePoints: number[][],
  newBboxFlow: FlowBBox,
  color: string,
  size: number,
  now: number,
  newStrokeId: string,
): CanvasCommand[] {
  const node = useCanvasStore
    .getState()
    .nodes.find((n) => n.id === targetNodeId);
  if (!node || node.type !== 'sketch') return [];

  const data = node.data as CanvasSketchNodeData;
  const baseW = data.initialSize?.width || 1;
  const baseH = data.initialSize?.height || 1;
  const curW = node.measured?.width ?? node.width ?? baseW;
  const curH = node.measured?.height ?? node.height ?? baseH;
  const scaleX = curW / baseW;
  const scaleY = curH / baseH;

  // The OLD bbox in flow coords (post-resize).
  const oldBboxFlow: FlowBBox = {
    x: node.position.x,
    y: node.position.y,
    width: curW,
    height: curH,
  };

  // Union bbox (flow coords) \u2014 this is the new node's geometry.
  const x1 = Math.min(oldBboxFlow.x, newBboxFlow.x);
  const y1 = Math.min(oldBboxFlow.y, newBboxFlow.y);
  const x2 = Math.max(
    oldBboxFlow.x + oldBboxFlow.width,
    newBboxFlow.x + newBboxFlow.width,
  );
  const y2 = Math.max(
    oldBboxFlow.y + oldBboxFlow.height,
    newBboxFlow.y + newBboxFlow.height,
  );
  const unionW = x2 - x1;
  const unionH = y2 - y1;

  // How much to shift each existing point: from "OLD-local, scaled" into
  // "new-local". We bake the scale and then translate by (oldOriginFlow
  // \u2212 newOriginFlow).
  const oldShiftX = oldBboxFlow.x - x1;
  const oldShiftY = oldBboxFlow.y - y1;
  const bakedExisting: SketchStroke[] = data.strokes.map((s) => ({
    ...s,
    points: s.points.map((p) => {
      const px = p[0] * scaleX + oldShiftX;
      const py = p[1] * scaleY + oldShiftY;
      // Preserve any extra components (pressure at index 2, etc.) without
      // assuming they exist.
      return p.length > 2 ? [px, py, ...p.slice(2)] : [px, py];
    }),
  }));

  // New stroke arrives in bbox-local coords; just translate by
  // (newOriginFlow \u2212 unionOriginFlow).
  const newShiftX = newBboxFlow.x - x1;
  const newShiftY = newBboxFlow.y - y1;
  const newStroke: SketchStroke = {
    id: newStrokeId,
    color,
    size,
    createdAt: now,
    points: newStrokePoints.map((p) => {
      const px = p[0] + newShiftX;
      const py = p[1] + newShiftY;
      return p.length > 2 ? [px, py, ...p.slice(2)] : [px, py];
    }),
  };

  const mergedStrokes = [...bakedExisting, newStroke];

  return [
    {
      type: 'MERGE_NODE_DATA',
      patches: [
        {
          nodeId: targetNodeId,
          patch: {
            strokes: mergedStrokes,
            initialSize: { width: unionW, height: unionH },
          },
        },
      ],
    },
    {
      type: 'SET_NODE_GEOMETRY',
      items: [
        {
          nodeId: targetNodeId,
          position: { x: x1, y: y1 },
          size: { width: unionW, height: unionH },
        },
      ],
    },
  ];
}

/**
 * Build the commands needed to erase one or more strokes from a sketch
 * node.
 *
 * Two outcomes:
 *  - All of the node's strokes are erased \u2192 returns a single
 *    `DELETE_NODES` command. The whole node is gone.
 *  - Some strokes survive \u2192 returns `[MERGE_NODE_DATA, SET_NODE_GEOMETRY]`
 *    that:
 *      1. Bakes any user resize into the survivors' coordinates.
 *      2. Reframes the node tightly around the survivors (padded by
 *         each stroke's own thickness so the visual halo stays
 *         enclosed).
 *      3. Resets `initialSize` so the node's local scale starts at 1
 *         again.
 *
 * If no strokes are actually being removed (e.g. the brush hit
 * something the store already knows nothing about), returns `[]`.
 *
 * The geometry change uses snapshot:'caller'. Caller is responsible
 * for `beginGesture('SET_NODE_GEOMETRY')` before `executeCommands`.
 *
 * @param targetNodeId      Sketch node to erase from.
 * @param removedStrokeIds  Set of stroke ids to remove.
 */
export function buildEraseCommands(
  targetNodeId: CanvasNodeId,
  removedStrokeIds: Set<string>,
): CanvasCommand[] {
  if (removedStrokeIds.size === 0) return [];

  const node = useCanvasStore
    .getState()
    .nodes.find((n) => n.id === targetNodeId);
  if (!node || node.type !== 'sketch') return [];

  const data = node.data as CanvasSketchNodeData;
  const remaining = data.strokes.filter((s) => !removedStrokeIds.has(s.id));

  // No survivors \u2014 the whole node goes.
  if (remaining.length === 0) {
    return [{ type: 'DELETE_NODES', nodeIds: [targetNodeId] }];
  }

  // Same length \u2014 nothing actually changed (target ids didn't match any
  // current stroke). Skip silently rather than emit a no-op undo entry.
  if (remaining.length === data.strokes.length) return [];

  const baseW = data.initialSize?.width || 1;
  const baseH = data.initialSize?.height || 1;
  const curW = node.measured?.width ?? node.width ?? baseW;
  const curH = node.measured?.height ?? node.height ?? baseH;
  const scaleX = curW / baseW;
  const scaleY = curH / baseH;
  const O = { x: node.position.x, y: node.position.y };

  // Tight bbox of survivor strokes in flow coords, padded per stroke by
  // its own size/2 (perfect-freehand can paint up to `size` wide).
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;

  for (const s of remaining) {
    const pad = (s.size ?? 0) / 2;
    for (const p of s.points) {
      const fx = O.x + p[0] * scaleX;
      const fy = O.y + p[1] * scaleY;
      if (fx - pad < x1) x1 = fx - pad;
      if (fy - pad < y1) y1 = fy - pad;
      if (fx + pad > x2) x2 = fx + pad;
      if (fy + pad > y2) y2 = fy + pad;
    }
  }

  // All survivors are degenerate (empty point arrays) \u2014 treat as full
  // delete since there's nothing left to draw.
  if (!Number.isFinite(x1)) {
    return [{ type: 'DELETE_NODES', nodeIds: [targetNodeId] }];
  }

  const unionW = x2 - x1;
  const unionH = y2 - y1;

  // Bake scale + reframe each survivor's points into the new local
  // coordinate space (top-left = (x1, y1)).
  const baked: SketchStroke[] = remaining.map((s) => ({
    ...s,
    points: s.points.map((p) => {
      const px = p[0] * scaleX + (O.x - x1);
      const py = p[1] * scaleY + (O.y - y1);
      return p.length > 2 ? [px, py, ...p.slice(2)] : [px, py];
    }),
  }));

  return [
    {
      type: 'MERGE_NODE_DATA',
      patches: [
        {
          nodeId: targetNodeId,
          patch: {
            strokes: baked,
            initialSize: { width: unionW, height: unionH },
          },
        },
      ],
    },
    {
      type: 'SET_NODE_GEOMETRY',
      items: [
        {
          nodeId: targetNodeId,
          position: { x: x1, y: y1 },
          size: { width: unionW, height: unionH },
        },
      ],
    },
  ];
}
