/**
 * @file Frame `column` / `row` masonry layouts.
 *
 * Two deterministic pack algorithms that share one shape with the axis
 * swapped:
 *
 *   • `column` — N **columns**, each child stacks top-to-bottom inside
 *                its column, left-aligned. Drop column = column under
 *                the cursor (passed through `frameSlot`).
 *   • `row`    — N **rows**, mirror of column on the other axis
 *                (children stack left-to-right, top-aligned).
 *
 * Both modes enforce a "no empty track" invariant: as long as the
 * child count ≥ N, every track has at least one item. If a track
 * would be left empty (because a stored `frameSlot` accidentally
 * collapsed all children into a subset of tracks), one neighbour is
 * pulled in. The new slot assignment is written back to
 * `data.frameSlot` so subsequent passes stay stable.
 */
import {
  FRAME_GRID_DEFAULT_COUNT,
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_MIN_COUNT,
} from '../../types/canvas/node.js';
import { FRAME_PADDING, GRID_SIZE } from '../utils/constants.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { FrameLayoutMode } from '../../types/canvas/node.js';
import type { Node, XYPosition } from '@xyflow/react';

// ── Spacing constants ─────────────────────────────────────────────────

/** Gap between consecutive items stacked along the "infinite" axis. */
export const GRID_INTRA_TRACK_GAP = 24;
/** Gap between two adjacent tracks (columns or rows). */
export const GRID_INTER_TRACK_GAP = 12;
/** Fallback minimum track size when the children are still un-measured. */
const MIN_TRACK_SIZE = GRID_SIZE * 4;

// ── Public helpers ────────────────────────────────────────────────────

/**
 * Clamp a raw count value to the supported range. Falls back to
 * `FRAME_GRID_DEFAULT_COUNT` for non-integer / out-of-range inputs.
 */
export function clampGridCount(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return FRAME_GRID_DEFAULT_COUNT;
  }
  const r = Math.round(raw);
  if (r < FRAME_GRID_MIN_COUNT) return FRAME_GRID_MIN_COUNT;
  if (r > FRAME_GRID_MAX_COUNT) return FRAME_GRID_MAX_COUNT;
  return r;
}

/**
 * Read the layout config persisted on a frame. Returns `null` for
 * non-frame nodes or frames in `free` mode (caller no-ops).
 */
export function readFrameGridConfig(
  node: Node | undefined,
): { axis: 'column' | 'row'; count: number } | null {
  if (!node || node.type !== 'frame') return null;
  const data = node.data as
    | { layoutMode?: FrameLayoutMode; gridCount?: number }
    | undefined;
  if (data?.layoutMode !== 'column' && data?.layoutMode !== 'row') return null;
  return {
    axis: data.layoutMode,
    count: clampGridCount(data.gridCount),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────

interface ChildSlot {
  node: Node;
  width: number;
  height: number;
}

function isLocked(node: Node): boolean {
  return Boolean((node.data as Record<string, unknown> | undefined)?.locked);
}

function collectChildren(nodes: Node[], frameId: string): ChildSlot[] {
  const out: ChildSlot[] = [];
  for (const n of nodes) {
    if (n.parentId !== frameId) continue;
    const { width, height } = getNodeSize(n);
    out.push({ node: n, width: width || 0, height: height || 0 });
  }
  return out;
}

function clampInt(raw: number, lo: number, hi: number): number {
  if (raw < lo) return lo;
  if (raw > hi) return hi;
  return raw;
}

/**
 * Assign each child to a track index (0..count-1):
 *   1. Honour the stored `frameSlot` when present.
 *   2. Unassigned children go into the track with the fewest items
 *      (ties → first such track).
 *   3. While any track is empty AND total children ≥ count, pull the
 *      nearest item from the busiest track into the empty one.
 *
 * `sortKey(child)` decides the natural ordering — Y for column mode,
 * X for row mode — used both for tie-breaking and "nearest" selection.
 */
function assignTrackSlots(
  children: ChildSlot[],
  count: number,
  sortKey: (c: ChildSlot) => number,
): Map<string, number> {
  const ordered = [...children].sort((a, b) => sortKey(a) - sortKey(b));
  const buckets: string[][] = Array.from({ length: count }, () => []);
  const assignment = new Map<string, number>();

  // Pass 1 — honour stored slots.
  const unassigned: ChildSlot[] = [];
  for (const child of ordered) {
    const raw = (child.node.data as { frameSlot?: number } | undefined)
      ?.frameSlot;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const slot = clampInt(Math.round(raw), 0, count - 1);
      buckets[slot].push(child.node.id);
      assignment.set(child.node.id, slot);
    } else {
      unassigned.push(child);
    }
  }

  // Pass 2 — place leftovers into the least-full track.
  for (const child of unassigned) {
    let target = 0;
    for (let i = 1; i < count; i += 1) {
      if (buckets[i].length < buckets[target].length) target = i;
    }
    buckets[target].push(child.node.id);
    assignment.set(child.node.id, target);
  }

  // Pass 3 — no empty track invariant.
  rebalanceEmptyTracks(buckets, count, assignment);

  return assignment;
}

/** Pull one item from the nearest busy track into any empty track. */
function rebalanceEmptyTracks(
  buckets: string[][],
  count: number,
  assignment: Map<string, number>,
): void {
  const total = buckets.reduce((s, b) => s + b.length, 0);
  if (total < count) return; // impossible to fill every track.

  let safety = total * count + 10;
  while (safety-- > 0) {
    const emptyIdx = buckets.findIndex((b) => b.length === 0);
    if (emptyIdx === -1) return;

    // Nearest track with ≥ 2 items.
    let src = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      if (buckets[i].length < 2) continue;
      const dist = Math.abs(i - emptyIdx);
      if (dist < bestDist) {
        bestDist = dist;
        src = i;
      }
    }
    if (src === -1) return;

    // Move the *last* item — keeps remaining items in their original
    // order while still satisfying the invariant.
    const moved = buckets[src].pop();
    if (!moved) return;
    buckets[emptyIdx].push(moved);
    assignment.set(moved, emptyIdx);
  }
}

// ── Result types ──────────────────────────────────────────────────────

/**
 * Pure-compute output of {@link applyColumnLayout} / {@link applyRowLayout}:
 * the new positions for each child, the resulting frame size, and the
 * track-slot assignment that should be persisted on each child's
 * `data.frameSlot`. Callers translate this into commands
 * (`SET_NODE_GEOMETRY`, `MERGE_NODE_DATA`).
 *
 * `null` is returned by the wrapper functions when the frame is missing,
 * locked, or has no children.
 */
export interface FrameGridLayoutResult {
  childPositions: Map<string, XYPosition>;
  slotAssignments: Map<string, number>;
  frameSize: { width: number; height: number };
}

// ── Column masonry ────────────────────────────────────────────────────

/**
 * N-column layout. Children stack top-to-bottom inside their column,
 * left-aligned. Column width adapts to the widest child in that column.
 */
export function applyColumnLayout(
  nodes: Node[],
  frameId: string,
  count: number,
): FrameGridLayoutResult | null {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame || frame.type !== 'frame' || isLocked(frame)) return null;

  const children = collectChildren(nodes, frameId);
  if (children.length === 0) return null;

  const cols = clampGridCount(count);
  const assignment = assignTrackSlots(children, cols, (c) => c.node.position.y);

  // Bucket by column, sort each column by current Y.
  const colItems: ChildSlot[][] = Array.from({ length: cols }, () => []);
  for (const child of children) {
    const slot = assignment.get(child.node.id) ?? 0;
    colItems[slot].push(child);
  }
  for (const list of colItems) {
    list.sort((a, b) => a.node.position.y - b.node.position.y);
  }

  const colWidth = colItems.map((items) =>
    items.length === 0 ? 0 : Math.max(...items.map((i) => i.width)),
  );

  // Cumulative left edge of each column.
  const colOriginX = new Array<number>(cols).fill(FRAME_PADDING);
  for (let c = 1; c < cols; c += 1) {
    colOriginX[c] =
      colOriginX[c - 1] +
      (colWidth[c - 1] > 0 ? colWidth[c - 1] + GRID_INTER_TRACK_GAP : 0);
  }

  const positions = new Map<string, XYPosition>();
  let tallest = 0;
  for (let c = 0; c < cols; c += 1) {
    let y = FRAME_PADDING;
    for (const item of colItems[c]) {
      positions.set(item.node.id, { x: colOriginX[c], y });
      y += item.height + GRID_INTRA_TRACK_GAP;
    }
    const bottom = colItems[c].length > 0 ? y - GRID_INTRA_TRACK_GAP : 0;
    if (bottom > tallest) tallest = bottom;
  }

  const lastCol = cols - 1;
  const contentRight =
    cols > 0 ? colOriginX[lastCol] + colWidth[lastCol] : FRAME_PADDING;
  const width = contentRight + FRAME_PADDING;
  const height = tallest + FRAME_PADDING;

  return {
    childPositions: positions,
    slotAssignments: assignment,
    frameSize: { width, height },
  };
}

// ── Row masonry (mirror) ──────────────────────────────────────────────

/**
 * N-row layout. Children stack left-to-right inside their row,
 * top-aligned. Row height adapts to the tallest child in that row.
 */
export function applyRowLayout(
  nodes: Node[],
  frameId: string,
  count: number,
): FrameGridLayoutResult | null {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame || frame.type !== 'frame' || isLocked(frame)) return null;

  const children = collectChildren(nodes, frameId);
  if (children.length === 0) return null;

  const rows = clampGridCount(count);
  const assignment = assignTrackSlots(children, rows, (c) => c.node.position.x);

  const rowItems: ChildSlot[][] = Array.from({ length: rows }, () => []);
  for (const child of children) {
    const slot = assignment.get(child.node.id) ?? 0;
    rowItems[slot].push(child);
  }
  for (const list of rowItems) {
    list.sort((a, b) => a.node.position.x - b.node.position.x);
  }

  const rowHeight = rowItems.map((items) =>
    items.length === 0 ? 0 : Math.max(...items.map((i) => i.height)),
  );

  const rowOriginY = new Array<number>(rows).fill(FRAME_PADDING);
  for (let r = 1; r < rows; r += 1) {
    rowOriginY[r] =
      rowOriginY[r - 1] +
      (rowHeight[r - 1] > 0 ? rowHeight[r - 1] + GRID_INTER_TRACK_GAP : 0);
  }

  const positions = new Map<string, XYPosition>();
  let widest = 0;
  for (let r = 0; r < rows; r += 1) {
    let x = FRAME_PADDING;
    for (const item of rowItems[r]) {
      positions.set(item.node.id, { x, y: rowOriginY[r] });
      x += item.width + GRID_INTRA_TRACK_GAP;
    }
    const right = rowItems[r].length > 0 ? x - GRID_INTRA_TRACK_GAP : 0;
    if (right > widest) widest = right;
  }

  const lastRow = rows - 1;
  const contentBottom =
    rows > 0 ? rowOriginY[lastRow] + rowHeight[lastRow] : FRAME_PADDING;
  const width = widest + FRAME_PADDING;
  const height = contentBottom + FRAME_PADDING;

  return {
    childPositions: positions,
    slotAssignments: assignment,
    frameSize: { width, height },
  };
}

// ── Drag-time slot pickers ────────────────────────────────────────────

/**
 * Map a flow-space drop point to a column index. Uses the live laid-out
 * children (excluding the dragged node) to read each column's screen X
 * so clicking past the last column maps to the last index, and clicking
 * an empty area inside a column-mode frame still picks the nearest lane.
 */
export function pickColumnSlotFromFramePoint(
  nodes: Node[],
  frameId: string,
  framePoint: { x: number; y: number },
  excludeNodeId: string,
  count: number,
): number {
  const others = collectChildren(nodes, frameId).filter(
    (c) => c.node.id !== excludeNodeId,
  );
  if (others.length === 0) return 0;

  const colWidths = new Array<number>(count).fill(0);
  for (const child of others) {
    const raw = (child.node.data as { frameSlot?: number } | undefined)
      ?.frameSlot;
    const c =
      typeof raw === 'number' && Number.isFinite(raw)
        ? clampInt(Math.round(raw), 0, count - 1)
        : 0;
    if (child.width > colWidths[c]) colWidths[c] = child.width;
  }

  let cursor = FRAME_PADDING;
  const colCentres = new Array<number>(count).fill(0);
  for (let c = 0; c < count; c += 1) {
    const w = colWidths[c] > 0 ? colWidths[c] : MIN_TRACK_SIZE;
    colCentres[c] = cursor + w / 2;
    cursor += w + GRID_INTER_TRACK_GAP;
  }

  let best = 0;
  let bestDist = Math.abs(framePoint.x - colCentres[0]);
  for (let c = 1; c < count; c += 1) {
    const d = Math.abs(framePoint.x - colCentres[c]);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Mirror of {@link pickColumnSlotFromFramePoint} for the row axis. */
export function pickRowSlotFromFramePoint(
  nodes: Node[],
  frameId: string,
  framePoint: { x: number; y: number },
  excludeNodeId: string,
  count: number,
): number {
  const others = collectChildren(nodes, frameId).filter(
    (c) => c.node.id !== excludeNodeId,
  );
  if (others.length === 0) return 0;

  const rowHeights = new Array<number>(count).fill(0);
  for (const child of others) {
    const raw = (child.node.data as { frameSlot?: number } | undefined)
      ?.frameSlot;
    const r =
      typeof raw === 'number' && Number.isFinite(raw)
        ? clampInt(Math.round(raw), 0, count - 1)
        : 0;
    if (child.height > rowHeights[r]) rowHeights[r] = child.height;
  }

  let cursor = FRAME_PADDING;
  const rowCentres = new Array<number>(count).fill(0);
  for (let r = 0; r < count; r += 1) {
    const h = rowHeights[r] > 0 ? rowHeights[r] : MIN_TRACK_SIZE;
    rowCentres[r] = cursor + h / 2;
    cursor += h + GRID_INTER_TRACK_GAP;
  }

  let best = 0;
  let bestDist = Math.abs(framePoint.y - rowCentres[0]);
  for (let r = 1; r < count; r += 1) {
    const d = Math.abs(framePoint.y - rowCentres[r]);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}
