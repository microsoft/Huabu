// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Edge-routing utilities for canvas commands.
 *
 * Provides smart handle selection and batch edge rerouting based on
 * the relative positions of source and target nodes.
 */

import { getLayoutNodeSize } from './nodeSizes.js';
import { EDGE_STROKE_WIDTHS, resolveAccent } from '../../index.js';
import { readFrameGridConfig } from '../autoLayout/gridLayout.js';

import type { EdgeStyle } from '../../index.js';
import type { Node, Edge } from '@xyflow/react';

/** Handle pair returned by smart-handle selection. */
export interface HandlePair {
  sourceHandle: string;
  targetHandle: string;
}

/**
 * An axis-aligned obstacle rectangle in absolute canvas space, used by
 * obstacle-aware handle selection. `id` (when present) lets the scorer
 * skip the edge's own endpoints without per-edge array allocation.
 */
export interface ObstacleRect {
  id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * **Structured** Frames whose direct children are joined by one of the
 * given edges.
 *
 * Reported by the edge commands so the executor can recompute gutters —
 * the lanes a structured Frame reserves for the edges running between
 * its children — in the same batch. `free` Frames are excluded because
 * they have no gutters to recompute: naming one here would only put it
 * through the end-of-batch fit pass, turning an edge restyle into a
 * frame resize that saves, broadcasts, and lands in the same undo step.
 */
export function getInternalEdgeFrameIds(
  nodes: readonly Node[],
  edges: readonly Edge[],
): string[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const frameIds = new Set<string>();
  for (const edge of edges) {
    const sourceParentId = nodeById.get(edge.source)?.parentId;
    if (!sourceParentId) continue;
    if (frameIds.has(sourceParentId)) continue;
    const targetParentId = nodeById.get(edge.target)?.parentId;
    if (sourceParentId !== targetParentId) continue;
    if (readFrameGridConfig(nodeById.get(sourceParentId))) {
      frameIds.add(sourceParentId);
    }
  }
  return [...frameIds];
}

/** Cardinal routing direction (source → target). */
type RouteDir = 'right' | 'left' | 'down' | 'up';

/** Handle pair for each routing direction. */
const DIR_HANDLES: Record<RouteDir, HandlePair> = {
  right: { sourceHandle: 'right-source', targetHandle: 'left-target' },
  left: { sourceHandle: 'left-source', targetHandle: 'right-target' },
  down: { sourceHandle: 'bottom-source', targetHandle: 'top-target' },
  up: { sourceHandle: 'top-source', targetHandle: 'bottom-target' },
};

/**
 * Handles for an edge whose endpoints share a **structured** Frame.
 *
 * There the solver owns every child position and guarantees they do not
 * overlap, so the shortest mutually-facing pair on the dominant axis is
 * always clean — and obstacle avoidance would only pick a detour that
 * leaves the Frame it belongs to.
 *
 * A `free` Frame carries no such guarantee: its children can sit
 * anywhere, including on top of each other, so those edges keep the
 * general obstacle-aware router.
 */
function getInternalFrameHandles(source: Node, target: Node): HandlePair {
  const sourceSize = getLayoutNodeSize(source);
  const targetSize = getLayoutNodeSize(target);
  const dx =
    target.position.x +
    targetSize.w / 2 -
    (source.position.x + sourceSize.w / 2);
  const dy =
    target.position.y +
    targetSize.h / 2 -
    (source.position.y + sourceSize.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? DIR_HANDLES.right : DIR_HANDLES.left;
  }
  return dy >= 0 ? DIR_HANDLES.down : DIR_HANDLES.up;
}

/**
 * L-shaped candidates: source exits one side, target enters from a
 * perpendicular side. These are useful when the two nodes are diagonal
 * to each other and the straight-line candidates graze obstacles or
 * produce an unnatural detour.
 *
 * Order: primary (toward target) side on source, secondary side on target.
 */
const L_CANDIDATES: HandlePair[] = [
  // Source exits right, target enters from top/bottom
  { sourceHandle: 'right-source', targetHandle: 'top-target' },
  { sourceHandle: 'right-source', targetHandle: 'bottom-target' },
  // Source exits left, target enters from top/bottom
  { sourceHandle: 'left-source', targetHandle: 'top-target' },
  { sourceHandle: 'left-source', targetHandle: 'bottom-target' },
  // Source exits bottom, target enters from left/right
  { sourceHandle: 'bottom-source', targetHandle: 'left-target' },
  { sourceHandle: 'bottom-source', targetHandle: 'right-target' },
  // Source exits top, target enters from left/right
  { sourceHandle: 'top-source', targetHandle: 'left-target' },
  { sourceHandle: 'top-source', targetHandle: 'right-target' },
];

/** Padding (px) added around each obstacle so edges don't graze corners. */
const OBSTACLE_MARGIN = 8;

/**
 * Map our domain `lineType` to React Flow edge type names.
 * Hoisted to module scope so `applyEdgeStyle` does not re-allocate
 * it on every edge update during canvas re-renders.
 */
const LINE_TYPE_TO_RF: Record<string, string> = {
  bezier: 'default',
  straight: 'straight',
  step: 'smoothstep',
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Midpoint anchor of the rect side that `handle` lives on. */
function handleAnchor(rect: Rect, handle: string): { x: number; y: number } {
  // Handle ids are `${side}-${role}` (e.g. 'right-source').
  const side = handle.slice(0, handle.indexOf('-'));
  switch (side) {
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    case 'left':
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case 'bottom':
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case 'top':
    default:
      return { x: rect.x + rect.w / 2, y: rect.y };
  }
}

/** Outward unit normal of the rect side that `handle` lives on. */
function handleNormal(handle: string): { x: number; y: number } {
  const side = handle.slice(0, handle.indexOf('-'));
  switch (side) {
    case 'right':
      return { x: 1, y: 0 };
    case 'left':
      return { x: -1, y: 0 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'top':
    default:
      return { x: 0, y: -1 };
  }
}

/** Whether the handle lives on a horizontal (left/right) side. */
function isHorizontalHandle(handle: string): boolean {
  const side = handle.slice(0, handle.indexOf('-'));
  return side === 'left' || side === 'right';
}

/**
 * Handle side prefix shared by `${side}-source` / `${side}-target` ids.
 * Distinct from `RouteDir` (which encodes movement direction); a
 * `HandleSide` is the spatial side a handle sits on.
 */
type HandleSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * Slack (px) granted around containment checks. A child positioned
 * flush against (or barely past) its parent's edge — e.g. during a
 * drag, or because of half-pixel rounding — should still register as
 * “inside” so the inside-case routing kicks in.
 */
const INSIDE_SLACK_PX = 4;

/** True when `inner` is fully contained by `outer` (with light slack). */
function isInsideRect(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - INSIDE_SLACK_PX &&
    inner.y >= outer.y - INSIDE_SLACK_PX &&
    inner.x + inner.w <= outer.x + outer.w + INSIDE_SLACK_PX &&
    inner.y + inner.h <= outer.y + outer.h + INSIDE_SLACK_PX
  );
}

/**
 * Which side of `outer` corresponds to the position of `inner` inside it.
 *
 * Uses a **proportional** (normalised) offset rather than absolute edge
 * distance: dividing the container into 4 triangular quadrants split by
 * its two diagonals. The inner node's center falls into exactly one
 * quadrant — top / right / bottom / left — and that picks the side.
 *
 * Why not "nearest absolute edge"? Frames are typically much wider than
 * tall, so `height/2` is almost always smaller than `width/2`; an
 * absolute-distance scorer would then pick top or bottom for *any*
 * child that isn't hugging a vertical side, and left/right would
 * essentially never fire. The proportional comparison fixes that: a
 * child in the left half of a wide frame proportionally favours the
 * left side, even though the top edge is fewer pixels away.
 *
 * Ties (child exactly on a diagonal, or precisely centred) break to the
 * vertical axis first (top / bottom), matching the `Math.abs(x) > y`
 * branch order — picked arbitrarily, no visual difference at the tie
 * point.
 */
function closestContainerSide(inner: Rect, outer: Rect): HandleSide {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  const fcx = outer.x + outer.w / 2;
  const fcy = outer.y + outer.h / 2;
  // Half-extents; guard against zero-sized containers so the division
  // can't produce NaN / Infinity (caller would have bailed already, but
  // defensively keep the function pure-numeric).
  const halfW = outer.w / 2 || 1;
  const halfH = outer.h / 2 || 1;
  const offsetX = (cx - fcx) / halfW;
  const offsetY = (cy - fcy) / halfH;
  if (Math.abs(offsetX) > Math.abs(offsetY)) {
    return offsetX > 0 ? 'right' : 'left';
  }
  return offsetY > 0 ? 'bottom' : 'top';
}

/** Build the same-side `HandlePair` (e.g. `top-source` ↔ `top-target`). */
function sameSidePair(side: HandleSide): HandlePair {
  return {
    sourceHandle: `${side}-source`,
    targetHandle: `${side}-target`,
  };
}

type Pt = { x: number; y: number };

/**
 * Maximum length (px) of the straight stub an edge travels along a handle's
 * outward normal before curving toward the other end. Mirrors how a bezier /
 * smooth-step edge leaves a handle, and is what the obstacle test uses to
 * approximate the rendered curve. For short edges the stub is clamped to half
 * the chord so it never overshoots the far endpoint.
 */
const ROUTE_STUB_PX = 40;

/**
 * Approximate the *rendered* edge path (bezier / smooth-step) between two
 * handles as a 4-point polyline: a short stub out of each handle along its
 * outward normal, joined by a straight middle segment. Edges leave a handle
 * along its normal, so this hugs the real curve far better than the straight
 * diagonal chord between the two anchors — which would cut the corner and
 * report false crossings for routes that visually clear an obstacle.
 */
function buildRoutePath(
  a: Pt,
  b: Pt,
  sourceHandle: string,
  targetHandle: string,
): Pt[] {
  const sn = handleNormal(sourceHandle);
  const tn = handleNormal(targetHandle);
  // Clamp the stub for short edges so it can't overshoot the far endpoint and
  // fold the middle segment back on itself (which would mis-test obstacles).
  const stub = Math.min(ROUTE_STUB_PX, dist(a, b) / 2);
  const p1 = { x: a.x + sn.x * stub, y: a.y + sn.y * stub };
  const p2 = { x: b.x + tn.x * stub, y: b.y + tn.y * stub };
  return [a, p1, p2, b];
}

/** True when any segment of the polyline crosses the rectangle. */
function polylineHitsRect(points: Pt[], rect: Rect, margin: number): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    if (segIntersectsRect(p.x, p.y, q.x, q.y, rect, margin)) return true;
  }
  return false;
}

/**
 * Liang–Barsky segment vs. axis-aligned rectangle test.
 *
 * Returns `true` when the segment from (x0,y0)→(x1,y1) crosses the
 * interior of `rect` (inflated by `margin`). O(1), no allocation.
 */
function segIntersectsRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rect: Rect,
  margin: number,
): boolean {
  const minX = rect.x - margin;
  const minY = rect.y - margin;
  const maxX = rect.x + rect.w + margin;
  const maxY = rect.y + rect.h + margin;

  const dx = x1 - x0;
  const dy = y1 - y0;

  let t0 = 0;
  let t1 = 1;

  // For each of the 4 slabs, clip the [t0,t1] parameter range.
  const edges: Array<[number, number]> = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      // Segment parallel to this slab: outside if origin is outside.
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  // Strict inequality so a mere boundary graze doesn't count as a hit.
  return t0 < t1;
}

/** Euclidean distance helper. */
function dist(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** All candidate handle pairs (4 direct + 8 L-shaped). */
const CANDIDATES: HandlePair[] = [
  ...Object.values(DIR_HANDLES),
  ...L_CANDIDATES,
];

/**
 * Returns the best source/target handle pair for an edge between two nodes
 * based on their relative positions on the canvas.
 *
 * Two regimes:
 *
 * **Outside (the two rects are side-by-side, possibly diagonal):** scores
 * 12 candidate pairs (4 direct + 8 L-shaped) on length, obstacle hits,
 * axis miss, and facing. Picks the handles that produce the most direct,
 * least-crossing path:
 * - Target primarily to the right → right-source / left-target
 * - Target primarily to the left  → left-source  / right-target
 * - Target primarily below        → bottom-source / top-target
 * - Target primarily above        → top-source   / bottom-target
 *
 * **Inside (one rect fully contains the other — typically a frame and a
 * descendant):** the generic scoring would route a chord through the
 * container interior, which looks broken. Instead we short-circuit:
 * divide the container into 4 triangular wedges along its diagonals,
 * see which wedge the inner node's centre lands in (top / right /
 * bottom / left), and use the *same* side on both handles
 * (`left-source` ↔ `left-target`, etc.) so the rendered curve exits
 * the container on that side, arcs around the outside, and re-enters
 * the inner node on the matching side — a clean external loop. The
 * wedge test is a proportional comparison (`|offsetX| > |offsetY|`),
 * not nearest absolute edge, so wide frames still produce left/right
 * connections when the child sits in the left/right half. Detected by
 * geometry so a child dragged past the frame edge falls back to the
 * outside regime.
 *
 * When `obstacles` are supplied, each candidate is scored by:
 *   score = pathLength
 *         + obstacleHits * OBSTACLE_PENALTY_PX
 *         + axisMisses   * AXIS_WEIGHT_PX
 *         + facingPenalty * FACING_WEIGHT_PX
 * Obstacle hits are tested against a normal-aligned stub polyline that
 * approximates the rendered (bezier / smooth-step) curve, not the straight
 * chord between the two anchors — an edge leaves each handle along its
 * outward normal, so the chord would cut the corner and falsely report
 * crossings for routes that visually clear the obstacle. The candidate with
 * the lowest score wins.
 * Crossing an obstacle costs a
 * fixed virtual length, so the router only detours when the extra path is
 * shorter than the penalty — this avoids absurd long loops just to avoid a
 * single node. When the two nodes are clearly separated on one axis (and
 * overlap on the other), each handle that sits on the wrong axis is
 * penalised: a node stacked directly above/below another should connect
 * bottom↔top, not via a side that merely happens to be a few pixels
 * closer. The facing term is a final tie-breaker that rewards handles whose
 * outward normal points toward the other node. Both extra weights are kept
 * strictly below OBSTACLE_PENALTY_PX so neither can push an edge through an
 * obstacle.
 */
export function getSmartHandles(
  sourceNode: Node,
  targetNode: Node,
  obstacles?: readonly ObstacleRect[],
): HandlePair {
  const { w: sw, h: sh } = getLayoutNodeSize(sourceNode);
  const { w: tw, h: th } = getLayoutNodeSize(targetNode);

  const sx = sourceNode.position.x;
  const sy = sourceNode.position.y;
  const tx = targetNode.position.x;
  const ty = targetNode.position.y;

  // Center-to-center deltas
  const dx = tx + tw / 2 - (sx + sw / 2);
  const dy = ty + th / 2 - (sy + sh / 2);

  // Edge-to-edge gap: positive means no overlap on that axis.
  const hGap = Math.max(tx - (sx + sw), sx - (tx + tw));
  const vGap = Math.max(ty - (sy + sh), sy - (ty + th));

  // When nodes are clearly separated on one axis but overlap on the other,
  // route along the separated axis — this prevents tall side-by-side nodes
  // from being connected vertically just because of a y-offset.
  const clearlyHorizontal = hGap > 0 && vGap <= 0;
  const clearlyVertical = hGap <= 0 && vGap > 0;

  const srcRect: Rect = { x: sx, y: sy, w: sw, h: sh };
  const tgtRect: Rect = { x: tx, y: ty, w: tw, h: th };

  // ─── Inside-container case (frame ↔ contained node) ─────────────────────────────
  //
  // The generic candidate scoring below assumes the two rects sit
  // side-by-side and picks the handle pair that produces the shortest
  // unobstructed line between them. That fails when one rect (typically
  // a frame) fully contains the other: every “direct” candidate has the
  // two handles pointing at each other across an interior gap, so the
  // resulting edge cuts diagonally through the container, which looks
  // broken.
  //
  // Visual fix: split the container into 4 triangular wedges along its
  // diagonals, see which wedge the inner node's centre lands in, and
  // use the *same* side on both endpoints (`left-source` ↔
  // `left-target`, etc.). React Flow leaves each handle along its
  // outward normal, so the rendered curve exits the container on that
  // side, arcs around the outside, and re-enters the inner node on the
  // matching side — a clean external loop instead of an interior chord.
  // The wedge test is proportional (`|offsetX| > |offsetY|`) rather
  // than nearest absolute edge, otherwise wide frames would always pick
  // top / bottom (height is the smaller dimension) and left / right
  // would essentially never fire.
  //
  // We detect containment by geometry (not `parentId`) so the rule
  // tracks what the user actually sees: a child positioned past the
  // frame edge during a drag falls back to the regular outside
  // routing, which is what you'd want visually anyway.
  if (isInsideRect(tgtRect, srcRect)) {
    return sameSidePair(closestContainerSide(tgtRect, srcRect));
  }
  if (isInsideRect(srcRect, tgtRect)) {
    return sameSidePair(closestContainerSide(srcRect, tgtRect));
  }

  const candidates = CANDIDATES;
  const skipSource = sourceNode.id;
  const skipTarget = targetNode.id;

  // Early prune: every candidate path lives inside the union of the
  // two endpoint rects inflated by `ROUTE_STUB_PX` (L-shaped stubs)
  // plus `OBSTACLE_MARGIN` (hit-test slop). Obstacles outside this
  // search bbox can never be crossed by any candidate, so we filter
  // the list once instead of testing all N obstacles per candidate.
  // On large canvases this turns the per-edge cost from O(12 · N)
  // into O(12 · k) where k is the local obstacle density.
  let obstacleList = obstacles ?? [];
  if (obstacleList.length > 0) {
    const slack = ROUTE_STUB_PX + OBSTACLE_MARGIN;
    const minX = Math.min(sx, tx) - slack;
    const minY = Math.min(sy, ty) - slack;
    const maxX = Math.max(sx + sw, tx + tw) + slack;
    const maxY = Math.max(sy + sh, ty + th) + slack;
    obstacleList = obstacleList.filter((o) => {
      if (o.id === skipSource || o.id === skipTarget) return false;
      return (
        o.x <= maxX && o.x + o.w >= minX && o.y <= maxY && o.y + o.h >= minY
      );
    });
  }

  // Virtual length (px) charged for each obstacle a connector crosses.
  // The router will only detour around an obstacle when doing so adds less
  // than this much extra path length — keeps detours proportionate.
  const OBSTACLE_PENALTY_PX = 600;

  // Penalty (px) per handle that sits on the “wrong” axis when the two nodes
  // are clearly separated on one axis. Two of these (max 2 * weight) stay
  // below OBSTACLE_PENALTY_PX so a side detour is still allowed when the
  // axis-aligned route is blocked.
  const AXIS_WEIGHT_PX = 200;

  // Per-unit facing penalty. Kept well below OBSTACLE_PENALTY_PX (max total
  // facing penalty is 4 * weight) so a facing preference can never outweigh
  // an obstacle crossing.
  const FACING_WEIGHT_PX = 120;

  // When the nodes are clearly stacked on one axis, handles on the other
  // axis are “wrong”: a node directly below another should connect via
  // bottom↔top, not via a side that is incidentally a few pixels closer.
  const penalizeHorizontalHandles = clearlyVertical;
  const penalizeVerticalHandles = clearlyHorizontal;

  // Center-to-center unit direction (source → target) for facing scores.
  const dirLen = Math.hypot(dx, dy) || 1;
  const ux = dx / dirLen;
  const uy = dy / dirLen;

  let bestPair = candidates[0];
  let bestScore = Infinity;
  for (const pair of candidates) {
    const a = handleAnchor(srcRect, pair.sourceHandle);
    const b = handleAnchor(tgtRect, pair.targetHandle);
    const path = buildRoutePath(a, b, pair.sourceHandle, pair.targetHandle);

    let hits = 0;
    for (const o of obstacleList) {
      if (polylineHitsRect(path, o, OBSTACLE_MARGIN)) hits++;
    }

    // Count handles that sit on the wrong axis for a clearly-stacked layout.
    let axisMisses = 0;
    if (penalizeHorizontalHandles) {
      if (isHorizontalHandle(pair.sourceHandle)) axisMisses++;
      if (isHorizontalHandle(pair.targetHandle)) axisMisses++;
    } else if (penalizeVerticalHandles) {
      if (!isHorizontalHandle(pair.sourceHandle)) axisMisses++;
      if (!isHorizontalHandle(pair.targetHandle)) axisMisses++;
    }

    // Reward handles whose outward normal faces the other node: the source
    // handle should point toward the target, the target handle toward the
    // source. Each term is in [0, 2]; the sum is in [0, 4].
    const sn = handleNormal(pair.sourceHandle);
    const tn = handleNormal(pair.targetHandle);
    const facing =
      1 - (sn.x * ux + sn.y * uy) + (1 - (tn.x * -ux + tn.y * -uy));

    const score =
      dist(a, b) +
      hits * OBSTACLE_PENALTY_PX +
      axisMisses * AXIS_WEIGHT_PX +
      facing * FACING_WEIGHT_PX;

    if (score < bestScore) {
      bestScore = score;
      bestPair = pair;
    }
  }
  return bestPair;
}

/**
 * Recalculate sourceHandle / targetHandle for every edge based on the
 * current relative positions of their source and target nodes.
 *
 * Returns the original `edges` reference when nothing changed, so React /
 * zustand can skip re-renders via reference equality.
 */
export function rerouteAllEdges<
  E extends {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
>(nodes: Node[], edges: E[]): E[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Resolve absolute positions so framed nodes are compared correctly
  // against nodes outside the frame (or in a different frame).
  const absPos = new Map<string, { x: number; y: number }>();
  const resolve = (nodeId: string): { x: number; y: number } | null => {
    const cached = absPos.get(nodeId);
    if (cached) return cached;
    const n = nodeMap.get(nodeId);
    if (!n) return null;
    if (!n.parentId) {
      absPos.set(nodeId, n.position);
      return n.position;
    }
    const parentAbs = resolve(n.parentId);
    if (!parentAbs) {
      absPos.set(nodeId, n.position);
      return n.position;
    }
    const abs = {
      x: parentAbs.x + n.position.x,
      y: parentAbs.y + n.position.y,
    };
    absPos.set(nodeId, abs);
    return abs;
  };

  // Build the obstacle list once (absolute rects of every non-frame node).
  // Frames are containers — edges legitimately cross their backgrounds — so
  // they are excluded. The per-edge endpoint exclusion happens inside
  // `getSmartHandles` via the obstacle `id`.
  const obstacles: ObstacleRect[] = [];
  for (const n of nodes) {
    if (n.type === 'frame') continue;
    const abs = resolve(n.id);
    if (!abs) continue;
    const { w, h } = getLayoutNodeSize(n);
    obstacles.push({ id: n.id, x: abs.x, y: abs.y, w, h });
  }

  let changed = false;
  const result = edges.map((edge) => {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) return edge;

    const sourceAbs = resolve(edge.source);
    const targetAbs = resolve(edge.target);
    if (!sourceAbs || !targetAbs) return edge;

    // Create position-adjusted node refs for handle calculation.
    const srcNode =
      sourceAbs === source.position
        ? source
        : { ...source, position: sourceAbs };
    const tgtNode =
      targetAbs === target.position
        ? target
        : { ...target, position: targetAbs };

    const sharedFrameId =
      source.parentId && source.parentId === target.parentId
        ? source.parentId
        : null;
    // Only a structured Frame guarantees non-overlapping children; a
    // `free` one does not, so its internal edges still need to route
    // around whatever sits between the endpoints.
    const sharedFrame = sharedFrameId ? nodeMap.get(sharedFrameId) : undefined;
    const handles =
      sharedFrame?.type === 'frame' && readFrameGridConfig(sharedFrame)
        ? getInternalFrameHandles(srcNode, tgtNode)
        : getSmartHandles(srcNode, tgtNode, obstacles);
    if (
      edge.sourceHandle === handles.sourceHandle &&
      edge.targetHandle === handles.targetHandle
    ) {
      return edge;
    }
    changed = true;
    return { ...edge, ...handles };
  });
  return changed ? result : edges;
}

/**
 * Convert an EdgeStyle to React Flow edge properties.
 *
 * Stores the EdgeStyle as source of truth in `edge.data.edgeStyle` and
 * derives the React Flow rendering props (`type`, `style`, markers).
 */
/** Default stroke width applied to every new edge. */
export const DEFAULT_EDGE_STROKE_WIDTH = EDGE_STROKE_WIDTHS[1];
/** Neutral palette token used when an edge has no explicit stroke. */
export const DEFAULT_EDGE_STROKE_TOKEN = 'grey' as const;

export function applyEdgeStyle(edge: Edge, style?: EdgeStyle): Edge {
  // Always ensure baseline stroke and width even when no style is provided.
  if (!style) {
    return {
      ...edge,
      style: {
        ...edge.style,
        stroke: resolveAccent(DEFAULT_EDGE_STROKE_TOKEN) ?? undefined,
        strokeWidth: DEFAULT_EDGE_STROKE_WIDTH,
      },
    };
  }

  const rfStyle: Record<string, unknown> = {
    ...(typeof edge.style === 'object' ? edge.style : {}),
  };

  // Stored as palette token (or legacy hex); resolve to CSS color for SVG.
  const resolvedStroke = resolveAccent(
    style.stroke ?? DEFAULT_EDGE_STROKE_TOKEN,
  );
  if (resolvedStroke) rfStyle.stroke = resolvedStroke;
  const w = style.strokeWidth ?? DEFAULT_EDGE_STROKE_WIDTH;
  rfStyle.strokeWidth = w;
  if (style.lineStyle === 'dashed') {
    rfStyle.strokeDasharray = `${w * 3} ${w * 1.5}`;
  } else if (style.lineStyle === 'dotted') {
    rfStyle.strokeDasharray = `${w * 0.1} ${w * 1.5}`;
    rfStyle.strokeLinecap = 'round';
  }

  // Map our domain lineType to React Flow edge type names via the
  // module-level LINE_TYPE_TO_RF table. Unknown values (e.g. from an
  // LLM) fall back to 'default' (React Flow's bezier) to avoid
  // "edge type not found" warnings.
  const rfType = style.lineType
    ? (LINE_TYPE_TO_RF[style.lineType] ?? 'default')
    : undefined;

  // Build arrow markers based on direction. Use React Flow's defaults
  // (`markerUnits: 'strokeWidth'` and the built-in 12.5 × 12.5 box) so
  // the arrowhead stays visually balanced against the line stroke
  // across all canvases.
  const direction = style.direction ?? 'none';
  const markerColor = resolvedStroke ? { color: resolvedStroke } : {};
  const arrowMarker = {
    type: 'arrowclosed' as const,
    ...markerColor,
  };

  // The `label` field is rendered by the custom `LabelledEdge` web
  // component (it reads `data.edgeStyle.label`), not by React Flow's
  // built-in SVG label — setting `edge.label` here would render twice.

  return {
    ...edge,
    type: rfType ?? edge.type,
    style: rfStyle,
    markerEnd:
      direction === 'forward' || direction === 'both' ? arrowMarker : undefined,
    markerStart:
      direction === 'backward' || direction === 'both'
        ? arrowMarker
        : undefined,
    data: { ...edge.data, edgeStyle: style },
  };
}

/**
 * Merge a partial EdgeStyle patch into an existing EdgeStyle
 * stored on an edge's data, then re-apply to RF props.
 */
export function mergeEdgeStyle(edge: Edge, patch: Partial<EdgeStyle>): Edge {
  const existing: EdgeStyle =
    (edge.data?.edgeStyle as EdgeStyle | undefined) ?? {};
  const merged: EdgeStyle = { ...existing, ...patch };
  return applyEdgeStyle(
    {
      ...edge,
      // Clear previously set RF style so applyEdgeStyle starts fresh
      style: {},
      type: undefined,
    },
    merged,
  );
}
