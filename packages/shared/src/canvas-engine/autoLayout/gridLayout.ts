/**
 * @file Frame `column` / `row` masonry layouts and the `grid`
 * row-aligned layout.
 *
 * Three deterministic pack algorithms. The first two share one shape
 * with the axis swapped:
 *
 *   • `column` — N **columns**, each child stacks top-to-bottom inside
 *                its column, left-aligned. Drop column = column under
 *                the cursor (passed through `frameSlot`).
 *   • `row`    — N **rows**, mirror of column on the other axis
 *                (children stack left-to-right, top-aligned).
 *
 * Both masonry modes enforce a "no empty track" invariant: as long as
 * the child count ≥ N, every track has at least one item. If a track
 * would be left empty (because a stored `frameSlot` accidentally
 * collapsed all children into a subset of tracks), one neighbour is
 * pulled in. The new slot assignment is written back to
 * `data.frameSlot` so subsequent passes stay stable.
 *
 *   • `grid`   — N **columns** with persistent `(frameSlot, frameRow)`
 *                cells. Every member of a row shares one Y origin. See
 *                {@link applyGridLayout}.
 */
import { EDGE_LABEL_MAX_INVERSE_SCALE } from '../../types/canvas/edge.js';
import {
  FRAME_GRID_DEFAULT_COUNT,
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_MIN_COUNT,
} from '../../types/canvas/node.js';
import { getFrameSizing } from '../frame/sizing.js';
import { paddingFromExtent } from '../utils/constants.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { FrameLayoutMode } from '../../types/canvas/node.js';
import type { Edge, Node, XYPosition } from '@xyflow/react';

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
 * top of a (shorter) row — making a cursor in a row's upper area target
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
 * The structured layout modes, i.e. every `FrameLayoutMode` except
 * `free`. `column` and `grid` both count **columns** and both store
 * the column index in each child's `data.frameSlot`; `row` counts
 * rows. The drag-time pickers therefore treat `grid` exactly like
 * `column` — only the solver differs.
 */
export type FrameGridAxis = 'column' | 'row' | 'grid';

/**
 * Read the layout config persisted on a frame. Returns `null` for
 * non-frame nodes or frames in `free` mode (caller no-ops).
 */
export function readFrameGridConfig(
  node: Node | undefined,
): { axis: FrameGridAxis; count: number } | null {
  if (!node || node.type !== 'frame') return null;
  const data = node.data as
    | { layoutMode?: FrameLayoutMode; gridCount?: number }
    | undefined;
  const mode = data?.layoutMode;
  if (mode !== 'column' && mode !== 'row' && mode !== 'grid') return null;
  return {
    axis: mode,
    count: clampGridCount(data?.gridCount),
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

/** The axis a persisted cell index addresses. */
export type FrameAxis = 'column' | 'row';

type FrameCellData = {
  frameColumn?: number;
  frameRow?: number;
  /** @deprecated Pre-split single track index. */
  frameSlot?: number;
};

function finiteIndex(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.round(raw)
    : undefined;
}

/**
 * Read a child's index on the frame's **count axis** — the axis whose
 * track total `gridCount` sets: columns for `column` / `grid`, rows for
 * `row`.
 *
 * This is the one reader that honours the legacy `data.frameSlot`,
 * because that field only ever meant "which track on the count axis".
 * Falling back here is also what makes a `column` → `grid` switch carry
 * the column over untranslated. Nothing writes `frameSlot` any more, so
 * the fallback expires on its own as Frames relayout.
 */
export function readFrameTrack(
  node: { data?: unknown },
  axis: FrameAxis,
): number | undefined {
  const data = node.data as FrameCellData | undefined;
  const own = axis === 'column' ? data?.frameColumn : data?.frameRow;
  return finiteIndex(own) ?? finiteIndex(data?.frameSlot);
}

/**
 * Read a Grid child's row. Deliberately has **no** legacy fallback:
 * `grid` postdates `frameSlot`, so a `frameSlot` seen here always came
 * from a `column` / `row` frame and means a track on the other axis.
 * Reusing it as the row would deal every child onto the diagonal.
 */
export function readFrameGridRow(node: { data?: unknown }): number | undefined {
  return finiteIndex((node.data as FrameCellData | undefined)?.frameRow);
}

/**
 * Assign each child to a track index (0..count-1):
 *   1. Honour the stored count-axis index when present.
 *   2. Unassigned children go into the track with the fewest items
 *      (ties → first such track).
 *   3. Resolve empty tracks per `emptyTrackPolicy`:
 *      - `'fill'`    — pull the nearest item from the busiest track into
 *        each empty one (the "no empty track" invariant). Used when the
 *        caller explicitly asked for N tracks (e.g. the count stepper)
 *        and wants the children spread to fill them.
 *      - `'compact'` — drop empty tracks instead, renumbering survivors
 *        to a contiguous range. Used for organic child changes (a
 *        deletion that empties a track, a drag that vacates one): the
 *        track simply disappears rather than being back-filled.
 *
 * Returns the assignment plus the **effective** track count, which is
 * `count` for `'fill'` and ≤ `count` for `'compact'`.
 *
 * `sortKey(child)` decides the natural ordering — Y for column mode,
 * X for row mode — used both for tie-breaking and "nearest" selection.
 */
function assignTrackSlots(
  children: ChildSlot[],
  count: number,
  sortKey: (c: ChildSlot) => number,
  emptyTrackPolicy: 'fill' | 'compact',
  trackAxis: FrameAxis,
): { assignment: Map<string, number>; count: number } {
  const ordered = [...children].sort((a, b) => sortKey(a) - sortKey(b));
  const buckets: string[][] = Array.from({ length: count }, () => []);
  const assignment = new Map<string, number>();

  // Pass 1 — honour stored slots.
  const unassigned: ChildSlot[] = [];
  for (const child of ordered) {
    const raw = readFrameTrack(child.node, trackAxis);
    if (raw !== undefined) {
      const slot = clampInt(raw, 0, count - 1);
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

  // Pass 3 — resolve empty tracks (fill vs. compact).
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

/**
 * Drop empty tracks and renumber the survivors to a contiguous
 * `0..M-1` range, preserving order (so column 0 stays leftmost).
 * Rewrites `assignment` in place and returns the resulting track
 * count `M` (≥ 1 whenever there is at least one item).
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
  // No empty track in range — identity, nothing to renumber.
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
  /** Grid-only row assignments persisted as `data.frameRow`. */
  rowAssignments?: Map<string, number>;
  /**
   * Frame-local column geometry (`column` and `grid` modes), in slot
   * order. Exposed so a drag preview can draw the frame's actual track
   * structure rather than leaving the user to infer it from wherever
   * the reflowed peers happen to land.
   */
  columnTracks?: Array<{ left: number; width: number }>;
  /**
   * Frame-local row geometry, in row order. `grid` reports its stable
   * persistent rows (including currently empty ones); `row` reports its
   * masonry tracks. Absent for `column`, which has no row structure.
   */
  rowTracks?: Array<{ top: number; height: number }>;
  frameSize: { width: number; height: number };
  gutters: StructuredGutterPlan[];
  /**
   * The track count the layout actually resolved to. Equals the
   * requested `count` under the `'fill'` policy; may be smaller under
   * `'compact'` when empty tracks were dropped. Callers persist this as
   * the frame's `gridCount`.
   */
  effectiveCount: number;
}

export interface StructuredGutterLane {
  edgeId: string;
  lane: number;
  labelExtent: number;
}

export interface StructuredGutterPlan {
  axis: 'x' | 'y';
  index: number;
  baseSize: number;
  requiredSize: number;
  finalSize: number;
  lanes: StructuredGutterLane[];
}

export interface StructuredLayoutOptions {
  edges?: readonly Edge[];
  frozenGutters?: {
    x?: readonly number[];
    y?: readonly number[];
  };
}

export type StructuredGutterSizes = NonNullable<
  StructuredLayoutOptions['frozenGutters']
>;

const EDGE_GUTTER_CLEARANCE = 16;
const EDGE_LABEL_GUTTER_CLEARANCE = 32;
const EDGE_LABEL_WRAP_CAP = 120;
const EDGE_LABEL_CHAR_WIDTH = 6;
const EDGE_LABEL_HORIZONTAL_INSET = 14;
const EDGE_LABEL_LINE_HEIGHT = 14;
const EDGE_LABEL_VERTICAL_INSET = 6;

function estimateEdgeLabelExtent(label: string, axis: 'x' | 'y'): number {
  const explicitLines = label.split('\n');
  const contentCap = EDGE_LABEL_WRAP_CAP - EDGE_LABEL_HORIZONTAL_INSET;
  const maxCharsPerLine = Math.max(
    1,
    Math.floor(contentCap / EDGE_LABEL_CHAR_WIDTH),
  );
  const visualLineCount = explicitLines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / maxCharsPerLine)),
    0,
  );
  if (axis === 'y') {
    return (
      Math.min(3, visualLineCount) * EDGE_LABEL_LINE_HEIGHT +
      EDGE_LABEL_VERTICAL_INSET
    );
  }
  const longestLine = Math.max(0, ...explicitLines.map((line) => line.length));
  return Math.min(
    EDGE_LABEL_WRAP_CAP,
    longestLine * EDGE_LABEL_CHAR_WIDTH + EDGE_LABEL_HORIZONTAL_INSET,
  );
}

function planAxisGutters(
  axis: 'x' | 'y',
  count: number,
  baseSize: number,
  slotByNodeId: ReadonlyMap<string, number>,
  edges: readonly Edge[] | undefined,
  frozenSizes: readonly number[] | undefined,
): StructuredGutterPlan[] {
  const plans = Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    axis,
    index,
    baseSize,
    requiredSize: baseSize,
    finalSize: Math.max(baseSize, frozenSizes?.[index] ?? baseSize),
    lanes: [] as StructuredGutterLane[],
  }));
  if (!edges) return plans;

  for (const edge of edges) {
    const sourceSlot = slotByNodeId.get(edge.source);
    const targetSlot = slotByNodeId.get(edge.target);
    if (
      sourceSlot === undefined ||
      targetSlot === undefined ||
      sourceSlot === targetSlot
    ) {
      continue;
    }
    const label = (
      edge.data as { edgeStyle?: { label?: string } } | undefined
    )?.edgeStyle?.label?.trim();
    const labelExtent = label ? estimateEdgeLabelExtent(label, axis) : 0;
    const requiredSize = Math.max(
      24,
      labelExtent > 0
        ? (labelExtent + EDGE_LABEL_GUTTER_CLEARANCE) *
            EDGE_LABEL_MAX_INVERSE_SCALE
        : EDGE_GUTTER_CLEARANCE,
    );
    const first = Math.min(sourceSlot, targetSlot);
    const last = Math.max(sourceSlot, targetSlot);
    for (let index = first; index < last; index += 1) {
      const plan = plans[index];
      if (!plan) continue;
      plan.lanes.push({
        edgeId: edge.id,
        lane: plan.lanes.length,
        labelExtent,
      });
      plan.requiredSize = Math.max(plan.requiredSize, requiredSize);
      if (frozenSizes?.[index] === undefined) {
        plan.finalSize = Math.max(plan.baseSize, plan.requiredSize);
      }
    }
  }
  return plans;
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
  options: StructuredLayoutOptions = {},
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
    'column',
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
  const gutters = planAxisGutters(
    'x',
    effectiveCols,
    interGapX,
    assignment,
    options.edges,
    options.frozenGutters?.x,
  );

  // Cumulative left edge of each column.
  const colOriginX = new Array<number>(effectiveCols).fill(padX);
  for (let c = 1; c < effectiveCols; c += 1) {
    colOriginX[c] =
      colOriginX[c - 1] +
      (colWidth[c - 1] > 0
        ? colWidth[c - 1] + (gutters[c - 1]?.finalSize ?? interGapX)
        : 0);
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
    columnTracks: colOriginX.map((left, c) => ({
      left,
      width: colWidth[c],
    })),
    frameSize: { width, height },
    gutters,
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
  options: StructuredLayoutOptions = {},
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
    'row',
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
  const gutters = planAxisGutters(
    'y',
    effectiveRows,
    interGapY,
    assignment,
    options.edges,
    options.frozenGutters?.y,
  );

  const rowOriginY = new Array<number>(effectiveRows).fill(padY);
  for (let r = 1; r < effectiveRows; r += 1) {
    rowOriginY[r] =
      rowOriginY[r - 1] +
      (rowHeight[r - 1] > 0
        ? rowHeight[r - 1] + (gutters[r - 1]?.finalSize ?? interGapY)
        : 0);
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
    rowTracks: rowOriginY.map((top, r) => ({ top, height: rowHeight[r] })),
    frameSize: { width, height },
    gutters,
    effectiveCount: effectiveRows,
  };
}

// ── Row-aligned grid ──────────────────────────────────────────────────

/** Resolve persistent Grid rows while enforcing one child per cell. */
function assignGridRows(
  children: ChildSlot[],
  columnOf: (child: ChildSlot) => number,
): { bands: ChildSlot[][]; assignment: Map<string, number> } {
  const rowOf = (child: ChildSlot) =>
    Math.max(0, readFrameGridRow(child.node) ?? 0);
  const ordered = [...children].sort(
    (a, b) => rowOf(a) - rowOf(b) || a.node.id.localeCompare(b.node.id),
  );

  const assignment = new Map<string, number>();
  const occupied = new Set<string>();
  for (const child of ordered) {
    const column = columnOf(child);
    let row = rowOf(child);
    while (occupied.has(`${row}:${column}`)) row += 1;
    occupied.add(`${row}:${column}`);
    assignment.set(child.node.id, row);
  }

  const rowCount = Math.max(0, ...assignment.values()) + 1;
  const bands: ChildSlot[][] = Array.from({ length: rowCount }, () => []);
  for (const child of children) {
    const row = assignment.get(child.node.id) ?? 0;
    bands[row].push(child);
  }

  return { bands, assignment };
}

/**
 * N-column layout with **aligned rows**.
 *
 * Columns behave exactly like {@link applyColumnLayout} — same
 * `frameSlot` assignment, same content-driven column widths, same
 * per-axis padding / gap derivation — so the drag-time column pickers
 * and the resize gesture are reused verbatim. The difference is the Y
 * axis: instead of each column stacking independently from the top,
 * children are grouped by persistent `data.frameRow` and
 * every member of a row is placed at that row's shared origin, with
 * the row's height set by its tallest member.
 *
 * The point of the mode is **correspondence across columns**: items
 * meant to line up are placed side by side, and a column with no
 * member in a row simply leaves that cell blank rather than pulling
 * its next item up. Row membership is persistent and independent of
 * rendered geometry.
 *
 * Frame sizing stays content-driven and per-axis self-consistent:
 * scaling every child width by `sx` scales the column widths, the
 * width median, `padX` and `interGapX` alike (and likewise `sy` on the
 * height side), so a single-edge resize tracks the pointer exactly.
 */
export function applyGridLayout(
  nodes: Node[],
  frameId: string,
  count: number,
  emptyTrackPolicy: 'fill' | 'compact' = 'compact',
  options: StructuredLayoutOptions = {},
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
    'column',
  );
  const columnOf = (child: ChildSlot) => assignment.get(child.node.id) ?? 0;

  // Column widths span the whole frame (max over every band) — that is
  // what makes the vertical edges read as columns.
  const colWidth = new Array<number>(effectiveCols).fill(0);
  for (const child of children) {
    const c = columnOf(child);
    if (child.width > colWidth[c]) colWidth[c] = child.width;
  }

  // Per-axis padding + gap — identical derivation to the masonry
  // solvers so all three modes size their frame the same way.
  const widthMedian = median(children.map((c) => c.width));
  const heightMedian = median(children.map((c) => c.height));
  const padX = paddingFromExtent(widthMedian);
  const padY = paddingFromExtent(heightMedian);
  const interGapX = gapFromExtent(widthMedian);
  const interGapY = gapFromExtent(heightMedian);
  const xGutters = planAxisGutters(
    'x',
    effectiveCols,
    interGapX,
    assignment,
    options.edges,
    options.frozenGutters?.x,
  );

  const colOriginX = new Array<number>(effectiveCols).fill(padX);
  for (let c = 1; c < effectiveCols; c += 1) {
    colOriginX[c] =
      colOriginX[c - 1] +
      (colWidth[c - 1] > 0
        ? colWidth[c - 1] + (xGutters[c - 1]?.finalSize ?? interGapX)
        : 0);
  }

  const { bands, assignment: rowAssignments } = assignGridRows(
    children,
    columnOf,
  );
  const bandByNodeId = new Map<string, number>();
  for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
    for (const child of bands[bandIndex]) {
      bandByNodeId.set(child.node.id, bandIndex);
    }
  }
  const yEdges = options.edges?.filter((edge) => {
    const sourceColumn = assignment.get(edge.source);
    const targetColumn = assignment.get(edge.target);
    return sourceColumn !== undefined && sourceColumn === targetColumn;
  });
  const yGutters = planAxisGutters(
    'y',
    bands.length,
    interGapY,
    bandByNodeId,
    yEdges,
    options.frozenGutters?.y,
  );

  const positions = new Map<string, XYPosition>();
  const rowTracks: Array<{ top: number; height: number }> = [];
  let y = padY;
  for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
    const band = bands[bandIndex];
    const bandHeight =
      band.length > 0
        ? Math.max(...band.map((child) => child.height))
        : heightMedian;
    rowTracks.push({ top: y, height: bandHeight });
    for (const item of band) {
      positions.set(item.node.id, { x: colOriginX[columnOf(item)], y });
    }
    y += bandHeight + (yGutters[bandIndex]?.finalSize ?? interGapY);
  }
  // `y` overshot by one trailing inter-band gap.
  const trailingGap =
    bands.length > 0 ? (yGutters[bands.length - 1]?.finalSize ?? interGapY) : 0;
  const contentBottom = bands.length > 0 ? y - trailingGap : padY;

  const lastCol = effectiveCols - 1;
  const contentRight =
    effectiveCols > 0 ? colOriginX[lastCol] + colWidth[lastCol] : padX;

  return {
    childPositions: positions,
    slotAssignments: assignment,
    rowAssignments,
    columnTracks: colOriginX.map((left, c) => ({
      left,
      width: colWidth[c],
    })),
    rowTracks,
    frameSize: { width: contentRight + padX, height: contentBottom + padY },
    gutters: [...xGutters, ...yGutters],
    effectiveCount: effectiveCols,
  };
}

/** Resolve one structured Frame through its configured canonical solver. */
export function solveStructuredFrameLayout(
  nodes: Node[],
  frameId: string,
  emptyTrackPolicy: 'fill' | 'compact' = 'compact',
  options: StructuredLayoutOptions = {},
): FrameGridLayoutResult | null {
  const frame = nodes.find((node) => node.id === frameId);
  const config = readFrameGridConfig(frame);
  if (!config) return null;
  return config.axis === 'column'
    ? applyColumnLayout(nodes, frameId, config.count, emptyTrackPolicy, options)
    : config.axis === 'row'
      ? applyRowLayout(nodes, frameId, config.count, emptyTrackPolicy, options)
      : applyGridLayout(
          nodes,
          frameId,
          config.count,
          emptyTrackPolicy,
          options,
        );
}

/** Compute the current edge-aware gutter plan without mutating canvas data. */
export function getStructuredFrameGutterPlan(
  nodes: Node[],
  edges: readonly Edge[],
  frameId: string,
): StructuredGutterPlan[] {
  const result = solveStructuredFrameLayout(nodes, frameId, 'compact', {
    edges,
  });
  return result?.gutters ?? [];
}

// ── Drag-time slot pickers ────────────────────────────────────────────

/**
 * Result of mapping a drop point inside a structured frame to a target
 * track.
 *
 *  - `into-existing` — drop into an existing track at `slot` (range
 *    `[0, count - 1]`). Only the dragged child's `frameSlot` changes;
 *    siblings stay put.
 *  - `insert-new`    — create a brand-new track at `slot` (range
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
 * Classification rules (padding here means the per-axis `padX`
 * derived from the median of child widths — see {@link paddingFromExtent}):
 *
 *  1. Cursor in the left padding (`x < padX`) →
 *     `insert-new` at slot `0` (prepend).
 *  2. Cursor in the right padding
 *     (`x > frameWidth - padX`) → `insert-new` at slot
 *     `count` (append).
 *  3. Cursor in the gap between two **non-empty** adjacent columns
 *     (`c` and `c + 1`) → `insert-new` at slot `c + 1`. Gaps that
 *     touch an empty column are ignored (the empty side already
 *     provides an unused slot).
 *  4. Otherwise → `into-existing` at the column whose centre is
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
    const c = clampInt(readFrameTrack(child.node, 'column') ?? 0, 0, count - 1);
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
    const r = clampInt(readFrameTrack(child.node, 'row') ?? 0, 0, count - 1);
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

/** Frame-local rect + size of the dragged node. Its size is the drop
 *  footprint the preview draws; its position seeds the simulated layout
 *  the solver then re-packs. All coordinates are frame-local (top-left). */
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
 * `x` / `y` are the **solver's** projected position for the dragged
 * node under the simulated drop, and `width` / `height` are the dragged
 * node's own — so the rect is literally the footprint the node will
 * occupy on release, in every layout mode. `kind` only distinguishes
 * whether that footprint sits in an existing track or opens a new one,
 * which the overlay renders differently because a brand-new track
 * displaces no peers and so is invisible in the reflow.
 */
export interface StructuredDropZone {
  kind: 'into-existing' | 'insert-new';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Final content-driven Frame size from the simulated structured solver. */
  frameSize: { width: number; height: number };
  /**
   * Where the frame's existing children land in the simulated layout.
   * Drives the live reflow preview: the caller writes these positions
   * onto the real nodes so peers slide aside under the cursor.
   */
  reflow: StructuredReflowEntry[];
  context: StructuredDropContext;
}

/** Frame-local destination of one existing child under the simulated drop. */
export interface StructuredReflowEntry {
  id: string;
  x: number;
  y: number;
}

/**
 * Project a simulated layout onto the frame's *existing* children,
 * skipping the dragged node (React Flow owns its position mid-drag).
 */
function collectReflowPositions(
  nodes: Node[],
  frameId: string,
  draggedId: string | undefined,
  layout: FrameGridLayoutResult | null | undefined,
): StructuredReflowEntry[] {
  if (!layout) return [];
  const out: StructuredReflowEntry[] = [];
  for (const node of nodes) {
    if (node.parentId !== frameId || node.id === draggedId) continue;
    const next = layout.childPositions.get(node.id);
    if (!next) continue;
    out.push({ id: node.id, x: next.x, y: next.y });
  }
  return out;
}

export interface StructuredDropContextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Layout context rendered around the precise drop indicator: the
 * frame's track structure under the simulated drop, and which track the
 * drop lands in.
 */
export interface StructuredDropContext {
  axis: FrameGridAxis;
  /**
   * Every track of the frame under the **simulated** (post-drop)
   * layout, in slot order: columns for `column` / `grid`, rows for
   * `row`. Reflowing peers alone leaves the frame's track structure
   * implicit — a column with one short child and a column with none
   * look alike — so the overlay draws these bands to make "how many
   * tracks are there, and which one am I over" readable mid-drag.
   */
  tracks: StructuredDropContextRect[];
  /** Index into {@link tracks} the drop lands in; `-1` when unresolved. */
  activeTrack: number;
  /**
   * Grid-only row bands under the simulated layout, in row order.
   * Empty rows are included: they are real, addressable cells in
   * `grid`, so hiding them would misreport the row count.
   */
  rows: StructuredDropContextRect[];
  /** Index into {@link rows} the drop lands in; `-1` when unresolved. */
  activeRow: number;
}

/**
 * Project a solved layout's track geometry into frame-local bands for
 * the drop overlay. Bands span the solved frame size on the off-axis so
 * a column reads as a full-height stripe (and a row as a full-width
 * one) regardless of how tall its current members happen to be.
 *
 * Indices are preserved verbatim (no empty-track filtering) so they stay
 * aligned with `slotAssignments` / `rowAssignments`.
 */
function describeTrackBands(
  layout: FrameGridLayoutResult | null | undefined,
  axis: FrameGridAxis,
): { tracks: StructuredDropContextRect[]; rows: StructuredDropContextRect[] } {
  if (!layout) return { tracks: [], rows: [] };
  const { width, height } = layout.frameSize;
  const rowBands = (layout.rowTracks ?? []).map((track) => ({
    x: 0,
    y: track.top,
    width,
    height: track.height,
  }));
  if (axis === 'row') return { tracks: rowBands, rows: [] };

  const columnBands = (layout.columnTracks ?? []).map((track) => ({
    x: track.left,
    y: 0,
    width: track.width,
    height,
  }));
  return { tracks: columnBands, rows: axis === 'grid' ? rowBands : [] };
}

/** Pick a persistent Grid row from a frame-local Y coordinate. */
export function pickGridRowTarget(
  nodes: Node[],
  frameId: string,
  y: number,
  edges: readonly Edge[] = [],
): number {
  const frame = nodes.find((node) => node.id === frameId);
  const config = readFrameGridConfig(frame);
  if (!config || config.axis !== 'grid') return 0;
  const layout = applyGridLayout(nodes, frameId, config.count, 'compact', {
    edges,
  });
  if (!layout?.rowAssignments) return 0;

  const ordered = (layout.rowTracks ?? []).map(
    (track, row) =>
      [row, { top: track.top, bottom: track.top + track.height }] as const,
  );
  if (ordered.length === 0) return 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const [row, bounds] = ordered[index];
    if (y <= bounds.bottom) return row;
    const next = ordered[index + 1];
    if (next && y < (bounds.bottom + next[1].top) / 2) return row;
  }
  return ordered[ordered.length - 1][0] + 1;
}

function describeGridDropZone(
  nodes: Node[],
  frameId: string,
  count: number,
  target: StructuredDropTarget,
  pointerY: number,
  dragged: DraggedNodeRect,
  options: StructuredLayoutOptions,
): StructuredDropZone | null {
  const opensTrack =
    target.kind === 'insert-new' && count < FRAME_GRID_MAX_COUNT;
  const targetSlot = opensTrack
    ? target.slot
    : Math.min(target.slot, count - 1);
  const effectiveCount = opensTrack ? count + 1 : count;
  const targetRow = pickGridRowTarget(nodes, frameId, pointerY, options.edges);
  const source = nodes.find(
    (node) => node.id === dragged.id && node.parentId === frameId,
  );
  const columnOf = (node: Node) =>
    clampInt(readFrameTrack(node, 'column') ?? 0, 0, count - 1);
  const rowOf = (node: Node) => Math.max(0, readFrameGridRow(node) ?? 0);
  const sourceRow = source ? rowOf(source) : 0;
  const sourceSlot = source ? columnOf(source) : 0;
  const occupant = opensTrack
    ? undefined
    : nodes.find((node) => {
        if (node.id === dragged.id || node.parentId !== frameId) return false;
        return columnOf(node) === targetSlot && rowOf(node) === targetRow;
      });
  const insertsRow = !source && !!occupant;
  let foundDragged = false;

  const simulated = nodes.map((node) => {
    if (node.id === frameId && effectiveCount !== count) {
      return {
        ...node,
        data: { ...node.data, gridCount: effectiveCount },
      };
    }
    if (node.id === dragged.id) {
      foundDragged = true;
      return {
        ...node,
        parentId: frameId,
        position: { x: dragged.x, y: dragged.y },
        data: { ...node.data, frameColumn: targetSlot, frameRow: targetRow },
        style: { ...node.style, width: dragged.width, height: dragged.height },
        measured: { width: dragged.width, height: dragged.height },
      };
    }
    if (node.parentId !== frameId) return node;

    const slot = columnOf(node);
    const shiftedSlot = opensTrack && slot >= targetSlot ? slot + 1 : slot;
    const row = rowOf(node);
    const nextRow =
      source && node.id === occupant?.id
        ? sourceRow
        : insertsRow && row >= targetRow
          ? row + 1
          : row;
    const nextSlot =
      source && node.id === occupant?.id ? sourceSlot : shiftedSlot;
    return nextSlot === slot && nextRow === row
      ? node
      : {
          ...node,
          data: { ...node.data, frameColumn: nextSlot, frameRow: nextRow },
        };
  });

  if (!foundDragged) {
    simulated.push({
      id: dragged.id,
      type: 'text',
      parentId: frameId,
      position: { x: dragged.x, y: dragged.y },
      data: { frameColumn: targetSlot, frameRow: targetRow },
      style: { width: dragged.width, height: dragged.height },
      measured: { width: dragged.width, height: dragged.height },
    } as Node);
  }

  const layout = solveStructuredFrameLayout(
    simulated,
    frameId,
    'compact',
    options,
  );
  const position = layout?.childPositions.get(dragged.id);
  if (!layout || !position) return null;
  const bands = describeTrackBands(layout, 'grid');

  return {
    kind: opensTrack ? 'insert-new' : 'into-existing',
    x: position.x,
    y: position.y,
    width: dragged.width,
    height: dragged.height,
    frameSize: layout.frameSize,
    reflow: collectReflowPositions(nodes, frameId, dragged.id, layout),
    context: {
      axis: 'grid',
      tracks: bands.tracks,
      activeTrack: layout.slotAssignments.get(dragged.id) ?? targetSlot,
      rows: bands.rows,
      activeRow: layout.rowAssignments?.get(dragged.id) ?? targetRow,
    },
  };
}

/**
 * Build the on-canvas indicator rect for a live drag hovering over a
 * structured frame. The drop **decision** is delegated to
 * {@link pickColumnDropTarget} / {@link pickRowDropTarget} — the exact
 * same call `resolveNodeDragStop` makes on release — so the preview can
 * never disagree with the committed drop. This helper only adds the
 * matching geometry.
 *
 * Every mode reports the **same** rect: the position the simulated
 * solver assigns the dragged node, at the dragged node's own size. The
 * masonry modes used to substitute a hand-computed insertion caret,
 * which meant re-deriving the solver's intra-track spacing beside the
 * solver — two implementations of one layout, free to drift, and a
 * weaker answer than the footprint the grid mode was already able to
 * show. Simulating once and reading the position back removes both
 * problems.
 *
 * `dragged` is the frame-local rect of the node under the cursor.
 * Without it there is no footprint to project and no drop to preview,
 * so the helper reports `null` rather than inventing a placeholder.
 *
 * Returns `null` when the frame is missing or the simulated layout does
 * not place the dragged node. All coordinates are frame-local; the
 * caller offsets by the frame's absolute position.
 */
export function describeStructuredDropZone(
  nodes: Node[],
  frameId: string,
  framePoint: { x: number; y: number },
  axis: FrameGridAxis,
  count: number,
  dragged?: DraggedNodeRect,
  options: StructuredLayoutOptions = {},
): StructuredDropZone | null {
  const frame = nodes.find((n) => n.id === frameId);
  if (!frame || !dragged) return null;

  const isCol = axis !== 'row';
  const target = isCol
    ? pickColumnDropTarget(nodes, frameId, framePoint, count)
    : pickRowDropTarget(nodes, frameId, framePoint, count);

  if (axis === 'grid') {
    return describeGridDropZone(
      nodes,
      frameId,
      count,
      target,
      framePoint.y,
      dragged,
      options,
    );
  }

  // Masonry modes own exactly one axis, and it is the one the mode is
  // named after, so the cell field follows directly from `axis`.
  const trackAxis: FrameAxis = isCol ? 'column' : 'row';
  const trackField = isCol ? 'frameColumn' : 'frameRow';

  let foundDragged = false;
  const effectiveCount =
    target.kind === 'insert-new' && count < FRAME_GRID_MAX_COUNT
      ? count + 1
      : count;
  const targetSlot =
    target.kind === 'insert-new'
      ? target.slot
      : Math.min(target.slot, count - 1);
  const simulated = nodes.map((node) => {
    if (node.id === frameId && effectiveCount !== count) {
      return {
        ...node,
        data: { ...node.data, gridCount: effectiveCount },
      };
    }
    if (node.id === dragged.id) {
      foundDragged = true;
      return {
        ...node,
        parentId: frameId,
        position: { x: dragged.x, y: dragged.y },
        data: { ...node.data, [trackField]: targetSlot },
        style: { ...node.style, width: dragged.width, height: dragged.height },
        measured: { width: dragged.width, height: dragged.height },
      };
    }
    if (target.kind !== 'insert-new' || node.parentId !== frameId) {
      return node;
    }
    const slot = clampInt(readFrameTrack(node, trackAxis) ?? 0, 0, count - 1);
    return slot < targetSlot
      ? node
      : { ...node, data: { ...node.data, [trackField]: slot + 1 } };
  });
  if (!foundDragged) {
    simulated.push({
      id: dragged.id,
      type: 'text',
      parentId: frameId,
      position: { x: dragged.x, y: dragged.y },
      data: { [trackField]: targetSlot },
      style: { width: dragged.width, height: dragged.height },
      measured: { width: dragged.width, height: dragged.height },
    } as Node);
  }
  const simulatedLayout = solveStructuredFrameLayout(
    simulated,
    frameId,
    'compact',
    options,
  );
  const position = simulatedLayout?.childPositions.get(dragged.id);
  if (!simulatedLayout || !position) return null;

  const bands = describeTrackBands(simulatedLayout, axis);

  return {
    kind: target.kind,
    x: position.x,
    y: position.y,
    width: dragged.width,
    height: dragged.height,
    frameSize: simulatedLayout.frameSize,
    reflow: collectReflowPositions(nodes, frameId, dragged.id, simulatedLayout),
    context: {
      axis,
      tracks: bands.tracks,
      activeTrack:
        simulatedLayout.slotAssignments.get(dragged.id) ?? targetSlot,
      rows: bands.rows,
      activeRow: -1,
    },
  };
}

// ── Executor integration: apply layout to nodes in-place ──────────────

/**
 * Apply structured (`column` / `row` / `grid`) layout to every frame in
 * `frameIds` that opted into it via `data.layoutMode`. Free-mode frames
 * are skipped (caller's `fitFrames` handles them).
 *
 * Returns the new nodes array and the set of frame IDs that were
 * actually relaid out — the executor uses this set to subtract from
 * its bounding-box `fitFrames` pass, since structured frames already
 * carry their own content-driven size from this pass.
 *
 * Mutations applied per handled frame:
 * - Children's `position` — `result.childPositions`
 * - Children's `data.frameSlot` — `result.slotAssignments`
 * - Grid children's `data.frameRow` — `result.rowAssignments`
 * - Frame's `data.gridCount` — `result.effectiveCount` (so a track the
 *   layout dropped is reflected in the stored count and the UI stepper)
 * - Frame's `style.width` / `style.height` / `measured` — `result.frameSize`,
 *   **only when** `getFrameSizing(frame) === 'hug'`. Manual-sized
 *   structured frames keep their user-pinned size; children still get
 *   re-packed by the solver (positions / `frameSlot`) but may overflow
 *   the frame box on the main axis (start-aligned, allowed to spill).
 *
 * `fillFrameIds` selects the empty-track policy per frame: those in the
 * set use `'fill'` (spread children to occupy every requested track — * the count stepper's intent), everything else uses `'compact'` (drop
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
  options: {
    edges?: readonly Edge[];
    frozenGuttersByFrame?: ReadonlyMap<string, StructuredGutterSizes>;
  } = {},
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
    const layoutOptions: StructuredLayoutOptions = {
      edges: options.edges,
      frozenGutters: options.frozenGuttersByFrame?.get(frameId),
    };
    const result = solveStructuredFrameLayout(
      working,
      frameId,
      policy,
      layoutOptions,
    );
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
      // Direct children — position + cell only (sizes are content-driven
      // and owned by each child; the solver never overrides them).
      if (n.parentId !== frameId) return n;
      const trackAxis: FrameAxis = cfg.axis === 'row' ? 'row' : 'column';
      const trackField = cfg.axis === 'row' ? 'frameRow' : 'frameColumn';
      const nextPos = result.childPositions.get(n.id);
      const nextSlot = result.slotAssignments.get(n.id);
      const nextRow = result.rowAssignments?.get(n.id);
      const dataRec = (n.data ?? {}) as Record<string, unknown>;
      const priorSlot = readFrameTrack(n, trackAxis);
      const priorRow = readFrameGridRow(n);
      // The pre-split `frameSlot` is read-only: seeing one means this
      // child predates the axis split, so the relayout takes the chance
      // to rewrite it as the axis-named field. Tracked separately from
      // `slotChanged` because the value itself is usually unchanged —
      // it is the *field* that moves.
      const shedsLegacy = 'frameSlot' in dataRec;
      const posChanged =
        !!nextPos && (n.position.x !== nextPos.x || n.position.y !== nextPos.y);
      const slotChanged =
        typeof nextSlot === 'number' && priorSlot !== nextSlot;
      const rowChanged = typeof nextRow === 'number' && priorRow !== nextRow;
      if (!posChanged && !slotChanged && !rowChanged && !shedsLegacy) return n;
      const dataChanged = slotChanged || rowChanged || shedsLegacy;
      let nextData: Record<string, unknown> | undefined;
      if (dataChanged) {
        nextData = { ...dataRec };
        delete nextData.frameSlot;
        if (typeof nextSlot === 'number') nextData[trackField] = nextSlot;
        if (typeof nextRow === 'number') nextData.frameRow = nextRow;
      }
      return {
        ...n,
        ...(posChanged && nextPos ? { position: nextPos } : {}),
        ...(nextData ? { data: nextData } : {}),
      };
    });
  }

  return { nodes: working, handledFrameIds: handled };
}
