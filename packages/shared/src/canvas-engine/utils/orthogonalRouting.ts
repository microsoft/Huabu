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
export interface OrthogonalSegment {
  start: OrthogonalPoint;
  end: OrthogonalPoint;
}
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
  occupiedSegments?: readonly OrthogonalSegment[];
  laneOffset?: number;
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

function outwardStub(
  point: OrthogonalPoint,
  side: OrthogonalSide,
  length: number,
  rect?: OrthogonalRect,
): OrthogonalPoint {
  let span = length;
  if (rect) {
    const boundary =
      side === 'right'
        ? rect.x + rect.w - point.x
        : side === 'left'
          ? point.x - rect.x
          : side === 'bottom'
            ? rect.y + rect.h - point.y
            : point.y - rect.y;
    span = Math.max(span, boundary);
  }
  return {
    x: point.x + NORMAL[side].x * span,
    y: point.y + NORMAL[side].y * span,
  };
}

function simplify(points: readonly OrthogonalPoint[]): OrthogonalPoint[] {
  const result: OrthogonalPoint[] = [];
  for (const point of points) {
    if (result.length && distance(result[result.length - 1], point) < EPSILON)
      continue;
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
    if (
      !c ||
      !radius ||
      (a.x === b.x && b.x === c.x) ||
      (a.y === b.y && b.y === c.y)
    ) {
      path += ` L ${b.x} ${b.y}`;
      continue;
    }
    const r = Math.min(radius, distance(a, b) / 2, distance(b, c) / 2);
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

function crowding(
  a: OrthogonalPoint,
  b: OrthogonalPoint,
  occupied: readonly OrthogonalSegment[],
  spacing: number,
): number {
  const horizontal = a.y === b.y;
  let cost = 0;
  for (const segment of occupied) {
    const c = segment.start;
    const d = segment.end;
    if ((c.y === d.y) === horizontal) {
      const gap = horizontal ? Math.abs(a.y - c.y) : Math.abs(a.x - c.x);
      if (gap >= spacing) continue;
      const overlap = horizontal
        ? Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
          Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))
        : Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) -
          Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
      cost += Math.max(0, overlap) * 4 * (1 - gap / spacing);
    } else {
      const x = horizontal ? c.x : a.x;
      const y = horizontal ? a.y : c.y;
      if (
        x > Math.min(a.x, b.x) - EPSILON &&
        x < Math.max(a.x, b.x) + EPSILON &&
        y > Math.min(a.y, b.y) - EPSILON &&
        y < Math.max(a.y, b.y) + EPSILON &&
        x > Math.min(c.x, d.x) - EPSILON &&
        x < Math.max(c.x, d.x) + EPSILON &&
        y > Math.min(c.y, d.y) - EPSILON &&
        y < Math.max(c.y, d.y) + EPSILON
      )
        cost += 20;
    }
  }
  return cost;
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
  const clearance = Math.max(0, options.clearance ?? 12);
  const radius = Math.min(8, clearance / 2);
  const stubLength = Math.max(1, options.stubLength ?? 24, clearance + radius);
  const bendPenalty = Math.max(0, options.bendPenalty ?? 24);
  const spacing = Math.max(12, clearance);
  const laneOffset = options.laneOffset ?? 0;
  const occupied = options.occupiedSegments ?? [];
  const obstacles = options.obstacles
    .filter(
      (r) =>
        r.w >= 0 && r.h >= 0 && [r.x, r.y, r.w, r.h].every(Number.isFinite),
    )
    .map((r) => inflate(r, clearance));
  const sourceRect = options.sourceRect
    ? inflate(options.sourceRect, clearance)
    : undefined;
  const targetRect = options.targetRect
    ? inflate(options.targetRect, clearance)
    : undefined;
  const blockers = [
    ...obstacles,
    ...(sourceRect ? [sourceRect] : []),
    ...(targetRect ? [targetRect] : []),
  ];
  const start = outwardStub(source, sourceSide, stubLength, sourceRect);
  const end = outwardStub(target, targetSide, stubLength, targetRect);
  const horizontal =
    Math.abs(target.x - source.x) >= Math.abs(target.y - source.y);
  const lane =
    (horizontal ? (source.y + target.y) / 2 : (source.x + target.x) / 2) +
    laneOffset;
  const segmentCost = (a: OrthogonalPoint, b: OrthogonalPoint): number => {
    const length = distance(a, b);
    const alongLane = horizontal ? a.y === b.y : a.x === b.x;
    const laneCost =
      laneOffset && alongLane
        ? length *
          0.75 *
          Math.min(
            4,
            Math.abs((horizontal ? a.y : a.x) - lane) / Math.abs(laneOffset),
          )
        : 0;
    return length + crowding(a, b, occupied, spacing) + laneCost;
  };
  const blockedPort =
    obstacles.some((r) => hits(source, start, r) || hits(end, target, r)) ||
    !!(targetRect && hits(source, start, targetRect)) ||
    !!(sourceRect && hits(end, target, sourceRect));
  // Distant cards must not consume the coordinate budget. Select grid
  // coordinates locally, then include every obstacle intersecting the final
  // search bounds in collision checks; a final global check fences the result.
  const margin = Math.max(
    stubLength * 2,
    distance(start, end) / 3,
    Math.abs(laneOffset) + spacing,
  );
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
  if (horizontal) ys.push(lane);
  else xs.push(lane);
  let left = Math.min(start.x, end.x, horizontal ? start.x : lane);
  let right = Math.max(start.x, end.x, horizontal ? start.x : lane);
  let top = Math.min(start.y, end.y, horizontal ? lane : start.y);
  let bottom = Math.max(start.y, end.y, horizontal ? lane : start.y);
  for (const rect of localBlockers) {
    xs.push(rect.x, rect.x + rect.w);
    ys.push(rect.y, rect.y + rect.h);
    left = Math.min(left, rect.x);
    right = Math.max(right, rect.x + rect.w);
    top = Math.min(top, rect.y);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  for (const segment of occupied) {
    xs.push(
      segment.start.x - spacing,
      segment.start.x + spacing,
      segment.end.x - spacing,
      segment.end.x + spacing,
    );
    ys.push(
      segment.start.y - spacing,
      segment.start.y + spacing,
      segment.end.y - spacing,
      segment.end.y + spacing,
    );
    const rect = {
      x: Math.min(segment.start.x, segment.end.x),
      y: Math.min(segment.start.y, segment.end.y),
      w: Math.abs(segment.start.x - segment.end.x),
      h: Math.abs(segment.start.y - segment.end.y),
    };
    if (overlaps(rect, neighborhood)) {
      left = Math.min(left, Math.max(rect.x, neighborhood.x));
      right = Math.max(
        right,
        Math.min(rect.x + rect.w, neighborhood.x + neighborhood.w),
      );
      top = Math.min(top, Math.max(rect.y, neighborhood.y));
      bottom = Math.max(
        bottom,
        Math.min(rect.y + rect.h, neighborhood.y + neighborhood.h),
      );
    }
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
    ...[lane, lane - spacing, lane + spacing].map(
      horizontal ? horizontalChannel : verticalChannel,
    ),
  ];
  const rankCandidates = (candidates: OrthogonalPoint[][]) => {
    // Compare collision counts before costs, so a long safe detour always beats
    // a short crossing. Every candidate is checked against ALL obstacles, even
    // when their count exceeds the search budget. Lane and crowding costs remain
    // active here: distant cards must not collapse parallel connections.
    return candidates
      .map((middle, order) => {
        const points = simplify([source, ...middle, target]);
        let collisions = 0;
        let reversals = 0;
        let cost = 0;
        let congestion = 0;
        for (let i = 1; i < middle.length; i++) {
          congestion += crowding(middle[i - 1], middle[i], occupied, spacing);
          for (const rect of blockers) {
            if (hits(middle[i - 1], middle[i], rect)) collisions++;
          }
        }
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1];
          const b = points[i];
          const c = points[i + 1];
          cost += segmentCost(a, b);
          if (c) {
            if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0)
              reversals++;
            if ((a.x === b.x) !== (b.x === c.x)) cost += bendPenalty;
          }
        }
        return { points, collisions, reversals, cost, congestion, order };
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

  // Most drag frames need only a direct, L-shaped or local channel route.
  // These candidates never use the far perimeter. Validate the whole route
  // and score occupied lanes before returning; blocked candidates go to A*.
  if (!blockedPort) {
    const quick = rankCandidates(compactCandidates)[0];
    if (
      quick.collisions === 0 &&
      quick.reversals === 0 &&
      quick.congestion <= Math.max(spacing * 4, distance(start, end) * 0.3)
    )
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
  const count = width * gridY.length;
  const startId = gridY.indexOf(start.y) * width + gridX.indexOf(start.x);
  const endId = gridY.indexOf(end.y) * width + gridX.indexOf(end.x);
  const pointAt = (id: number): OrthogonalPoint => ({
    x: gridX[id % width],
    y: gridY[Math.floor(id / width)],
  });
  const scores = new Float64Array(count * 4).fill(Infinity);
  const previous = new Int32Array(count * 4).fill(-1);
  const clear = new Map<number, boolean>();
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
      row + 1 < gridY.length ? id + width : -1,
      col > 0 ? id - 1 : -1,
      row > 0 ? id - width : -1,
    ];
    for (let nextDirection = 0; nextDirection < 4; nextDirection++) {
      const next = neighbors[nextDirection];
      if (next < 0 || nextDirection === (direction + 2) % 4) continue;
      const b = pointAt(next);
      const key = Math.min(id, next) * count + Math.max(id, next);
      let passable = clear.get(key);
      if (passable === undefined) {
        passable = !gridBlockers.some((r) => hits(a, b, r));
        clear.set(key, passable);
      }
      if (!passable) continue;
      const cost =
        current.cost +
        segmentCost(a, b) +
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
