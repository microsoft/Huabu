// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Smart-snap engine — pure functions invoked from `canvasStore`'s
 * drag pipeline. Owns no state; the caller (canvasStore) is
 * responsible for caching the `SnapIndex` between drag start and stop.
 *
 * Pipeline:
 *   onNodeDragStart →  buildCandidateIndex(nodes, draggedIds, parentId)
 *   onNodesChange  →  computeSnap(sourceRect, index, options) on each
 *                      frame, then add `(deltaX, deltaY)` to every
 *                      dragged node's position change before
 *                      `applyNodeChanges` commits it.
 *   onNodeDragStop →   discard the index.
 *
 * Snap precedence (highest first):
 *   1. Edge-to-edge alignment (9 combinations per axis: src min/mid/max
 *      vs candidate min/mid/max)
 *   2. Equal-spacing alignment (dragged rect bridges two siblings at
 *      identical gaps along an axis)
 *
 * Each axis is evaluated independently — you can snap X to an edge
 * while Y snaps to an equal-spacing target, matching common design-tool behaviour.
 *
 * Coordinate space: every position and rect is **absolute flow-space**.
 * The caller converts to/from React Flow's local coordinates (which are
 * parent-relative when a node is inside a frame).
 */

import {
  getNodeSize,
  createAbsolutePositionGetter,
  getDescendantIds,
  indexById,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import type {
  CandidateLine,
  Guide,
  Rect,
  SnapIndex,
  SnapOptions,
  SnapResult,
} from './types';

/**
 * Build the candidate alignment index from the current node graph.
 *
 * Excludes the dragged nodes themselves and any descendants of dragged
 * frames (those move with the frame as one unit). When `parentId` is
 * provided, only siblings inside the same frame are considered — this
 * keeps cross-frame ghost alignment out of the picture and matches
 * what users expect when re-arranging inside a container.
 *
 * @param nodes Full node graph.
 * @param draggedIds Ids of nodes currently being dragged.
 * @param parentId Common parent of the dragged set, or undefined when
 *                 dragging top-level nodes. Used to filter candidates
 *                 to siblings.
 */
export function buildCandidateIndex(
  nodes: NestableNode[],
  draggedIds: Set<string>,
  parentId: string | undefined,
): SnapIndex {
  // Expand the exclusion set to include descendants of any dragged frame
  // — they travel with the frame and would otherwise show stale lines.
  const excluded = new Set(draggedIds);
  for (const id of draggedIds) {
    for (const did of getDescendantIds(nodes, id)) excluded.add(did);
  }

  // Build the parent-chain getter ONCE. Calling
  // `getAbsolutePosition(nodes, n.id)` inside the loop would rebuild
  // the id→node map per iteration → O(N²) on the dragged graph.
  const byId = indexById(nodes);
  const getAbs = createAbsolutePositionGetter(byId);

  const byX: CandidateLine[] = [];
  const byY: CandidateLine[] = [];
  const rectsById = new Map<string, Rect>();

  for (const n of nodes) {
    if (excluded.has(n.id)) continue;
    if ((n.parentId ?? undefined) !== parentId) continue;

    const abs = getAbs(n.id);
    if (!abs) continue;
    const { width, height } = getNodeSize(n);
    if (width <= 0 || height <= 0) continue;

    const rect: Rect = { x: abs.x, y: abs.y, w: width, h: height };
    rectsById.set(n.id, rect);

    const minX = rect.x;
    const midX = rect.x + rect.w / 2;
    const maxX = rect.x + rect.w;
    const minY = rect.y;
    const midY = rect.y + rect.h / 2;
    const maxY = rect.y + rect.h;

    // X-axis (vertical) lines — `from`/`to` describe vertical extent.
    byX.push({
      axis: 'x',
      value: minX,
      edge: 'min',
      nodeId: n.id,
      from: minY,
      to: maxY,
    });
    byX.push({
      axis: 'x',
      value: midX,
      edge: 'mid',
      nodeId: n.id,
      from: minY,
      to: maxY,
    });
    byX.push({
      axis: 'x',
      value: maxX,
      edge: 'max',
      nodeId: n.id,
      from: minY,
      to: maxY,
    });

    // Y-axis (horizontal) lines — `from`/`to` describe horizontal extent.
    byY.push({
      axis: 'y',
      value: minY,
      edge: 'min',
      nodeId: n.id,
      from: minX,
      to: maxX,
    });
    byY.push({
      axis: 'y',
      value: midY,
      edge: 'mid',
      nodeId: n.id,
      from: minX,
      to: maxX,
    });
    byY.push({
      axis: 'y',
      value: maxY,
      edge: 'max',
      nodeId: n.id,
      from: minX,
      to: maxX,
    });
  }

  byX.sort((a, b) => a.value - b.value);
  byY.sort((a, b) => a.value - b.value);

  return { byX, byY, rectsById };
}

/**
 * Binary-search the first index whose `value >= target - tolerance`,
 * then linearly scan forward while `value <= target + tolerance` and
 * keep the closest hit. O(log n + k) where k is candidates within the
 * window (typically 0–3).
 */
function findBestAt(
  lines: CandidateLine[],
  target: number,
  tolerance: number,
): { line: CandidateLine; distance: number } | null {
  if (lines.length === 0) return null;

  // Binary search for the first index with value >= target - tolerance.
  let lo = 0;
  let hi = lines.length;
  const lower = target - tolerance;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].value < lower) lo = mid + 1;
    else hi = mid;
  }

  const upper = target + tolerance;
  let best: { line: CandidateLine; distance: number } | null = null;
  for (let i = lo; i < lines.length; i++) {
    const line = lines[i];
    if (line.value > upper) break;
    const distance = Math.abs(line.value - target);
    if (!best || distance < best.distance) {
      best = { line, distance };
    }
  }
  return best;
}

type AxisHit = {
  delta: number;
  /** Coordinate of the snapped line in absolute flow-space. */
  snappedValue: number;
  /** Source edge that produced the best hit (for guide segment math). */
  sourceEdge: 'min' | 'mid' | 'max';
  candidate: CandidateLine;
};

/**
 * Evaluate one axis's source candidates against the candidate index
 * and return the best hit, or null when nothing is within
 * `tolerance`.
 *
 * `active` controls which source edges contribute probes:
 *   - `'both'`  → `min`, `mid`, `max` (drag default)
 *   - `'min'`   → only the `min` edge probes (e.g. left/top resize)
 *   - `'max'`   → only the `max` edge probes (e.g. right/bottom resize)
 *   - `'none'`  → axis disabled, returns null immediately
 */
function bestAxisHit(
  lines: CandidateLine[],
  sourceMin: number,
  sourceMid: number,
  sourceMax: number,
  tolerance: number,
  active: 'min' | 'max' | 'both' | 'none',
): AxisHit | null {
  if (active === 'none') return null;
  const probes: { value: number; edge: 'min' | 'mid' | 'max' }[] = [];
  if (active === 'min' || active === 'both') {
    probes.push({ value: sourceMin, edge: 'min' });
  }
  if (active === 'both') {
    // `mid` only participates when the whole rect is moving — for a
    // single-edge resize the centre would slide too and snapping to
    // it forces the anchor edge to move with it, which is wrong.
    probes.push({ value: sourceMid, edge: 'mid' });
  }
  if (active === 'max' || active === 'both') {
    probes.push({ value: sourceMax, edge: 'max' });
  }

  let best: AxisHit | null = null;
  for (const probe of probes) {
    const hit = findBestAt(lines, probe.value, tolerance);
    if (!hit) continue;
    const delta = hit.line.value - probe.value;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) {
      best = {
        delta,
        snappedValue: hit.line.value,
        sourceEdge: probe.edge,
        candidate: hit.line,
      };
    }
  }
  return best;
}

/**
 * Build a guide segment that spans both the candidate rect and the
 * (post-snap) source rect on the parallel axis. Mirrors the common
 * "draw line through both rects" alignment-guide behaviour.
 */
function buildGuide(
  axis: 'x' | 'y',
  snappedValue: number,
  candidate: CandidateLine,
  sourceRect: Rect,
): Guide {
  const sourceMin = axis === 'x' ? sourceRect.y : sourceRect.x;
  const sourceMax =
    axis === 'x' ? sourceRect.y + sourceRect.h : sourceRect.x + sourceRect.w;
  return {
    kind: 'alignment',
    axis,
    value: snappedValue,
    from: Math.min(candidate.from, sourceMin),
    to: Math.max(candidate.to, sourceMax),
  };
}

/**
 * Equal-spacing pass — for the given axis, look for a pair of
 * sibling rects (A, B) with A entirely on one side of the source and
 * B entirely on the other, such that placing the source between them
 * yields identical gaps. When such a placement exists within
 * `tolerance` of the current source position, return the snap target
 * and the rects involved.
 *
 * Algorithm:
 *   1. Filter candidate rects to those that *do not* overlap the
 *      source on the perpendicular axis (so equal-spacing is between
 *      visually-aligned rows / columns only — same rule as common design tools).
 *   2. Split by side: leftOf (rect.max <= source.min) / rightOf
 *      (rect.min >= source.max).
 *   3. For each (L, R) pair, compute the source position that yields
 *      L.gap == R.gap and check against tolerance.
 *   4. Return the smallest-delta match.
 */
function bestEqualSpacingHit(
  axis: 'x' | 'y',
  rects: Iterable<Rect>,
  sourceRect: Rect,
  tolerance: number,
): { delta: number; snappedValue: number; rects: [Rect, Rect] } | null {
  const srcMin = axis === 'x' ? sourceRect.x : sourceRect.y;
  const srcMax =
    axis === 'x' ? sourceRect.x + sourceRect.w : sourceRect.y + sourceRect.h;
  const srcSize = srcMax - srcMin;
  const srcPerpMin = axis === 'x' ? sourceRect.y : sourceRect.x;
  const srcPerpMax =
    axis === 'x' ? sourceRect.y + sourceRect.h : sourceRect.x + sourceRect.w;

  const leftOf: Rect[] = [];
  const rightOf: Rect[] = [];

  for (const r of rects) {
    const rMin = axis === 'x' ? r.x : r.y;
    const rMax = axis === 'x' ? r.x + r.w : r.y + r.h;
    const rPerpMin = axis === 'x' ? r.y : r.x;
    const rPerpMax = axis === 'x' ? r.y + r.h : r.x + r.w;

    // Skip rects that are vertically/horizontally disjoint on the
    // perpendicular axis (design tools only show equal-spacing for rects in
    // the same "row" or "column"). A 1px overlap is enough — strict
    // disjoint cuts noise without losing useful matches.
    if (rPerpMax <= srcPerpMin || rPerpMin >= srcPerpMax) continue;

    if (rMax <= srcMin) leftOf.push(r);
    else if (rMin >= srcMax) rightOf.push(r);
  }

  if (leftOf.length === 0 || rightOf.length === 0) return null;

  let best: {
    delta: number;
    snappedValue: number;
    rects: [Rect, Rect];
  } | null = null;

  for (const L of leftOf) {
    const lMax = axis === 'x' ? L.x + L.w : L.y + L.h;
    for (const R of rightOf) {
      const rMin = axis === 'x' ? R.x : R.y;
      // Required gap on each side that produces an equal-spacing layout:
      //   total free space = rMin - lMax - srcSize
      //   gap = free / 2
      // The snapped srcMin is then lMax + gap.
      const free = rMin - lMax - srcSize;
      if (free < 0) continue; // No room — sibs already touch the source.
      const gap = free / 2;
      const snappedSrcMin = lMax + gap;
      const delta = snappedSrcMin - srcMin;
      if (Math.abs(delta) > tolerance) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, snappedValue: snappedSrcMin, rects: [L, R] };
      }
    }
  }
  return best;
}

/**
 * Trailing-spacing pass — extend an existing rhythm.
 *
 * Where `bestEqualSpacingHit` requires the source to sit *between*
 * two siblings (a 3-rect symmetry), this pass detects the case where
 * two siblings on one side of the source already define a rhythm
 * (their gap `d`), and snaps the source so that the gap from the
 * nearest sibling to the source is also `d` — i.e. the source
 * "continues the row". Matches the common design-tool behaviour where dragging a
 * fourth shape to the right of three evenly-spaced ones pulls it
 * into the same cadence.
 *
 * Algorithm:
 *   1. Same perpendicular-overlap filter as middle-equal (only
 *      siblings in the same row / column count).
 *   2. For each side (left / right of source) with ≥ 2 siblings,
 *      pick the two nearest along the axis. Let N be the nearest
 *      and N' the next-nearest (further from source).
 *   3. Reference rhythm `d = |N.edgeTowardSource - N'.edgeTowardSource|`.
 *   4. Compute the source position that would produce gap(N, src) = d
 *      and check against `tolerance`.
 *   5. Return the smallest-delta match across both sides.
 *
 * Both sides are evaluated even if one already produced a hit, so
 * "extending the row from the right" and "extending the row from
 * the left" compete on absolute delta rather than first-found wins.
 */
function bestTrailingSpacingHit(
  axis: 'x' | 'y',
  rects: Iterable<Rect>,
  sourceRect: Rect,
  tolerance: number,
): { delta: number; snappedValue: number; rects: [Rect, Rect] } | null {
  const srcMin = axis === 'x' ? sourceRect.x : sourceRect.y;
  const srcMax =
    axis === 'x' ? sourceRect.x + sourceRect.w : sourceRect.y + sourceRect.h;
  const srcSize = srcMax - srcMin;
  const srcPerpMin = axis === 'x' ? sourceRect.y : sourceRect.x;
  const srcPerpMax =
    axis === 'x' ? sourceRect.y + sourceRect.h : sourceRect.x + sourceRect.w;

  const leftOf: Rect[] = [];
  const rightOf: Rect[] = [];

  for (const r of rects) {
    const rMin = axis === 'x' ? r.x : r.y;
    const rMax = axis === 'x' ? r.x + r.w : r.y + r.h;
    const rPerpMin = axis === 'x' ? r.y : r.x;
    const rPerpMax = axis === 'x' ? r.y + r.h : r.x + r.w;

    if (rPerpMax <= srcPerpMin || rPerpMin >= srcPerpMax) continue;

    if (rMax <= srcMin) leftOf.push(r);
    else if (rMin >= srcMax) rightOf.push(r);
  }

  let best: {
    delta: number;
    snappedValue: number;
    rects: [Rect, Rect];
  } | null = null;

  const minOf = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const maxOf = (r: Rect) => (axis === 'x' ? r.x + r.w : r.y + r.h);
  const perpMinOf = (r: Rect) => (axis === 'x' ? r.y : r.x);
  const perpMaxOf = (r: Rect) => (axis === 'x' ? r.y + r.h : r.x + r.w);

  // Both `near` and `far` already passed the perp-overlap test against
  // the source, but that doesn't guarantee they overlap *each other*.
  // A tall/thin source can be flanked by two small siblings that sit
  // at its top and bottom — visually they don't form a row, so we
  // must not infer a trailing rhythm from them. Common design tools apply
  // the same triple-overlap rule.
  const perpOverlap = (a: Rect, b: Rect) =>
    !(perpMaxOf(a) <= perpMinOf(b) || perpMinOf(a) >= perpMaxOf(b));

  // --- Left side: N is the nearest (rightmost), N' is the next out.
  // Reference gap is between N' (further) and N (nearer). Target:
  // gap(N, source) = referenceGap, so srcMin = N.max + referenceGap.
  if (leftOf.length >= 2) {
    // Sort by max descending so leftOf[0] is the rightmost (closest).
    leftOf.sort((a, b) => maxOf(b) - maxOf(a));
    const near = leftOf[0];
    const far = leftOf[1];
    if (perpOverlap(near, far)) {
      const refGap = minOf(near) - maxOf(far);
      if (refGap >= 0) {
        const snappedSrcMin = maxOf(near) + refGap;
        const delta = snappedSrcMin - srcMin;
        if (Math.abs(delta) <= tolerance) {
          best = { delta, snappedValue: snappedSrcMin, rects: [far, near] };
        }
      }
    }
  }

  // --- Right side: N is the nearest (leftmost), N' is the next out.
  // Reference gap is between N (nearer) and N' (further). Target:
  // gap(source, N) = referenceGap, so srcMax = N.min - referenceGap.
  if (rightOf.length >= 2) {
    rightOf.sort((a, b) => minOf(a) - minOf(b));
    const near = rightOf[0];
    const far = rightOf[1];
    if (perpOverlap(near, far)) {
      const refGap = minOf(far) - maxOf(near);
      if (refGap >= 0) {
        const snappedSrcMin = minOf(near) - refGap - srcSize;
        const delta = snappedSrcMin - srcMin;
        if (Math.abs(delta) <= tolerance) {
          if (!best || Math.abs(delta) < Math.abs(best.delta)) {
            best = { delta, snappedValue: snappedSrcMin, rects: [near, far] };
          }
        }
      }
    }
  }

  return best;
}

/**
 * Per-frame snap evaluation. Returns a position correction plus the
 * guide lines to render this frame.
 *
 * Edge alignment is tried first on each axis; equal-spacing is only
 * considered when edge alignment did not produce a hit on that axis.
 */
export function computeSnap(
  sourceRect: Rect,
  index: SnapIndex,
  options: SnapOptions,
): SnapResult {
  if (options.bypass) {
    return { deltaX: 0, deltaY: 0, guides: [] };
  }
  const t = options.thresholdFlow;
  if (t <= 0) {
    return { deltaX: 0, deltaY: 0, guides: [] };
  }

  const srcMinX = sourceRect.x;
  const srcMidX = sourceRect.x + sourceRect.w / 2;
  const srcMaxX = sourceRect.x + sourceRect.w;
  const srcMinY = sourceRect.y;
  const srcMidY = sourceRect.y + sourceRect.h / 2;
  const srcMaxY = sourceRect.y + sourceRect.h;

  const activeX = options.activeEdges?.x ?? 'both';
  const activeY = options.activeEdges?.y ?? 'both';
  const enableEqualSpacing = options.enableEqualSpacing ?? true;

  // --- Edge alignment ----------------------------------------------
  const xHit = bestAxisHit(index.byX, srcMinX, srcMidX, srcMaxX, t, activeX);
  const yHit = bestAxisHit(index.byY, srcMinY, srcMidY, srcMaxY, t, activeY);

  let deltaX = xHit?.delta ?? 0;
  let deltaY = yHit?.delta ?? 0;

  // Build the post-snap source rect so guide segments span the right area.
  const snappedRect: Rect = {
    x: sourceRect.x + deltaX,
    y: sourceRect.y + deltaY,
    w: sourceRect.w,
    h: sourceRect.h,
  };

  const guides: Guide[] = [];
  if (xHit) {
    guides.push(
      buildGuide('x', xHit.snappedValue, xHit.candidate, snappedRect),
    );
  }
  if (yHit) {
    guides.push(
      buildGuide('y', yHit.snappedValue, yHit.candidate, snappedRect),
    );
  }

  // --- Equal spacing — only on axes that did not edge-snap ---------
  // Two passes in priority order: middle-equal (source between two
  // siblings with identical gaps on each side) wins; trailing-equal
  // (source extends a rhythm defined by two same-side siblings) only
  // fires when middle-equal did not.
  //
  // Resize callers typically pass `enableEqualSpacing: false` — the
  // geometry below assumes the whole rect is moving (so the
  // perpendicular axis stays fixed), which doesn't hold when only
  // one edge is being dragged.
  if (!xHit && enableEqualSpacing && activeX === 'both') {
    const eq = bestEqualSpacingHit(
      'x',
      index.rectsById.values(),
      sourceRect,
      t,
    );
    if (eq) {
      deltaX = eq.delta;
      const eqRect: Rect = { ...snappedRect, x: sourceRect.x + deltaX };
      guides.push({
        kind: 'equal-spacing',
        axis: 'y', // The "= =" indicator is drawn as a horizontal annotation
        value: eqRect.y + eqRect.h / 2,
        from: Math.min(eq.rects[0].x, eqRect.x),
        to: Math.max(eq.rects[1].x + eq.rects[1].w, eqRect.x + eqRect.w),
        rects: [eq.rects[0], eqRect, eq.rects[1]],
      });
    } else {
      const tr = bestTrailingSpacingHit(
        'x',
        index.rectsById.values(),
        sourceRect,
        t,
      );
      if (tr) {
        deltaX = tr.delta;
        const trRect: Rect = { ...snappedRect, x: sourceRect.x + deltaX };
        // Sort all three rects along the spacing axis so the overlay
        // renders ticks left-to-right (matches middle-equal convention).
        const sorted = [tr.rects[0], tr.rects[1], trRect].sort(
          (a, b) => a.x - b.x,
        ) as [Rect, Rect, Rect];
        guides.push({
          kind: 'equal-spacing',
          axis: 'y',
          value: trRect.y + trRect.h / 2,
          from: sorted[0].x,
          to: sorted[2].x + sorted[2].w,
          rects: sorted,
        });
      }
    }
  }
  if (!yHit && enableEqualSpacing && activeY === 'both') {
    const eq = bestEqualSpacingHit(
      'y',
      index.rectsById.values(),
      sourceRect,
      t,
    );
    if (eq) {
      deltaY = eq.delta;
      const eqRect: Rect = { ...snappedRect, y: sourceRect.y + deltaY };
      guides.push({
        kind: 'equal-spacing',
        axis: 'x', // Vertical annotation between vertically-spaced siblings.
        value: eqRect.x + eqRect.w / 2,
        from: Math.min(eq.rects[0].y, eqRect.y),
        to: Math.max(eq.rects[1].y + eq.rects[1].h, eqRect.y + eqRect.h),
        rects: [eq.rects[0], eqRect, eq.rects[1]],
      });
    } else {
      const tr = bestTrailingSpacingHit(
        'y',
        index.rectsById.values(),
        sourceRect,
        t,
      );
      if (tr) {
        deltaY = tr.delta;
        const trRect: Rect = { ...snappedRect, y: sourceRect.y + deltaY };
        const sorted = [tr.rects[0], tr.rects[1], trRect].sort(
          (a, b) => a.y - b.y,
        ) as [Rect, Rect, Rect];
        guides.push({
          kind: 'equal-spacing',
          axis: 'x',
          value: trRect.x + trRect.w / 2,
          from: sorted[0].y,
          to: sorted[2].y + sorted[2].h,
          rects: sorted,
        });
      }
    }
  }

  return { deltaX, deltaY, guides };
}
