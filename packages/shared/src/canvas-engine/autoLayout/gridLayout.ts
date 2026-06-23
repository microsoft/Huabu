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
import { getFrameSizing } from '../frame/sizing.js';
import { paddingFromExtent } from '../utils/constants.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { FrameLayoutMode } from '../../types/canvas/node.js';
import type { Node, XYPosition } from '@xyflow/react';

// ── Spacing constants ─────────────────────────────────────────────────

/**
 * Gap-to-cell ratio. Gaps breathe with content size: an extent is
 * multiplied by this ratio to produce a gap.
 *
 * Each solver derives TWO gaps per axis: an **inter-track** gap
 * (between columns / rows) and an **intra-track** gap (between items
 * stacked inside one track). Each is computed from the median of the
 * children's extents ON THE AXIS WHERE THE GAP PARTICIPATES (widths
 * for the X-axis gap, heights for the Y-axis gap). This per-axis
 * derivation makes the solver self-consistent under per-axis resize:
 * scaling all child widths by `sx` makes the X-axis gap scale by `sx`
 * too, so the resulting frame width = `oldWidth × sx` exactly.
 */
const GAP_TO_CELL_RATIO = 0.08;

/**
 * Floor applied to every derived gap so tiny nodes still get a little
 * breathing room (and frames with un-measured children never collapse
 * their tracks together).
 */
const MIN_GAP = 8;

/**
 * Minimum half-width (flow units) of the "insert a new track between two
 * tracks" hit band. The literal inter-track gap is only a handful of
 * pixels ({@link gapFromExtent}), which is almost impossible to aim at,
 * so the between-tracks zone is widened to at least this much on each
 * side of the gap centre. Capped per call to a fraction of the
 * neighbouring tracks so narrow tracks stay selectable for `into-existing`.
 *
 * Axis-specific: columns are usually much wider than rows are tall, so a
 * generous 40px floor reads well between columns but would swallow the
 * top of a (shorter) row �?making a cursor in a row's upper area target
 * the gap above it. Rows therefore use a smaller floor.
 */
const INSERT_BETWEEN_MIN_HALF_COLUMN = 40;
const INSERT_BETWEEN_MIN_HALF_ROW = 24;

/** Fraction of a neighbouring track the widened between-tracks band may
 *  reach into, so the track's centre always stays `into-existing`. */
const INSERT_BETWEEN_NEIGHBOUR_RATIO = 0.3;

/**
 * Half-width of the between-tracks insert band at the gap between two
 * adjacent tracks of size `prevExtent` / `nextExtent`. Widens the literal
 * `gap` to `minHalf` for an easy target, but never reaches past
 * {@link INSERT_BETWEEN_NEIGHBOUR_RATIO} of either neighbour.
 */
function insertBetweenHalfBand(
  gap: number,
  prevExtent: number,
  nextExtent: number,
  minHalf: number,
): number {
  const desired = Math.max(gap / 2, minHalf);
  // Cap the widened band at half the literal gap plus a bounded reach
  // into the *narrower* neighbour, so each track's centre always stays
  // `into-existing` while the between-tracks zone is still easy to hit.
  const maxReachIntoNeighbour =
    Math.min(prevExtent, nextExtent) * INSERT_BETWEEN_NEIGHBOUR_RATIO;
  const cap = gap / 2 + maxReachIntoNeighbour;
  return Math.min(desired, cap);
}

/**
 * Derive a gap from a representative child extent — typically the
 * median of one axis's child extents (widths for an X-axis gap,
 * heights for a Y-axis gap). Floored at {@link MIN_GAP}.
 */
function gapFromExtent(extent: number): number {
  if (!Number.isFinite(extent) || extent <= 0) return MIN_GAP;
  return Math.max(MIN_GAP, extent * GAP_TO_CELL_RATIO);
}

/**
 * Median of a numeric list (0 for an empty list). Used as a robust
 * basis for derived gap / padding so one oversized node doesn't blow
 * out the spacing across the frame.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

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
 *      (ties �?first such track).
 *   3. Resolve empty tracks per `emptyTrackPolicy`:
 *      - `'fill'`    �?pull the nearest item from the busiest track into
 *        each empty one (the "no empty track" invariant). Used when the
 *        caller explicitly asked for N tracks (e.g. the count stepper)
 *        and wants the children spread to fill them.
 *      - `'compact'` �?drop empty tracks instead, renumbering survivors
 *        to a contiguous range. Used for organic child changes (a
 *        deletion that empties a track, a drag that vacates one): the
 *        track simply disappears rather than being back-filled.
 *
 * Returns the assignment plus the **effective** track count, which is
 * `count` for `'fill'` and �?`count` for `'compact'`.
 *
 * `sortKey(child)` decides the natural ordering �?Y for column mode,
 * X for row mode �?used both for tie-breaking and "nearest" selection.
 */
function assignTrackSlots(
  children: ChildSlot[],
  count: number,
  sortKey: (c: ChildSlot) => number,
  emptyTrackPolicy: 'fill' | 'compact',
): { assignment: Map<string, number>; count: number } {
  const ordered = [...children].sort((a, b) => sortKey(a) - sortKey(b));
  const buckets: string[][] = Array.from({ length: count }, () => []);
  const assignment = new Map<string, number>();

  // Pass 1 �?honour stored slots.
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

  // Pass 2 �?place leftovers into the least-full track.
  for (const child of unassigned) {
    let target = 0;
    for (let i = 1; i < count; i += 1) {
      if (buckets[i].length < buckets[target].length) target = i;
    }
    buckets[target].push(child.node.id);
    assignment.set(child.node.id, target);
  }

  // Pass 3 �?resolve empty tracks (fill vs. compact).
  if (emptyTrackPolicy === 'fill') {
    rebalanceEmptyTracks(buckets, count, assignment);
    return { assignment, count };
  }
  const compactCount = compactEmptyTracks(buckets, assignment);
  return { assignment, count: compactCount };
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

    // Nearest track with �?2 items.
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

    // Move the *last* item �?keeps remaining items in their original
    // order while still satisfying the invariant.
    const moved = buckets[src].pop();
    if (!moved) return;
    buckets[emptyIdx].push(moved);
    assignment.set(moved, emptyIdx);
  }
}

/**
 * Drop empty tracks and renumber the survivors to a contiguous
 * `0..M-1` range, preserving order (so column 0 stays leftmost).
 * Rewrites `assignment` in place and returns the resulting track
 * count `M` (�?1 whenever there is at least one item).
 */
function compactEmptyTracks(
  buckets: string[][],
  assignment: Map<string, number>,
): number {
  const remap = new Map<number, number>();
  let next = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    if (buckets[i].length === 0) continue;
    remap.set(i, next);
    next += 1;
  }
  // No empty track in range �?identity, nothing to renumber.
  if (next === buckets.length) return buckets.length;
  for (const [id, slot] of assignment) {
    const mapped = remap.get(slot);
    if (mapped !== undefined && mapped !== slot) assignment.set(id, mapped);
  }
  return Math.max(next, 1);
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
  /**
   * The track count the layout actually resolved to. Equals the
   * requested `count` under the `'fill'` policy; may be smaller under
   * `'compact'` when empty tracks were dropped. Callers persist this as
   * the frame's `gridCount`.
   */
  effectiveCount: number;
}

// ── Column masonry ────────────────────────────────────────────────────

/**
 * N-column layout. Children stack top-to-bottom inside their column,
 * left-aligned.
 *
 * Everything is **content-driven** — there is no pinned container
 * size. Each column's width is the widest child in that column (empty
 * columns are width 0 and collapse). Gaps + padding are per-axis
 * (see {@link gapFromExtent}): the inter-column horizontal gap and X
 * padding derive from the median of child widths; the intra-column
 * vertical gap and Y padding derive from the median of child heights.
 * Per-axis derivation lets the resize gesture pass raw (sx, sy)
 * through — when only widths scale by sx, every X-axis term scales by
 * sx and the frame width matches the pointer exactly, while Y-axis
 * terms stay constant.
 *
 * Resizing the frame is handled upstream by scaling every child's
 * stored size per-axis (sx, sy); this solver then re-packs them so the
 * content-driven frame size tracks the user's drag on each axis
 * independently.
 */
export function applyColumnLayout(
  nodes: Node[],
  frameId: string,
  count: number,
  emptyTrackPolicy: 'fill' | 'compact' = 'compact',
): FrameGridLayoutResult | null {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame || frame.type !== 'frame' || isLocked(frame)) return null;

  const children = collectChildren(nodes, frameId);
  if (children.length === 0) return null;

  const cols = clampGridCount(count);
  const { assignment, count: effectiveCols } = assignTrackSlots(
    children,
    cols,
    (c) => c.node.position.y,
    emptyTrackPolicy,
  );

  // Bucket by column, sort each column by current Y.
  const colItems: ChildSlot[][] = Array.from(
    { length: effectiveCols },
    () => [],
  );
  for (const child of children) {
    const slot = assignment.get(child.node.id) ?? 0;
    colItems[slot].push(child);
  }
  for (const list of colItems) {
    list.sort((a, b) => a.node.position.y - b.node.position.y);
  }

  // Each column's width = widest child in it (0 = empty → collapses).
  const colWidth = colItems.map((items) =>
    items.length === 0 ? 0 : Math.max(...items.map((i) => i.width)),
  );

  // Per-axis padding + gap. Each axis derives its spacing from the
  // SAME-AXIS median of child extents (widths for X, heights for Y).
  // This makes the solver's frame size self-consistent under per-axis
  // resize: when every child's width is scaled by `sx`, `max(child_w)`,
  // `widthMedian`, `padX`, and `interGapX` all scale by `sx`, so the
  // resulting frame width = `oldWidth × sx` exactly. Same for height
  // with `sy`. The resize gesture's `flushScale` for structured frames
  // therefore passes the raw (sx, sy) through without collapsing to a
  // uniform scalar — single-edge drags then track the pointer pixel-
  // perfect on the dragged axis, and the orthogonal axis stays put.
  //
  // Inter-column gap (horizontal between columns) scales with widths;
  // intra-column gap (vertical between stacked items) scales with
  // heights — matching which axis each gap participates in.
  const widthMedian = median(children.map((c) => c.width));
  const heightMedian = median(children.map((c) => c.height));
  const padX = paddingFromExtent(widthMedian);
  const padY = paddingFromExtent(heightMedian);
  const interGapX = gapFromExtent(widthMedian);
  const intraGapY = gapFromExtent(heightMedian);

  // Cumulative left edge of each column.
  const colOriginX = new Array<number>(effectiveCols).fill(padX);
  for (let c = 1; c < effectiveCols; c += 1) {
    colOriginX[c] =
      colOriginX[c - 1] +
      (colWidth[c - 1] > 0 ? colWidth[c - 1] + interGapX : 0);
  }

  const positions = new Map<string, XYPosition>();
  let tallest = 0;
  for (let c = 0; c < effectiveCols; c += 1) {
    let y = padY;
    for (const item of colItems[c]) {
      positions.set(item.node.id, { x: colOriginX[c], y });
      y += item.height + intraGapY;
    }
    const bottom = colItems[c].length > 0 ? y - intraGapY : 0;
    if (bottom > tallest) tallest = bottom;
  }

  const lastCol = effectiveCols - 1;
  const contentRight =
    effectiveCols > 0 ? colOriginX[lastCol] + colWidth[lastCol] : padX;
  const width = contentRight + padX;
  const height = tallest + padY;

  return {
    childPositions: positions,
    slotAssignments: assignment,
    frameSize: { width, height },
    effectiveCount: effectiveCols,
  };
}

// ── Row masonry (mirror) ──────────────────────────────────────────────

/**
 * N-row layout. Children stack left-to-right inside their row,
 * top-aligned. Mirror of {@link applyColumnLayout} on the opposite
 * axis: content-driven row heights (tallest child per row); per-axis
 * gaps + padding (inter-row vertical gap + Y padding from height
 * median, intra-row horizontal gap + X padding from width median);
 * frame sized to fit.
 */
export function applyRowLayout(
  nodes: Node[],
  frameId: string,
  count: number,
  emptyTrackPolicy: 'fill' | 'compact' = 'compact',
): FrameGridLayoutResult | null {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame || frame.type !== 'frame' || isLocked(frame)) return null;

  const children = collectChildren(nodes, frameId);
  if (children.length === 0) return null;

  const rows = clampGridCount(count);
  const { assignment, count: effectiveRows } = assignTrackSlots(
    children,
    rows,
    (c) => c.node.position.x,
    emptyTrackPolicy,
  );

  const rowItems: ChildSlot[][] = Array.from(
    { length: effectiveRows },
    () => [],
  );
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

  // Per-axis padding + gap — mirror of `applyColumnLayout` on the
  // opposite axis. Inter-row gap (vertical between rows) scales with
  // heights; intra-row gap (horizontal between items inside a row)
  // scales with widths. See `applyColumnLayout`'s comment for the
  // self-consistency contract that lets the resize gesture pass
  // per-axis (sx, sy) through without collapsing.
  const widthMedian = median(children.map((c) => c.width));
  const heightMedian = median(children.map((c) => c.height));
  const padX = paddingFromExtent(widthMedian);
  const padY = paddingFromExtent(heightMedian);
  const interGapY = gapFromExtent(heightMedian);
  const intraGapX = gapFromExtent(widthMedian);

  const rowOriginY = new Array<number>(effectiveRows).fill(padY);
  for (let r = 1; r < effectiveRows; r += 1) {
    rowOriginY[r] =
      rowOriginY[r - 1] +
      (rowHeight[r - 1] > 0 ? rowHeight[r - 1] + interGapY : 0);
  }

  const positions = new Map<string, XYPosition>();
  let widest = 0;
  for (let r = 0; r < effectiveRows; r += 1) {
    let x = padX;
    for (const item of rowItems[r]) {
      positions.set(item.node.id, { x, y: rowOriginY[r] });
      x += item.width + intraGapX;
    }
    const right = rowItems[r].length > 0 ? x - intraGapX : 0;
    if (right > widest) widest = right;
  }

  const lastRow = effectiveRows - 1;
  const contentBottom =
    effectiveRows > 0 ? rowOriginY[lastRow] + rowHeight[lastRow] : padY;
  const width = widest + padX;
  const height = contentBottom + padY;

  return {
    childPositions: positions,
    slotAssignments: assignment,
    frameSize: { width, height },
    effectiveCount: effectiveRows,
  };
}

// ── Drag-time slot pickers ────────────────────────────────────────────

/**
 * Result of mapping a drop point inside a structured frame to a target
 * track.
 *
 *  - `into-existing` �?drop into an existing track at `slot` (range
 *    `[0, count - 1]`). Only the dragged child's `frameSlot` changes;
 *    siblings stay put.
 *  - `insert-new`    �?create a brand-new track at `slot` (range
 *    `[0, count]`; `count` means append at the end). Every existing
 *    child with `frameSlot >= slot` must be shifted by +1 by the
 *    caller, the dragged child takes `slot`, and the frame's
 *    `gridCount` becomes `count + 1`.
 *
 * Callers are free to "demote" an `insert-new` result to an
 * `into-existing` one when the gesture context disallows growing the
 * grid (e.g. a multi-drag where only one cursor point exists for
 * several children).
 */
export type StructuredDropTarget =
  | { kind: 'into-existing'; slot: number }
  | { kind: 'insert-new'; slot: number };

/**
 * Map a flow-space drop point to a column-mode drop target. The
 * geometry mirrors {@link applyColumnLayout} **exactly** — fully
 * content-driven: each column's width is the widest child in it (empty
 * columns are width 0 and collapse), and the inter-column gap +
 * X padding derive from the same median-of-child-widths the solver
 * uses.
 *
 *  - The dragged node is **not** excluded from width computation — it
 *    is visually still in its pre-drag column during the drag, and
 *    excluding it would synthesise a fake gap right where the user is
 *    releasing.
 *
 * Classification rules:
 *
 *  1. Cursor in the left padding (`x < FRAME_PADDING`) �? *     `insert-new` at slot `0` (prepend).
 *  2. Cursor in the right padding
 *     (`x > frameWidth - FRAME_PADDING`) �?`insert-new` at slot
 *     `count` (append).
 *  3. Cursor in the gap between two **non-empty** adjacent columns
 *     (`c` and `c + 1`) �?`insert-new` at slot `c + 1`. Gaps that
 *     touch an empty column are ignored (the empty side already
 *     provides an unused slot).
 *  4. Otherwise �?`into-existing` at the column whose centre is
 *     closest to the cursor. Empty columns are not candidates. If no
 *     non-empty columns exist (first-ever drop into a fresh frame),
 *     fall back to slot `0`.
 */
export function pickColumnDropTarget(
  nodes: Node[],
  frameId: string,
  framePoint: { x: number; y: number },
  count: number,
): StructuredDropTarget {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame) return { kind: 'into-existing', slot: 0 };

  const allChildren = collectChildren(nodes, frameId);
  const colItems: ChildSlot[][] = Array.from({ length: count }, () => []);
  for (const child of allChildren) {
    const raw = (child.node.data as { frameSlot?: number } | undefined)
      ?.frameSlot;
    const c =
      typeof raw === 'number' && Number.isFinite(raw)
        ? clampInt(Math.round(raw), 0, count - 1)
        : 0;
    colItems[c].push(child);
  }

  const colWidth = colItems.map((items) =>
    items.length === 0 ? 0 : Math.max(...items.map((i) => i.width)),
  );
  // Mirror applyColumnLayout's per-axis spacing so the drop-zone math
  // matches where children actually land after the solver re-packs.
  // Only the X-axis (padX + interGapX) is consulted here — this picker
  // classifies the cursor against horizontal column bands.
  const widthMedian = median(allChildren.map((c) => c.width));
  const interGapX = gapFromExtent(widthMedian);
  const padX = paddingFromExtent(widthMedian);

  // Cumulative left/right per column. Empty columns collapse — they
  // share their neighbour's coord and don't advance the cursor.
  const colLeft = new Array<number>(count).fill(padX);
  const colRight = new Array<number>(count).fill(padX);
  let cursor = padX;
  // Right edge of the last non-empty column. `cursor` advances *past*
  // the final column by one trailing `interGapX`, so it can't be used
  // directly for the content-driven width (that would over-count by one
  // gap vs. applyColumnLayout's `contentRight + padX`).
  let contentRight = padX;
  for (let c = 0; c < count; c += 1) {
    colLeft[c] = cursor;
    colRight[c] = cursor + colWidth[c];
    if (colWidth[c] > 0) {
      contentRight = cursor + colWidth[c];
      cursor += colWidth[c] + interGapX;
    }
  }

  // Prefer the actually-rendered frame width; fall back to the
  // content-driven width we just computed (mirrors applyColumnLayout:
  // contentRight + padX, with no trailing inter-column gap).
  const frameWidth =
    (frame.style as { width?: number } | undefined)?.width ??
    (frame.measured as { width?: number } | undefined)?.width ??
    contentRight + padX;

  const x = framePoint.x;

  if (x < padX) return { kind: 'insert-new', slot: 0 };
  if (x > frameWidth - padX) {
    return { kind: 'insert-new', slot: count };
  }

  for (let c = 0; c < count - 1; c += 1) {
    if (colWidth[c] === 0 || colWidth[c + 1] === 0) continue;
    // Widen the literal inter-column gap into an easier-to-hit band so a
    // new column can be opened between two columns without pixel-perfect
    // aiming, while the columns' centres stay `into-existing`.
    const gapCenter = (colRight[c] + colLeft[c + 1]) / 2;
    const half = insertBetweenHalfBand(
      interGapX,
      colWidth[c],
      colWidth[c + 1],
      INSERT_BETWEEN_MIN_HALF_COLUMN,
    );
    if (x >= gapCenter - half && x <= gapCenter + half) {
      return { kind: 'insert-new', slot: c + 1 };
    }
  }

  const candidates: number[] = [];
  for (let c = 0; c < count; c += 1) {
    if (colWidth[c] > 0) candidates.push(c);
  }
  if (candidates.length === 0) return { kind: 'into-existing', slot: 0 };
  let best = candidates[0];
  let bestDist = Math.abs(x - (colLeft[best] + colRight[best]) / 2);
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i];
    const d = Math.abs(x - (colLeft[c] + colRight[c]) / 2);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return { kind: 'into-existing', slot: best };
}

/** Mirror of {@link pickColumnDropTarget} for the row axis. */
export function pickRowDropTarget(
  nodes: Node[],
  frameId: string,
  framePoint: { x: number; y: number },
  count: number,
): StructuredDropTarget {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame) return { kind: 'into-existing', slot: 0 };

  const allChildren = collectChildren(nodes, frameId);
  const rowItems: ChildSlot[][] = Array.from({ length: count }, () => []);
  for (const child of allChildren) {
    const raw = (child.node.data as { frameSlot?: number } | undefined)
      ?.frameSlot;
    const r =
      typeof raw === 'number' && Number.isFinite(raw)
        ? clampInt(Math.round(raw), 0, count - 1)
        : 0;
    rowItems[r].push(child);
  }

  const rowHeight = rowItems.map((items) =>
    items.length === 0 ? 0 : Math.max(...items.map((i) => i.height)),
  );
  // Mirror applyRowLayout's per-axis spacing so the drop-zone math
  // matches where children actually land after the solver re-packs.
  // Only the Y-axis (padY + interGapY) is consulted here.
  const heightMedian = median(allChildren.map((c) => c.height));
  const interGapY = gapFromExtent(heightMedian);
  const padY = paddingFromExtent(heightMedian);

  const rowTop = new Array<number>(count).fill(padY);
  const rowBottom = new Array<number>(count).fill(padY);
  let cursor = padY;
  // Bottom edge of the last non-empty row. `cursor` advances *past* the
  // final row by one trailing `interGapY`, so it can't be used directly
  // for the content-driven height (that would over-count by one gap vs.
  // applyRowLayout's `contentBottom + padY`).
  let contentBottom = padY;
  for (let r = 0; r < count; r += 1) {
    rowTop[r] = cursor;
    rowBottom[r] = cursor + rowHeight[r];
    if (rowHeight[r] > 0) {
      contentBottom = cursor + rowHeight[r];
      cursor += rowHeight[r] + interGapY;
    }
  }

  const frameHeight =
    (frame.style as { height?: number } | undefined)?.height ??
    (frame.measured as { height?: number } | undefined)?.height ??
    contentBottom + padY;

  const y = framePoint.y;

  if (y < padY) return { kind: 'insert-new', slot: 0 };
  if (y > frameHeight - padY) {
    return { kind: 'insert-new', slot: count };
  }

  for (let r = 0; r < count - 1; r += 1) {
    if (rowHeight[r] === 0 || rowHeight[r + 1] === 0) continue;
    // Widen the literal inter-row gap into an easier-to-hit band so a new
    // row can be opened between two rows without pixel-perfect aiming,
    // while the rows' centres stay `into-existing`.
    const gapCenter = (rowBottom[r] + rowTop[r + 1]) / 2;
    const half = insertBetweenHalfBand(
      interGapY,
      rowHeight[r],
      rowHeight[r + 1],
      INSERT_BETWEEN_MIN_HALF_ROW,
    );
    if (y >= gapCenter - half && y <= gapCenter + half) {
      return { kind: 'insert-new', slot: r + 1 };
    }
  }

  const candidates: number[] = [];
  for (let r = 0; r < count; r += 1) {
    if (rowHeight[r] > 0) candidates.push(r);
  }
  if (candidates.length === 0) return { kind: 'into-existing', slot: 0 };
  let best = candidates[0];
  let bestDist = Math.abs(y - (rowTop[best] + rowBottom[best]) / 2);
  for (let i = 1; i < candidates.length; i += 1) {
    const r = candidates[i];
    const d = Math.abs(y - (rowTop[r] + rowBottom[r]) / 2);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return { kind: 'into-existing', slot: best };
}

// ── Drag-time drop-zone geometry (live preview) ───────────────────────

/** Fallback ghost size (flow units) when the dragged node's size is
 *  unknown (programmatic emits) and the frame has no existing tracks /
 *  items to borrow a median size from. */
const GHOST_TRACK_FALLBACK = 160;

/** Cross thickness (flow units) of the `into-existing` insertion
 *  caret's hit band. The visible caret �?a full-width line with end
 *  brackets and a centre plus �?is drawn at a fixed pixel size by the
 *  overlay; this constant only positions the band on the insertion gap
 *  so a tall / wide dragged node can never occlude its neighbours. */
const INSERT_CARET_THICKNESS = 2;

/** Frame-local rect + size of the dragged node, used to size the
 *  `insert-new` ghost block and to rank the `into-existing` insertion
 *  caret. All coordinates are frame-local (top-left). */
export interface DraggedNodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Frame-local rect describing where a live drag would land inside a
 * structured frame, so the UI can render a drop indicator.
 *
 *  - `into-existing` �?`rect` is a full-track-width **insertion caret**
 *    (a thin band the overlay decorates with end brackets + a centre
 *    plus) placed at the exact stack gap the node would slot into. A
 *    caret (rather than a node-sized footprint) is used so a tall /
 *    wide dragged node can't occlude the neighbours it lands between.
 *  - `insert-new`    �?`rect` is a **ghost block** (the dragged node's
 *    width × height) at the gap where a new track would open.
 */
export interface StructuredDropZone {
  kind: 'into-existing' | 'insert-new';
  slot: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Build the on-canvas indicator rect for a live drag hovering over a
 * structured frame. The drop **decision** is delegated to
 * {@link pickColumnDropTarget} / {@link pickRowDropTarget} �?the exact
 * same call `resolveNodeDragStop` makes on release �?so the preview can
 * never disagree with the committed drop. This helper only adds the
 * matching geometry.
 *
 * `dragged` (frame-local rect of the node under the cursor) lets the
 * preview size the `insert-new` ghost block to the actual node and
 * rank the `into-existing` insertion caret against the dragged node's
 * top edge �?exactly how the solver re-sorts the track on release.
 *
 * Returns `null` when the frame is missing. All coordinates are
 * frame-local; the caller offsets by the frame's absolute position.
 */
export function describeStructuredDropZone(
  nodes: Node[],
  frameId: string,
  framePoint: { x: number; y: number },
  axis: 'column' | 'row',
  count: number,
  dragged?: DraggedNodeRect,
): StructuredDropZone | null {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame) return null;

  const target =
    axis === 'column'
      ? pickColumnDropTarget(nodes, frameId, framePoint, count)
      : pickRowDropTarget(nodes, frameId, framePoint, count);

  const isCol = axis === 'column';
  // Axis projections: "main" = the count axis (where tracks sit),
  // "cross" = the stack axis (where items pile up inside a track).
  const mainSize = (c: ChildSlot) => (isCol ? c.width : c.height);
  const crossSize = (c: ChildSlot) => (isCol ? c.height : c.width);
  const crossTop = (c: ChildSlot) =>
    isCol ? c.node.position.y : c.node.position.x;

  const allChildren = collectChildren(nodes, frameId);

  // Bucket children by stored slot (mirrors the pickers / solvers).
  const items: ChildSlot[][] = Array.from({ length: count }, () => []);
  for (const child of allChildren) {
    const raw = (child.node.data as { frameSlot?: number } | undefined)
      ?.frameSlot;
    const s =
      typeof raw === 'number' && Number.isFinite(raw)
        ? clampInt(Math.round(raw), 0, count - 1)
        : 0;
    items[s].push(child);
  }

  // Track extent along the count axis (column width / row height).
  const extent = items.map((list) =>
    list.length === 0 ? 0 : Math.max(...list.map(mainSize)),
  );
  // Per-axis spacing — mirror of the column / row solvers. Each axis
  // derives its padding + gap from the SAME-AXIS median of child
  // extents so the drop-zone math stays self-consistent under per-axis
  // resize. `main` = the count axis (between tracks); `cross` = the
  // stack axis (within a track). For column: main=X, cross=Y; for row
  // they swap.
  const widthMedian = median(allChildren.map((c) => c.width));
  const heightMedian = median(allChildren.map((c) => c.height));
  const mainMedian = isCol ? widthMedian : heightMedian;
  const crossMedian = isCol ? heightMedian : widthMedian;
  const interGap = gapFromExtent(mainMedian);
  const mainPad = paddingFromExtent(mainMedian);
  const crossPad = paddingFromExtent(crossMedian);

  // Cumulative start / end of each track; empty tracks collapse.
  const start = new Array<number>(count).fill(mainPad);
  const end = new Array<number>(count).fill(mainPad);
  let cursor = mainPad;
  for (let s = 0; s < count; s += 1) {
    start[s] = cursor;
    end[s] = cursor + extent[s];
    if (extent[s] > 0) cursor += extent[s] + interGap;
  }
  const contentEnd = cursor > mainPad ? cursor - interGap : mainPad;

  // Indicators start one frame-padding in from the cross edge (where the
  // first item of a track sits). The `insert-new` ghost is sized to the
  // dragged node on both axes, so no frame-spanning band is needed.
  const crossStart = crossPad;

  let mainStart: number;
  let mainLen: number;
  let crossPos: number;
  let crossLen: number;

  if (target.kind === 'into-existing') {
    // Insertion CARET spanning the full target-track width, placed at
    // the exact gap the dragged node would slot into. The solver
    // re-sorts the track by the node's cross-top, so rank the gap
    // against the sibling tops. The band is kept thin (the overlay
    // draws the visible line + end brackets + centre plus at a fixed
    // pixel size) so a tall / wide dragged node can't occlude the
    // neighbours it lands between.
    mainStart = start[target.slot];
    // Span the *current* track extent (column width / row height) so the
    // caret matches the row / column it slots into, rather than the
    // dragged node's size. Fall back to the dragged size / a default only
    // when the track has no measurable extent (no laid-out items yet).
    mainLen =
      extent[target.slot] > 0
        ? extent[target.slot]
        : Math.max(
            dragged ? (isCol ? dragged.width : dragged.height) : 0,
            GHOST_TRACK_FALLBACK,
          );

    const siblings = items[target.slot]
      .filter((c) => !dragged || c.node.id !== dragged.id)
      .sort((a, b) => crossTop(a) - crossTop(b));
    // Mirror the solver's intra-track spacing exactly: it derives the
    // intra gap from the cross-axis median (heights for column, widths
    // for row), matching `applyColumnLayout`'s `intraGapY` /
    // `applyRowLayout`'s `intraGapX`.
    const intra = gapFromExtent(crossMedian);
    const ref = dragged
      ? isCol
        ? dragged.y
        : dragged.x
      : isCol
        ? framePoint.y
        : framePoint.x;

    let idx = 0;
    while (idx < siblings.length && crossTop(siblings[idx]) < ref) idx += 1;

    let gapCenter: number;
    if (siblings.length === 0) {
      gapCenter = crossStart;
    } else if (idx === 0) {
      gapCenter = Math.max(crossStart, crossTop(siblings[0]) - intra / 2);
    } else if (idx >= siblings.length) {
      const last = siblings[siblings.length - 1];
      gapCenter = crossTop(last) + crossSize(last) + intra / 2;
    } else {
      const prev = siblings[idx - 1];
      const next = siblings[idx];
      gapCenter = (crossTop(prev) + crossSize(prev) + crossTop(next)) / 2;
    }

    crossPos = gapCenter - INSERT_CARET_THICKNESS / 2;
    crossLen = INSERT_CARET_THICKNESS;
  } else {
    // Ghost block sized to the dragged node on BOTH axes (main = width,
    // cross = height for a column frame; swapped for a row), centred on
    // the gap where the new track opens. A node-sized block can never
    // overflow the frame the way a frame-spanning band could.
    const ghostMain = dragged
      ? isCol
        ? dragged.width
        : dragged.height
      : median(extent.filter((e) => e > 0)) || GHOST_TRACK_FALLBACK;
    const ghostCross = dragged
      ? isCol
        ? dragged.height
        : dragged.width
      : GHOST_TRACK_FALLBACK;
    // Gap separating the new track's ghost from the adjacent content,
    // symmetric for prepend (before slot 0) and append (after the last).
    const newTrackGap = Math.min(mainPad * 0.5, interGap || MIN_GAP);
    let center: number;
    if (target.slot <= 0) {
      // Prepend: sit the ghost just LEFT of (above, for rows) the first
      // track �?in the new space it would occupy �?instead of starting at
      // `pad`, which overlaps the existing first column. Mirrors the
      // append branch below.
      center = mainPad - newTrackGap - ghostMain / 2;
    } else if (target.slot >= count) {
      center = contentEnd + newTrackGap + ghostMain / 2;
    } else center = (end[target.slot - 1] + start[target.slot]) / 2;
    mainStart = center - ghostMain / 2;
    mainLen = ghostMain;
    crossPos = crossStart;
    crossLen = ghostCross;
  }

  return isCol
    ? {
        kind: target.kind,
        slot: target.slot,
        x: mainStart,
        y: crossPos,
        width: mainLen,
        height: crossLen,
      }
    : {
        kind: target.kind,
        slot: target.slot,
        x: crossPos,
        y: mainStart,
        width: crossLen,
        height: mainLen,
      };
}

// ── Executor integration: apply layout to nodes in-place ──────────────

/**
 * Apply structured (`column` / `row`) layout to every frame in
 * `frameIds` that opted into it via `data.layoutMode`. Free-mode frames
 * are skipped (caller's `fitFrames` handles them).
 *
 * Returns the new nodes array and the set of frame IDs that were
 * actually relaid out �?the executor uses this set to subtract from
 * its bounding-box `fitFrames` pass, since structured frames already
 * carry their own content-driven size from this pass.
 *
 * Mutations applied per handled frame:
 * - Children's `position` — `result.childPositions`
 * - Children's `data.frameSlot` — `result.slotAssignments`
 * - Frame's `data.gridCount` — `result.effectiveCount` (so a track the
 *   layout dropped is reflected in the stored count and the UI stepper)
 * - Frame's `style.width` / `style.height` / `measured` — `result.frameSize`,
 *   **only when** `getFrameSizing(frame) === 'hug'`. Manual-sized
 *   structured frames keep their user-pinned size; children still get
 *   re-packed by the solver (positions / `frameSlot`) but may overflow
 *   the frame box on the main axis (start-aligned, allowed to spill).
 *
 * `fillFrameIds` selects the empty-track policy per frame: those in the
 * set use `'fill'` (spread children to occupy every requested track �? * the count stepper's intent), everything else uses `'compact'` (drop
 * tracks that organic child changes left empty). The frame owns this
 * decision; callers (e.g. `DELETE_NODES`) only need to report the frame
 * as affected.
 *
 * Pure (returns new arrays); the input is left untouched.
 */
export function applyStructuredFrameRelayout(
  nodes: Node[],
  frameIds: Iterable<string>,
  fillFrameIds?: Iterable<string>,
): { nodes: Node[]; handledFrameIds: Set<string> } {
  const handled = new Set<string>();
  const seen = new Set<string>();
  const fillSet = fillFrameIds ? new Set(fillFrameIds) : null;

  // Compute layout for each opted-in frame against the evolving array.
  let working = nodes;

  for (const frameId of frameIds) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);

    const frame = working.find((n) => n.id === frameId);
    const cfg = readFrameGridConfig(frame);
    if (!cfg) continue;

    const policy = fillSet?.has(frameId) ? 'fill' : 'compact';
    const result =
      cfg.axis === 'column'
        ? applyColumnLayout(working, frameId, cfg.count, policy)
        : applyRowLayout(working, frameId, cfg.count, policy);
    if (!result) continue;

    handled.add(frameId);

    // PR 2: structured frames respect per-frame sizing.
    //   • `hug`    — write the solver's content-driven frame size into
    //                `style` + `measured` so the frame wraps its
    //                children (and ancestor fits cascade correctly).
    //   • `manual` — keep the user-pinned frame size untouched; only
    //                children positions / `frameSlot` and the frame's
    //                `gridCount` are written. Children may overflow on
    //                the main axis when the user pins a frame smaller
    //                than its packed content; that's the documented
    //                trade-off for unlocking `column|row + manual`.
    const sizing = getFrameSizing(frame);
    const writeFrameSize = sizing === 'hug';

    working = working.map((n) => {
      // Frame itself — for `hug`, write content-driven size into both
      // style + measured so any ancestor frame's fit pass (cascade)
      // sees the post-layout size. For `manual`, leave style/measured
      // alone (user owns the size). Always persist the effective track
      // count so a dropped (compacted) track shrinks `gridCount`.
      if (n.id === frameId) {
        const prevMeasured = (n.measured ?? {}) as {
          width?: number;
          height?: number;
        };
        const prevData = (n.data ?? {}) as Record<string, unknown>;
        const gridChanged =
          (prevData as { gridCount?: number }).gridCount !==
          result.effectiveCount;
        if (!writeFrameSize) {
          if (!gridChanged) return n;
          return {
            ...n,
            data: { ...prevData, gridCount: result.effectiveCount },
          };
        }
        return {
          ...n,
          ...(gridChanged
            ? { data: { ...prevData, gridCount: result.effectiveCount } }
            : {}),
          style: {
            ...(n.style ?? {}),
            width: result.frameSize.width,
            height: result.frameSize.height,
          },
          measured: {
            ...prevMeasured,
            width: result.frameSize.width,
            height: result.frameSize.height,
          },
        };
      }
      // Direct children �?position + slot only (sizes are content-driven
      // and owned by each child; the solver never overrides them).
      if (n.parentId !== frameId) return n;
      const nextPos = result.childPositions.get(n.id);
      const nextSlot = result.slotAssignments.get(n.id);
      const dataRec = (n.data ?? {}) as Record<string, unknown>;
      const priorSlot = (dataRec as { frameSlot?: number }).frameSlot;
      const posChanged =
        !!nextPos && (n.position.x !== nextPos.x || n.position.y !== nextPos.y);
      const slotChanged =
        typeof nextSlot === 'number' && priorSlot !== nextSlot;
      if (!posChanged && !slotChanged) return n;
      return {
        ...n,
        ...(posChanged && nextPos ? { position: nextPos } : {}),
        ...(slotChanged ? { data: { ...dataRec, frameSlot: nextSlot } } : {}),
      };
    });
  }

  return { nodes: working, handledFrameIds: handled };
}
