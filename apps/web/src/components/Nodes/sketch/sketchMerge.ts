/**
 * Stroke-merge helpers for the sketch tool.
 *
 * When the user finishes a stroke, we don't always create a brand-new
 * sketch node. If there's a sketch node (a "region") nearby, we instead
 * append the new stroke onto that node (Microsoft Whiteboard / Procreate
 * behaviour). This avoids littering the canvas with one node per pen lift
 * and keeps a continuous piece of handwriting in a single region.
 *
 * Decision rules:
 *  - Purely spatial: the target is the *nearest* existing sketch region
 *    within `maxDistance` of the new stroke's bbox. Time is NOT a factor
 *    — coming back to write next to an old region still merges into it,
 *    so a mid-writing think-pause can never split a line across nodes.
 *    Per-stroke `createdAt` is preserved as intra-region metadata, but it
 *    no longer influences the region boundary.
 *  - Proximity: the new stroke's bbox must be within `maxDistance`
 *    units of the candidate's current bbox (axis-aligned, zero on
 *    overlap). The caller chooses the unit — typically by converting
 *    `SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX / zoom` so the
 *    threshold stays constant on screen as the user pans / zooms.
 *  - Same parent only: cross-frame merging is forbidden — a sketch
 *    inside a frame never merges with one outside, and vice versa.
 *    The caller is responsible for converting `newBboxFlow` into the
 *    parent's local coordinate space (i.e. the same space
 *    `node.position` uses for parented nodes) before calling this.
 *  - Cross-color is allowed: merging a black scribble onto a red one
 *    just produces a node with mixed-color strokes, since each stroke
 *    keeps its own `color` / `size`.
 *  - Tiebreak: nearest bbox edge distance wins; on ties, the nearest
 *    bbox centre wins (still purely spatial, deterministic).
 *
 * Only ever targets a single existing region for the new stroke; it
 * never merges two existing regions (that "bridging" merge is a separate,
 * later concern). If no candidate qualifies, the caller falls back to
 * creating a new sketch node.
 */

import {
  getAbsolutePosition,
  getSketchRenderedSize,
} from '@sediment/shared/canvas-engine';

import { canvasHistoryManager } from '@/store/canvasHistoryManager';
import useCanvasStore from '@/store/canvasStore';

import type { CanvasSketchNodeData } from '../types';
import type {
  CanvasCommand,
  CanvasNodeId,
  SketchStroke,
} from '@sediment/shared';
import type { NestableNode } from '@sediment/shared/canvas-engine';
import type { Node } from '@xyflow/react';

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

 * Find an eligible sketch node to merge a brand-new stroke into, or
 * `null` if no candidate qualifies. Purely spatial — the nearest existing
 * sketch region within `maxDistance` wins; time plays no role.
 *
 * @param newBboxFlow  Bbox of the just-finished stroke, in the same
 *                     coordinate space as the candidates' `node.position`
 *                     (i.e. flow-space for top-level strokes,
 *                     parent-local for strokes inside a frame).
 * @param newParentId  Parent frame ID of the new stroke (or `null` for
 *                     top-level). Cross-frame matches are rejected.
 * @param maxDistance  Maximum allowed bbox-to-bbox distance, in the
 *                     same units as `newBboxFlow`. Callers converting
 *                     a screen-space threshold should pass
 *                     `SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX / zoom`.
 */
export function findMergeTarget(
  newBboxFlow: FlowBBox,
  newParentId: CanvasNodeId | null,
  maxDistance: number,
): CanvasNodeId | null {
  const nodes = useCanvasStore.getState().nodes;

  const newCx = newBboxFlow.x + newBboxFlow.width / 2;
  const newCy = newBboxFlow.y + newBboxFlow.height / 2;

  let best: { id: CanvasNodeId; dist: number; centerDist: number } | null =
    null;

  for (const node of nodes) {
    if (node.type !== 'sketch') continue;
    if ((node.parentId ?? null) !== newParentId) continue;

    const data = node.data as CanvasSketchNodeData;
    const strokes = data.strokes ?? [];
    if (strokes.length === 0) continue;

    const { width: w, height: h } = getSketchRenderedSize(node);
    const candBbox: FlowBBox = {
      x: node.position.x,
      y: node.position.y,
      width: w,
      height: h,
    };

    const dist = bboxDistance(newBboxFlow, candBbox);
    if (dist > maxDistance) continue;

    // Deterministic, purely spatial tiebreak: on equal edge distance
    // (e.g. two overlapping regions, both dist 0) prefer the one whose
    // centre is nearest.
    const candCx = candBbox.x + candBbox.width / 2;
    const candCy = candBbox.y + candBbox.height / 2;
    const centerDist = Math.hypot(newCx - candCx, newCy - candCy);

    if (
      !best ||
      dist < best.dist ||
      (dist === best.dist && centerDist < best.centerDist)
    ) {
      best = { id: node.id as CanvasNodeId, dist, centerDist };
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
 * @param targetNodeId      Sketch node returned by {@link findMergeTarget}.
 * @param expectedParentId  Parent the caller believes `targetNodeId`
 *                          lives under (or `null` for top-level). If
 *                          this disagrees with the node's actual
 *                          `parentId`, the merge is refused (returns
 *                          `[]` and warns) — mismatched coord spaces
 *                          would otherwise put the merged geometry in
 *                          the wrong place. Same-parent invariant is
 *                          also what {@link findMergeTarget} enforces.
 * @param newStrokePoints   New stroke's points, *local to its own bbox*
 *                          (i.e. exactly what `processPoints` returns:
 *                          [x, y, pressure?] tuples in [0..width] ×
 *                          [0..height]).
 * @param newBboxFlow       Bbox of the new stroke, in the same coordinate
 *                          space as `node.position` (flow-space for
 *                          top-level, parent-local for parented).
 * @param color             New stroke's color.
 * @param size              New stroke's nominal size.
 * @param now               Pointer-up timestamp.
 * @param newStrokeId       Pre-allocated id for the new stroke (so the
 *                          caller can reference it later if needed).
 */
export function buildMergeCommands(
  targetNodeId: CanvasNodeId,
  expectedParentId: CanvasNodeId | null,
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

  // Guard against coord-space mismatch — see param doc above.
  const actualParentId = (node.parentId ?? null) as CanvasNodeId | null;
  if (actualParentId !== expectedParentId) {
    console.warn(
      '[sketchMerge] buildMergeCommands: parentId mismatch on target',
      targetNodeId,
      { expected: expectedParentId, actual: actualParentId },
    );
    return [];
  }

  const data = node.data as CanvasSketchNodeData;
  const baseW = data.initialSize?.width || 1;
  const baseH = data.initialSize?.height || 1;
  // Single source of truth for the rendered size (style -> measured ->
  // node.width -> initialSize), so this stays in sync with the hit-test that
  // selected this node as the merge target. Falls back to the baked base
  // size only for a degenerate node with no size info at all.
  const rendered = getSketchRenderedSize(node);
  const curW = rendered.width || baseW;
  const curH = rendered.height || baseH;
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
  const node = useCanvasStore
    .getState()
    .nodes.find((n) => n.id === targetNodeId);
  if (!node) return [];
  return computeEraseCommands(node as Node, removedStrokeIds);
}

/**
 * Pure core of {@link buildEraseCommands}: identical logic, but operating
 * on a caller-supplied sketch node snapshot instead of reading the store —
 * so it can run inside a pure UI-intent resolver. Shared with the
 * stroke-transfer builder, whose "source side" (removing the moved strokes
 * from each origin region) is exactly an erase.
 *
 * @param node              Sketch node snapshot to erase from.
 * @param removedStrokeIds  Set of stroke ids to remove.
 */
export function computeEraseCommands(
  node: Node,
  removedStrokeIds: Set<string>,
): CanvasCommand[] {
  if (removedStrokeIds.size === 0) return [];
  if (node.type !== 'sketch') return [];
  const targetNodeId = node.id as CanvasNodeId;

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
  // Same rendered-size source as the hit-test (style -> measured ->
  // node.width -> initialSize) so erase geometry matches what was tested.
  const rendered = getSketchRenderedSize(node);
  const curW = rendered.width || baseW;
  const curH = rendered.height || baseH;
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

/**
 * Build the commands to translate a SUBSET of a sketch node's strokes by
 * `(dxFlow, dyFlow)` flow-space units (Stage 2 in-node move), reframing the
 * node tightly around the result. Mirrors {@link buildEraseCommands} but
 * moves strokes instead of removing them: every stroke is baked into flow
 * space (scale applied), the moved ones get the offset, then all points are
 * reframed into a fresh local space (scale reset to 1).
 *
 * Returns `[]` when nothing would change. Uses `snapshot:'caller'`; caller
 * must `beginGesture('SET_NODE_GEOMETRY')` before `executeCommands`.
 */
export function buildMoveStrokesCommands(
  targetNodeId: CanvasNodeId,
  movedStrokeIds: Set<string>,
  dxFlow: number,
  dyFlow: number,
): CanvasCommand[] {
  if (movedStrokeIds.size === 0) return [];
  if (dxFlow === 0 && dyFlow === 0) return [];

  const node = useCanvasStore
    .getState()
    .nodes.find((n) => n.id === targetNodeId);
  if (!node || node.type !== 'sketch') return [];

  const data = node.data as CanvasSketchNodeData;
  if (data.strokes.length === 0) return [];

  const baseW = data.initialSize?.width || 1;
  const baseH = data.initialSize?.height || 1;
  // Same rendered-size source as the hit-test (style -> measured ->
  // node.width -> initialSize) so move geometry matches what was tested.
  const rendered = getSketchRenderedSize(node);
  const curW = rendered.width || baseW;
  const curH = rendered.height || baseH;
  const scaleX = curW / baseW;
  const scaleY = curH / baseH;
  const O = { x: node.position.x, y: node.position.y };

  // Bake every stroke into flow space; moved strokes get the offset.
  const flowStrokes = data.strokes.map((s) => {
    const moved = movedStrokeIds.has(s.id);
    const ox = moved ? dxFlow : 0;
    const oy = moved ? dyFlow : 0;
    return {
      s,
      pts: s.points.map((p) => {
        const fx = O.x + p[0] * scaleX + ox;
        const fy = O.y + p[1] * scaleY + oy;
        return p.length > 2 ? [fx, fy, ...p.slice(2)] : [fx, fy];
      }),
    };
  });

  // Tight union bbox (flow), padded per stroke by its own size/2.
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const { s, pts } of flowStrokes) {
    const pad = (s.size ?? 0) / 2;
    for (const p of pts) {
      if (p[0] - pad < x1) x1 = p[0] - pad;
      if (p[1] - pad < y1) y1 = p[1] - pad;
      if (p[0] + pad > x2) x2 = p[0] + pad;
      if (p[1] + pad > y2) y2 = p[1] + pad;
    }
  }
  if (!Number.isFinite(x1)) return [];

  const unionW = x2 - x1;
  const unionH = y2 - y1;

  // Reframe every point into the new local space (top-left = x1,y1);
  // resetting initialSize to the union makes the local scale 1 again.
  const bakedMoved: SketchStroke[] = flowStrokes.map(({ s, pts }) => ({
    ...s,
    points: pts.map((p) =>
      p.length > 2
        ? [p[0] - x1, p[1] - y1, ...p.slice(2)]
        : [p[0] - x1, p[1] - y1],
    ),
  }));

  return [
    {
      type: 'MERGE_NODE_DATA',
      patches: [
        {
          nodeId: targetNodeId,
          patch: {
            strokes: bakedMoved,
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

// ---------------------------------------------------------------------------
// Stroke transfer: split into a new region / merge into another region
// ---------------------------------------------------------------------------
//
// Unlike the erase / in-node-move builders above (which stay entirely inside
// a single node and can treat `node.position` as a flat origin), a transfer
// re-homes strokes into a DIFFERENT node — possibly under a different parent
// frame. So the geometry here goes through ABSOLUTE flow coordinates
// (`getAbsolutePosition`): bake each source's moved strokes into absolute
// flow, then reframe them into the destination's local space. When source
// and destination share a parent the offsets cancel and this reduces to the
// same math the in-node builders use.

/** Current render scale of a sketch node (authored size ÷ baked initialSize). */
function sketchNodeScale(node: Node): { scaleX: number; scaleY: number } {
  const data = node.data as CanvasSketchNodeData;
  const baseW = data.initialSize?.width || 1;
  const baseH = data.initialSize?.height || 1;
  // Same rendered-size source as the hit-test (style -> measured ->
  // node.width -> initialSize) so cross-region transfer geometry matches.
  const rendered = getSketchRenderedSize(node);
  const curW = rendered.width || baseW;
  const curH = rendered.height || baseH;
  return { scaleX: curW / baseW, scaleY: curH / baseH };
}

/**
 * Bake the given strokes into ABSOLUTE flow coordinates: apply the node's
 * current resize scale and translate by the node's absolute top-left
 * (`absOrigin` from `getAbsolutePosition`, so this is correct even when the
 * node lives inside a frame), plus an optional extra translation (the drop
 * delta). Extra point components (pressure at index 2, …) are preserved.
 */
function bakeStrokesToAbsFlow(
  strokes: SketchStroke[],
  absOrigin: { x: number; y: number },
  scaleX: number,
  scaleY: number,
  extraDx = 0,
  extraDy = 0,
): SketchStroke[] {
  return strokes.map((s) => ({
    ...s,
    points: s.points.map((p) => {
      const fx = absOrigin.x + p[0] * scaleX + extraDx;
      const fy = absOrigin.y + p[1] * scaleY + extraDy;
      return p.length > 2 ? [fx, fy, ...p.slice(2)] : [fx, fy];
    }),
  }));
}

/**
 * Tight bounding box (flow coords) of already-baked flow strokes, padded per
 * stroke by its own `size / 2` so the perfect-freehand halo stays enclosed.
 * Returns `null` when there are no finite points.
 */
function flowStrokesBounds(
  strokes: SketchStroke[],
): { x1: number; y1: number; x2: number; y2: number } | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const s of strokes) {
    const pad = (s.size ?? 0) / 2;
    for (const p of s.points) {
      if (p[0] - pad < x1) x1 = p[0] - pad;
      if (p[1] - pad < y1) y1 = p[1] - pad;
      if (p[0] + pad > x2) x2 = p[0] + pad;
      if (p[1] + pad > y2) y2 = p[1] + pad;
    }
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null;
}

/** Reframe flow-coord strokes into a local space whose origin is (ox, oy). */
function reframeFlowStrokes(
  strokes: SketchStroke[],
  ox: number,
  oy: number,
): SketchStroke[] {
  return strokes.map((s) => ({
    ...s,
    points: s.points.map((p) =>
      p.length > 2
        ? [p[0] - ox, p[1] - oy, ...p.slice(2)]
        : [p[0] - ox, p[1] - oy],
    ),
  }));
}

/** Parameters for {@link buildSketchStrokeTransferCommands}. */
export interface SketchStrokeTransferParams {
  /** Full node list — for absolute-position + target lookups. */
  nodes: Node[];
  /** Per-source stroke ids to pull out of each origin region. */
  sources: Array<{ nodeId: CanvasNodeId; strokeIds: string[] }>;
  /** Flow-space translation applied to the extracted strokes (drop delta). */
  dropDelta: { dx: number; dy: number };
  /**
   * Existing sketch region to merge the strokes into, or `null` to split
   * them out into a brand-new region.
   */
  targetNodeId: CanvasNodeId | null;
  /** Pre-allocated id for the new region (used only when `targetNodeId` is `null`). */
  newNodeId: CanvasNodeId;
  /**
   * Parent frame for the NEW region (a `findFrameAtPoint` / `resolveFrameAtPoint`
   * result at the drop point). Ignored when merging into an existing target —
   * the moved strokes simply adopt the target's own parent.
   */
  destParentId: CanvasNodeId | null;
}

/**
 * Build the command batch for a stroke-level split / cross-region move:
 * remove a subset of strokes from one or more source regions and re-home
 * them either into an existing region (`targetNodeId`) or a fresh region
 * (`targetNodeId === null`).
 *
 * Outcome per side:
 *  - **Source(s)**: reuse {@link computeEraseCommands} — survivors are
 *    reframed, or the whole node is deleted if every stroke moved out.
 *  - **Destination**: the moved strokes are baked into absolute flow (with
 *    the drop delta), unioned with the target's existing strokes (merge) or
 *    on their own (split), then reframed into the destination's local space.
 *
 * Returns `[]` (a no-op) when nothing meaningful would move, so callers
 * never delete strokes without re-homing them. The batch mixes
 * `snapshot:'caller'` (`SET_NODE_GEOMETRY`) and self-snapshot commands
 * (`CREATE_NODES` / `DELETE_NODES`); commit it inside a single
 * `beginNodeDataGesture` / `endNodeDataGesture` bracket so it folds into one
 * undo entry regardless of which branch fired.
 *
 * Pure over its `nodes` snapshot (no store reads), so it runs inside a
 * UI-intent resolver.
 */
export function buildSketchStrokeTransferCommands(
  params: SketchStrokeTransferParams,
): CanvasCommand[] {
  const { nodes, dropDelta, targetNodeId, newNodeId, destParentId } = params;
  const nn = nodes as unknown as NestableNode[];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ── 1. Extract the moved strokes from every source into absolute flow ──
  const extractedFlow: SketchStroke[] = [];
  const sourceCommands: CanvasCommand[] = [];
  for (const { nodeId, strokeIds } of params.sources) {
    if (strokeIds.length === 0) continue;
    // A source that is also the drop target is an in-node move, not a
    // transfer — handled by the caller's move path, skip here.
    if (nodeId === targetNodeId) continue;
    const node = byId.get(nodeId);
    if (!node || node.type !== 'sketch') continue;
    const data = node.data as CanvasSketchNodeData;
    const keep = new Set(strokeIds);
    const moved = (data.strokes ?? []).filter((s) => keep.has(s.id));
    if (moved.length === 0) continue;

    const absOrigin = getAbsolutePosition(nn, nodeId) ?? node.position;
    const { scaleX, scaleY } = sketchNodeScale(node);
    extractedFlow.push(
      ...bakeStrokesToAbsFlow(
        moved,
        absOrigin,
        scaleX,
        scaleY,
        dropDelta.dx,
        dropDelta.dy,
      ),
    );

    // Source side = erase the moved strokes (rebake survivors / delete node
    // when the region is emptied).
    sourceCommands.push(...computeEraseCommands(node, keep));
  }

  const movedBounds = flowStrokesBounds(extractedFlow);
  // Nothing meaningful to move (no source matched, or degenerate geometry) —
  // abort entirely so we never delete strokes without re-homing them.
  if (!movedBounds || extractedFlow.length === 0) return [];

  if (targetNodeId !== null) {
    // ── 2a. Merge the moved strokes into an existing region ──
    const target = byId.get(targetNodeId);
    if (!target || target.type !== 'sketch') return [];
    const targetData = target.data as CanvasSketchNodeData;
    const targetAbs = getAbsolutePosition(nn, targetNodeId) ?? target.position;
    const { scaleX, scaleY } = sketchNodeScale(target);
    const targetFlow = bakeStrokesToAbsFlow(
      targetData.strokes ?? [],
      targetAbs,
      scaleX,
      scaleY,
    );

    const all = [...targetFlow, ...extractedFlow];
    const bounds = flowStrokesBounds(all);
    if (!bounds) return [];
    const unionW = bounds.x2 - bounds.x1;
    const unionH = bounds.y2 - bounds.y1;
    const reframed = reframeFlowStrokes(all, bounds.x1, bounds.y1);

    const targetParentAbs = target.parentId
      ? (getAbsolutePosition(nn, target.parentId) ?? { x: 0, y: 0 })
      : { x: 0, y: 0 };

    return [
      ...sourceCommands,
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: targetNodeId,
            patch: {
              strokes: reframed,
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
            position: {
              x: bounds.x1 - targetParentAbs.x,
              y: bounds.y1 - targetParentAbs.y,
            },
            size: { width: unionW, height: unionH },
          },
        ],
      },
    ];
  }

  // ── 2b. Split the moved strokes out into a brand-new region ──
  const unionW = movedBounds.x2 - movedBounds.x1;
  const unionH = movedBounds.y2 - movedBounds.y1;
  const reframed = reframeFlowStrokes(
    extractedFlow,
    movedBounds.x1,
    movedBounds.y1,
  );
  const destParentAbs = destParentId
    ? (getAbsolutePosition(nn, destParentId) ?? { x: 0, y: 0 })
    : { x: 0, y: 0 };

  return [
    ...sourceCommands,
    {
      type: 'CREATE_NODES',
      nodes: [
        {
          id: newNodeId,
          nodeType: 'sketch',
          position: {
            x: movedBounds.x1 - destParentAbs.x,
            y: movedBounds.y1 - destParentAbs.y,
          },
          size: { width: unionW, height: unionH },
          ...(destParentId ? { parentId: destParentId } : {}),
          // A split-off region must not steal selection (it would interrupt
          // the pen and shadow nodes under its transparent bbox).
          selectOnCreate: false,
          data: {
            strokes: reframed,
            initialSize: { width: unionW, height: unionH },
            origin: { type: 'user-created' },
          },
        },
      ] as Extract<CanvasCommand, { type: 'CREATE_NODES' }>['nodes'],
    },
  ];
}

/**
 * Execute a batch of stroke-mutation commands (move / erase) as **one undo
 * entry**, applying the shared snapshot-folding policy in a single place so
 * every caller (stroke move, stroke delete, mixed gestures) stays
 * consistent.
 *
 * - `foldIntoOpenGesture: true` — the caller has ALREADY opened an undo
 *   gesture (e.g. a node-drag / node-delete that took its own snapshot) and
 *   wants this batch to fold into that SAME entry. We re-arm the gesture
 *   snapshot flag so `executeCommands` neither pushes a second snapshot nor
 *   warns about a `snapshot:'caller'` command lacking a `beginGesture`.
 * - `foldIntoOpenGesture: false` (default) — this batch owns its own
 *   single-entry gesture; we open one via `beginGesture('SET_NODE_GEOMETRY')`
 *   when the batch contains a caller-snapshot geometry command (a pure
 *   `DELETE_NODES`-only batch needs none — the command self-snapshots).
 *
 * No-op for an empty batch.
 */
export function commitStrokeCommands(
  commands: CanvasCommand[],
  { foldIntoOpenGesture = false }: { foldIntoOpenGesture?: boolean } = {},
): void {
  if (commands.length === 0) return;
  const store = useCanvasStore.getState();
  if (foldIntoOpenGesture) {
    canvasHistoryManager.markGestureSnapshot();
  } else if (commands.some((c) => c.type === 'SET_NODE_GEOMETRY')) {
    store.beginGesture('SET_NODE_GEOMETRY');
  }
  try {
    store.executeCommands(commands, 'ui');
  } finally {
    // A folded batch containing a caller-snapshot command is consumed by
    // executeCommands itself. DELETE_NODES-only and all-no-op batches are
    // not, so close the re-armed flag here as an idempotent safety net. If it
    // leaked, an unrelated later edit could incorrectly skip its own undo
    // snapshot.
    if (foldIntoOpenGesture) {
      canvasHistoryManager.consumeGestureSnapshot();
    }
  }
}
