// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface OrthogonalPoint {
  x: number;
  y: number;
}
export interface OrthogonalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type OrthogonalSide = 'left' | 'right' | 'top' | 'bottom';
export interface OrthogonalRouteOptions {
  source: OrthogonalPoint;
  target: OrthogonalPoint;
  sourceSide: OrthogonalSide;
  targetSide: OrthogonalSide;
  obstacles: readonly OrthogonalRect[];
  sourceRect?: OrthogonalRect;
  targetRect?: OrthogonalRect;
  clearance?: number;
  stubLength?: number;
  bendPenalty?: number;
  maxGridPoints?: number;
}
export interface OrthogonalRoute {
  points: OrthogonalPoint[];
  path: string;
  labelX: number;
  labelY: number;
  status: 'routed' | 'fallback';
}

const NORMAL: Record<OrthogonalSide, OrthogonalPoint> = {
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  top: { x: 0, y: -1 },
};
const DIRECTION: Record<OrthogonalSide, number> = {
  right: 0,
  bottom: 1,
  left: 2,
  top: 3,
};
const EPSILON = 0.000001;

function distance(a: OrthogonalPoint, b: OrthogonalPoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function inflate(rect: OrthogonalRect, padding: number): OrthogonalRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    w: rect.w + padding * 2,
    h: rect.h + padding * 2,
  };
}

function overlaps(a: OrthogonalRect, b: OrthogonalRect): boolean {
  return (
    a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
  );
}

/** Boundary contact is allowed: inflated rectangles already provide clearance. */
function hits(
  a: OrthogonalPoint,
  b: OrthogonalPoint,
  rect: OrthogonalRect,
): boolean {
  if (a.y === b.y) {
    return (
      a.y > rect.y + EPSILON &&
      a.y < rect.y + rect.h - EPSILON &&
      Math.max(a.x, b.x) > rect.x + EPSILON &&
      Math.min(a.x, b.x) < rect.x + rect.w - EPSILON
    );
  }
  return (
    a.x > rect.x + EPSILON &&
    a.x < rect.x + rect.w - EPSILON &&
    Math.max(a.y, b.y) > rect.y + EPSILON &&
    Math.min(a.y, b.y) < rect.y + rect.h - EPSILON
  );
}

function exitDistance(
  point: OrthogonalPoint,
  side: OrthogonalSide,
  rect?: OrthogonalRect,
): number {
  if (!rect) return 0;
  return Math.max(
    0,
    side === 'right'
      ? rect.x + rect.w - point.x
      : side === 'left'
        ? point.x - rect.x
        : side === 'bottom'
          ? rect.y + rect.h - point.y
          : point.y - rect.y,
  );
}

function nearestForwardGap(
  point: OrthogonalPoint,
  side: OrthogonalSide,
  ownRect: OrthogonalRect | undefined,
  others: readonly OrthogonalRect[],
  pad: number,
): number {
  const exit = exitDistance(point, side, ownRect);
  const origin = {
    x: point.x + NORMAL[side].x * exit,
    y: point.y + NORMAL[side].y * exit,
  };
  let best = Infinity;
  for (const rect of others) {
    const spansPerp =
      side === 'left' || side === 'right'
        ? origin.y > rect.y - pad + EPSILON &&
          origin.y < rect.y + rect.h + pad - EPSILON
        : origin.x > rect.x - pad + EPSILON &&
          origin.x < rect.x + rect.w + pad - EPSILON;
    if (!spansPerp) continue;
    const gap =
      side === 'right'
        ? rect.x - origin.x
        : side === 'left'
          ? origin.x - (rect.x + rect.w)
          : side === 'bottom'
            ? rect.y - origin.y
            : origin.y - (rect.y + rect.h);
    if (gap >= 2 && gap < best) best = gap;
  }
  return best;
}

function outwardStub(
  point: OrthogonalPoint,
  side: OrthogonalSide,
  length: number,
  inflatedRect?: OrthogonalRect,
  rawRect?: OrthogonalRect,
): OrthogonalPoint {
  const span = Math.max(
    exitDistance(point, side, rawRect) + length,
    exitDistance(point, side, inflatedRect),
  );
  return side === 'left' || side === 'right'
    ? { x: point.x + NORMAL[side].x * span, y: point.y }
    : { x: point.x, y: point.y + NORMAL[side].y * span };
}

function simplify(points: readonly OrthogonalPoint[]): OrthogonalPoint[] {
  const result: OrthogonalPoint[] = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (prev && prev.x === point.x && prev.y === point.y) continue;
    const a = result[result.length - 2];
    const b = result[result.length - 1];
    // Preserve reversals: removing their bend would change endpoint direction.
    if (
      a &&
      b &&
      ((a.x === b.x && b.x === point.x && (b.y - a.y) * (point.y - b.y) >= 0) ||
        (a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0))
    )
      result.pop();
    result.push(point);
  }
  return result;
}

function render(
  points: OrthogonalPoint[],
  radius: number,
  status: OrthogonalRoute['status'],
): OrthogonalRoute {
  let path = `M ${points[0].x} ${points[0].y}`;
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += distance(points[i - 1], points[i]);
  let remaining = length / 2;
  let label = points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const span = distance(a, b);
    if (remaining <= span && span > 0) {
      label = {
        x: a.x + ((b.x - a.x) * remaining) / span,
        y: a.y + ((b.y - a.y) * remaining) / span,
      };
      break;
    }
    remaining -= span;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const r = c ? Math.min(radius, distance(a, b) / 2, distance(b, c) / 2) : 0;
    if (
      !c ||
      r < EPSILON ||
      (a.x === b.x && b.x === c.x) ||
      (a.y === b.y && b.y === c.y)
    ) {
      path += ` L ${b.x} ${b.y}`;
      continue;
    }
    const before = {
      x: b.x + Math.sign(a.x - b.x) * r,
      y: b.y + Math.sign(a.y - b.y) * r,
    };
    const after = {
      x: b.x + Math.sign(c.x - b.x) * r,
      y: b.y + Math.sign(c.y - b.y) * r,
    };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  return { points, path, labelX: label.x, labelY: label.y, status };
}

interface QueueEntry {
  state: number;
  cost: number;
  priority: number;
}

/** A stable binary heap keeps route search bounded without quadratic open-list scans. */
class SearchQueue {
  private entries: QueueEntry[] = [];
  private before(a: QueueEntry, b: QueueEntry): boolean {
    return (
      a.priority < b.priority ||
      (a.priority === b.priority && a.state < b.state)
    );
  }
  push(entry: QueueEntry): void {
    let index = this.entries.length;
    this.entries.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(entry, this.entries[parent])) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }
  pop(): QueueEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (!last || this.entries.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < this.entries.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.entries.length &&
        this.before(this.entries[child + 1], this.entries[child])
      )
        child++;
      if (!this.before(this.entries[child], last)) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

function coordinates(
  values: number[],
  required: number[],
  limit: number,
): number[] {
  const fixed = [...new Set(required)];
  const low = Math.min(required[0], required[1]);
  const high = Math.max(required[0], required[1]);
  const rank = (value: number) => Math.max(low - value, 0, value - high);
  const extras = [...new Set(values)]
    .filter((value) => !fixed.includes(value))
    .sort((a, b) => rank(a) - rank(b) || a - b);
  return [...fixed, ...extras.slice(0, Math.max(0, limit - fixed.length))].sort(
    (a, b) => a - b,
  );
}

// Each scanline stores one byte per adjacent segment. Mark the same interior
// intersections as hits(), once per blocker instead of once per A* transition.
function blockedGridSegments(
  lines: readonly number[],
  points: readonly number[],
  blockers: readonly OrthogonalRect[],
  horizontal: boolean,
): Uint8Array {
  const stride = points.length - 1;
  const blocked = new Uint8Array(lines.length * stride);
  for (const rect of blockers) {
    const minLine = (horizontal ? rect.y : rect.x) + EPSILON;
    const maxLine = (horizontal ? rect.y + rect.h : rect.x + rect.w) - EPSILON;
    const minPoint = (horizontal ? rect.x : rect.y) + EPSILON;
    const maxPoint = (horizontal ? rect.x + rect.w : rect.y + rect.h) - EPSILON;
    let first = 0;
    while (first < stride && points[first + 1] <= minPoint) first++;
    let end = first;
    while (end < stride && points[end] < maxPoint) end++;
    if (first === end) continue;
    for (let line = 0; line < lines.length && lines[line] < maxLine; line++) {
      if (lines[line] > minLine) {
        const offset = line * stride;
        blocked.fill(1, offset + first, offset + end);
      }
    }
  }
  return blocked;
}

/**
 * Route in absolute canvas coordinates, with a hard cap on grid size and search work.
 * Endpoint rectangles are obstacles after their own outward port stubs. Other
 * obstacles must not include those rectangles a second time. Rounded corners stay
 * inside the clearance envelope. A fallback preserves ports but is not promised
 * obstacle-free when ports overlap cards or the bounded search cannot find a path.
 */
export function routeOrthogonalEdge(
  options: OrthogonalRouteOptions,
): OrthogonalRoute {
  const { source, target, sourceSide, targetSide } = options;
  const requestedClearance = Math.max(0, options.clearance ?? 12);
  const baseRadius = Math.min(8, requestedClearance / 2);
  const bendPenalty = Math.max(0, options.bendPenalty ?? 24);
  const validRect = (r: OrthogonalRect) =>
    r.w >= 0 && r.h >= 0 && [r.x, r.y, r.w, r.h].every(Number.isFinite);
  const rawObstacles = options.obstacles.filter(validRect);
  const rawSourceRect =
    options.sourceRect && validRect(options.sourceRect)
      ? options.sourceRect
      : undefined;
  const rawTargetRect =
    options.targetRect && validRect(options.targetRect)
      ? options.targetRect
      : undefined;
  const fullObstacles = rawObstacles.map((r) => inflate(r, requestedClearance));
  const fullSourceRect = rawSourceRect
    ? inflate(rawSourceRect, requestedClearance)
    : undefined;
  const fullTargetRect = rawTargetRect
    ? inflate(rawTargetRect, requestedClearance)
    : undefined;

  // Direct aligned facing and single-bend perpendicular routes need no stubs
  // when clear, preventing overshoot in narrow gaps between nearby cards.
  const sourceNormal = NORMAL[sourceSide];
  const targetNormal = NORMAL[targetSide];
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (
    DIRECTION[targetSide] === (DIRECTION[sourceSide] + 2) % 4 &&
    dx * sourceNormal.x + dy * sourceNormal.y > EPSILON &&
    dx * sourceNormal.y - dy * sourceNormal.x === 0 &&
    !fullObstacles.some((rect) => hits(source, target, rect)) &&
    !(rawSourceRect && hits(source, target, rawSourceRect)) &&
    !(rawTargetRect && hits(source, target, rawTargetRect))
  )
    return render([source, target], baseRadius, 'routed');

  if ((DIRECTION[sourceSide] + DIRECTION[targetSide]) % 2 === 1) {
    const corner =
      sourceNormal.x !== 0
        ? { x: target.x, y: source.y }
        : { x: source.x, y: target.y };
    if (
      (corner.x - source.x) * sourceNormal.x +
        (corner.y - source.y) * sourceNormal.y >
        EPSILON &&
      (corner.x - target.x) * targetNormal.x +
        (corner.y - target.y) * targetNormal.y >
        EPSILON &&
      !fullObstacles.some(
        (rect) => hits(source, corner, rect) || hits(corner, target, rect),
      ) &&
      !(rawSourceRect && hits(source, corner, rawSourceRect)) &&
      !(rawTargetRect && hits(corner, target, rawTargetRect)) &&
      !(fullSourceRect && hits(corner, target, fullSourceRect)) &&
      !(fullTargetRect && hits(source, corner, fullTargetRect))
    )
      return render([source, corner, target], baseRadius, 'routed');
  }

  // Proportionally scale clearance and stubs when a narrow corridor sits right
  // in front of either port so adjacent cards do not force stub reversals.
  const sourceGap = nearestForwardGap(
    source,
    sourceSide,
    rawSourceRect,
    [...rawObstacles, ...(rawTargetRect ? [rawTargetRect] : [])],
    requestedClearance,
  );
  const targetGap = nearestForwardGap(
    target,
    targetSide,
    rawTargetRect,
    [...rawObstacles, ...(rawSourceRect ? [rawSourceRect] : [])],
    requestedClearance,
  );
  const sourceExit = exitDistance(source, sourceSide, rawSourceRect);
  const targetExit = exitDistance(target, targetSide, rawTargetRect);
  const facingSpan =
    DIRECTION[targetSide] === (DIRECTION[sourceSide] + 2) % 4
      ? dx * sourceNormal.x + dy * sourceNormal.y - sourceExit - targetExit
      : Infinity;
  const facingChannel =
    facingSpan >= 2 &&
    (facingSpan >= requestedClearance || (!rawSourceRect && !rawTargetRect))
      ? facingSpan
      : Infinity;
  const tightestGap = Math.min(sourceGap, targetGap, facingChannel);
  const clearance =
    tightestGap < Infinity
      ? Math.min(requestedClearance, tightestGap * 0.35)
      : requestedClearance;
  const radius = Math.min(8, clearance / 2);
  const stubLength = Math.max(1, options.stubLength ?? 24, clearance + radius);
  const spacing = Math.max(12, clearance);
  const obstacles =
    clearance === requestedClearance
      ? fullObstacles
      : rawObstacles.map((r) => inflate(r, clearance));
  const sourceRect =
    clearance === requestedClearance
      ? fullSourceRect
      : rawSourceRect
        ? inflate(rawSourceRect, clearance)
        : undefined;
  const targetRect =
    clearance === requestedClearance
      ? fullTargetRect
      : rawTargetRect
        ? inflate(rawTargetRect, clearance)
        : undefined;
  const blockers = [
    ...obstacles,
    ...(sourceRect ? [sourceRect] : []),
    ...(targetRect ? [targetRect] : []),
  ];
  const sourceCap = Math.min(sourceGap, facingChannel) / 2;
  const targetCap = Math.min(targetGap, facingChannel) / 2;
  const start = outwardStub(
    source,
    sourceSide,
    sourceCap < stubLength ? sourceCap : stubLength,
    sourceRect,
    rawSourceRect,
  );
  const end = outwardStub(
    target,
    targetSide,
    targetCap < stubLength ? targetCap : stubLength,
    targetRect,
    rawTargetRect,
  );
  const blockedPort =
    obstacles.some((r) => hits(source, start, r) || hits(end, target, r)) ||
    !!(targetRect && hits(source, start, targetRect)) ||
    !!(sourceRect && hits(end, target, sourceRect));
  // Distant cards must not consume the coordinate budget. Select grid
  // coordinates locally, then include every obstacle intersecting the final
  // search bounds in collision checks; a final global check fences the result.
  const margin = Math.max(stubLength * 2, distance(start, end) / 3);
  const neighborhood = {
    x: Math.min(start.x, end.x) - margin,
    y: Math.min(start.y, end.y) - margin,
    w: Math.abs(start.x - end.x) + margin * 2,
    h: Math.abs(start.y - end.y) + margin * 2,
  };
  const localBlockers = blockers.filter((rect) => overlaps(rect, neighborhood));
  const xs = [
    start.x,
    end.x,
    (start.x + end.x) / 2,
    start.x - spacing,
    start.x + spacing,
    end.x - spacing,
    end.x + spacing,
  ];
  const ys = [
    start.y,
    end.y,
    (start.y + end.y) / 2,
    start.y - spacing,
    start.y + spacing,
    end.y - spacing,
    end.y + spacing,
  ];
  let left = Math.min(start.x, end.x);
  let right = Math.max(start.x, end.x);
  let top = Math.min(start.y, end.y);
  let bottom = Math.max(start.y, end.y);
  for (const rect of localBlockers) {
    xs.push(rect.x, rect.x + rect.w);
    ys.push(rect.y, rect.y + rect.h);
    left = Math.min(left, rect.x);
    right = Math.max(right, rect.x + rect.w);
    top = Math.min(top, rect.y);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  left -= spacing;
  right += spacing;
  top -= spacing;
  bottom += spacing;

  const horizontalChannel = (y: number): OrthogonalPoint[] => [
    start,
    { x: start.x, y },
    { x: end.x, y },
    end,
  ];
  const verticalChannel = (x: number): OrthogonalPoint[] => [
    start,
    { x, y: start.y },
    { x, y: end.y },
    end,
  ];
  const compactCandidates = [
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
    horizontalChannel((start.y + end.y) / 2),
    verticalChannel((start.x + end.x) / 2),
  ];
  const rankCandidates = (candidates: OrthogonalPoint[][]) => {
    // Prefer a clear path, then fewer reversals and a shorter route.
    return candidates
      .map((middle, order) => {
        const points = simplify([source, ...middle, target]);
        let collisions = 0;
        let reversals = 0;
        let cost = 0;
        for (let i = 1; i < middle.length; i++) {
          for (const rect of blockers) {
            if (hits(middle[i - 1], middle[i], rect)) collisions++;
          }
        }
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1];
          const b = points[i];
          const c = points[i + 1];
          cost += distance(a, b);
          if (c) {
            if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0)
              reversals++;
            if ((a.x === b.x) !== (b.x === c.x)) cost += bendPenalty;
          }
        }
        return { points, collisions, reversals, cost, order };
      })
      .sort(
        (a, b) =>
          a.collisions - b.collisions ||
          a.reversals - b.reversals ||
          a.cost - b.cost ||
          a.order - b.order,
      );
  };
  const fallback = (): OrthogonalRoute => {
    const best = rankCandidates([
      ...compactCandidates,
      ...[top, bottom].map(horizontalChannel),
      ...[left, right].map(verticalChannel),
    ])[0];
    return render(
      best.points,
      radius,
      !blockedPort && best.collisions === 0 && best.reversals === 0
        ? 'routed'
        : 'fallback',
    );
  };

  // Try direct and simple bent paths before searching around obstacles.
  if (!blockedPort) {
    const quick = rankCandidates(compactCandidates)[0];
    if (quick.collisions === 0 && quick.reversals === 0)
      return render(quick.points, radius, 'routed');
  }

  // No middle route can repair a port already covered by another card.
  const searchBounds = { x: left, y: top, w: right - left, h: bottom - top };
  const gridBlockers = blockers.filter((rect) => overlaps(rect, searchBounds));
  if (blockedPort || gridBlockers.length > 256) return fallback();

  const limit = Math.floor(
    Math.sqrt(Math.max(16, Math.min(4096, options.maxGridPoints ?? 1600))),
  );
  const gridX = coordinates(
    xs.filter((x) => x >= left && x <= right),
    [start.x, end.x, left, right],
    limit,
  );
  const gridY = coordinates(
    ys.filter((y) => y >= top && y <= bottom),
    [start.y, end.y, top, bottom],
    limit,
  );
  const width = gridX.length;
  const height = gridY.length;
  const count = width * height;
  const startId = gridY.indexOf(start.y) * width + gridX.indexOf(start.x);
  const endId = gridY.indexOf(end.y) * width + gridX.indexOf(end.x);
  const pointAt = (id: number): OrthogonalPoint => ({
    x: gridX[id % width],
    y: gridY[Math.floor(id / width)],
  });
  const scores = new Float64Array(count * 4).fill(Infinity);
  const previous = new Int32Array(count * 4).fill(-1);
  const horizontal = blockedGridSegments(gridY, gridX, gridBlockers, true);
  const vertical = blockedGridSegments(gridX, gridY, gridBlockers, false);
  const queue = new SearchQueue();
  const initial = startId * 4 + DIRECTION[sourceSide];
  scores[initial] = 0;
  queue.push({ state: initial, cost: 0, priority: distance(start, end) });
  let found = -1;
  let visits = 0;
  while (visits++ < count * 8) {
    const current = queue.pop();
    if (!current) break;
    if (current.cost !== scores[current.state]) continue;
    const id = Math.floor(current.state / 4);
    const direction = current.state % 4;
    if (id === endId && direction !== DIRECTION[targetSide]) {
      found = current.state;
      break;
    }
    const a = pointAt(id);
    const col = id % width;
    const row = Math.floor(id / width);
    const neighbors = [
      col + 1 < width ? id + 1 : -1,
      row + 1 < height ? id + width : -1,
      col > 0 ? id - 1 : -1,
      row > 0 ? id - width : -1,
    ];
    for (let nextDirection = 0; nextDirection < 4; nextDirection++) {
      const next = neighbors[nextDirection];
      if (next < 0 || nextDirection === (direction + 2) % 4) continue;
      const blocked =
        nextDirection % 2 === 0
          ? horizontal[row * (width - 1) + col - (nextDirection === 2 ? 1 : 0)]
          : vertical[col * (height - 1) + row - (nextDirection === 3 ? 1 : 0)];
      if (blocked) continue;
      const b = pointAt(next);
      const cost =
        current.cost +
        distance(a, b) +
        (nextDirection !== direction ? bendPenalty : 0);
      const state = next * 4 + nextDirection;
      if (cost >= scores[state]) continue;
      scores[state] = cost;
      previous[state] = current.state;
      queue.push({ state, cost, priority: cost + distance(b, end) });
    }
  }
  if (found < 0) return fallback();
  const middle: OrthogonalPoint[] = [];
  for (let cursor = found; cursor >= 0; cursor = previous[cursor])
    middle.push(pointAt(Math.floor(cursor / 4)));
  middle.reverse();
  if (
    middle.some(
      (point, index) =>
        index > 0 &&
        blockers.some((rect) => hits(middle[index - 1], point, rect)),
    )
  )
    return fallback();
  return render(simplify([source, ...middle, target]), radius, 'routed');
}
