/**
 * @file Shared node-size helpers.
 *
 * Two related concerns live here:
 *  1. `getNodeDefaultSize` — canonical default dimensions per node type
 *     (used when creating nodes before they are measured).
 *  2. `getNodeSize` / `getLayoutNodeSize` — read the rendered dimensions of
 *     an existing `Node`, with priority `measured` → `style` → fallback.
 *
 * Consumed by frameHelper (frame fitting), the frame grid layout
 * (column / row child packing), alignment (align/spread), and the
 * create-node commands.
 */

import {
  isAlwaysAutoHeightType,
  isAutoHeightByDefaultType,
} from '../height/policy.js';

import type { NodeSize } from '../../index.js';
import type { Node } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Default dimensions per node type
// ---------------------------------------------------------------------------
const DEFAULT_SIZES: Record<string, NodeSize> = {
  text: { width: 200 },
  // Note nodes auto-size by content height but have a minimum intrinsic
  // height of ~50px (the note policy's `minIntrinsicHeight`) plus borders/padding when empty.
  // Use 56px as a nominal default for layout calculations (matches the
  // minimum rendered height of an empty note at default zoom).
  note: { width: 400, height: 56 },
  web: { width: 400, height: 400 },
  pdf: { width: 400, height: 400 },
  office: { width: 400, height: 400 },
  video: { width: 400, height: 300 },
  image: { width: 400, height: 300 },
  // Compact recorder: fits the recording controls on one row.
  audio: { width: 200, height: 56 },
  frame: { width: 400, height: 300 },
  canvasRef: { width: 360, height: 240 },
  frameRef: { width: 400, height: 300 },
  nodeRef: { width: 180, height: 96 },
  // Question nodes auto-size to content (height-driven by text), matching
  // the behaviour of text/note nodes. The width sets the wrap width when
  // a question is created with content. Use 80px as a nominal default for
  // layout calculations (fits one line of text + padding at default zoom).
  question: { width: 200, height: 80 },
};

/**
 * True when top-level `style.height` should never be used as pinned geometry.
 *
 * Thin alias over the height policy table, kept because the name is used
 * across the engine and the web layer.
 */
export function isAlwaysAutoHeightNodeType(nodeType: string): boolean {
  return isAlwaysAutoHeightType(nodeType);
}
/**
 * Return the canonical default size hints for a node type.
 * These are used as layout fallbacks when creating nodes or calculating
 * initial positions before the node has been rendered and measured.
 *
 * Most nodes return both width and height. Text and note nodes *return*
 * both, but their *actual* rendered height is content-driven; the default
 * height here serves only for layout positioning (e.g. when connecting
 * new nodes). Once rendered, the measured height takes precedence.
 */
export function getNodeDefaultSize(nodeType: string): NodeSize {
  return DEFAULT_SIZES[nodeType] || { width: 300, height: 200 };
}

/**
 * Return the top-level React Flow geometry style to write when creating a node.
 *
 * `getNodeDefaultSize` may include nominal heights for content-driven nodes so
 * placement algorithms can centre and avoid-overlap before the node is mounted.
 * Those nominal heights must not become fixed `style.height` on creation,
 * because text/note/question nodes grow from their rendered content. An explicit
 * caller-provided height is still preserved for note fixed-height restores and
 * inherently fixed-size node types. Text/question resize gestures store their
 * intended scale as `data.style.fontSize`, so their top-level height remains
 * content-driven even when a caller also has an explicit geometry snapshot.
 */
export function getNodeCreationStyle(
  nodeType: string,
  size: NodeSize,
  opts: { heightIsExplicit?: boolean } = {},
): NodeSize {
  const shouldWriteHeight =
    typeof size.height === 'number' &&
    (opts.heightIsExplicit
      ? !isAlwaysAutoHeightNodeType(nodeType)
      : !isAutoHeightByDefaultType(nodeType));

  return shouldWriteHeight
    ? { width: size.width, height: size.height }
    : { width: size.width };
}

// ---------------------------------------------------------------------------
// Rendered node dimensions
// ---------------------------------------------------------------------------

/**
 * Coerce a raw dimension value into a finite number, or `undefined`.
 * Accepts a plain number or a CSS-length string (`"420px"` → `420`);
 * anything non-finite / unparseable becomes `undefined` so `??` chains
 * can fall through to the next source.
 */
function parseDimension(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Return the rendered width/height of a canvas node.
 * Returns `{ width: 0, height: 0 }` when no size information is available
 * (e.g. node not yet mounted). Callers that need a non-zero fallback for
 * layout algorithms should use `getLayoutNodeSize` instead.
 */
export function getNodeSize(node: Node): { width: number; height: number } {
  const measured = node.measured as
    | { width?: number; height?: number }
    | undefined;
  const style = node.style as
    | { width?: number | string; height?: number | string }
    | undefined;

  const width = parseDimension(measured?.width) ?? parseDimension(style?.width);
  const height =
    parseDimension(measured?.height) ?? parseDimension(style?.height);

  return {
    width: width ?? 0,
    height: height ?? 0,
  };
}

/**
 * CanvasPage-specific variant: returns `{ w, h }` with sensible non-zero defaults
 * (200 × 100) when the node has not yet been measured. Used by layout solvers
 * and alignment helpers that require a positive bounding box to compute
 * distances and avoid divide-by-zero.
 */
export function getLayoutNodeSize(node: Node): { w: number; h: number } {
  const { width, height } = getNodeSize(node);
  return {
    w: width || 200,
    h: height || 100,
  };
}

/**
 * Effective rendered size of a **sketch** node.
 *
 * Specialises {@link getNodeSize} for sketches with one extra, sketch-only
 * fallback tier: the baked `data.initialSize` (the bbox the strokes were
 * captured against), which makes sketch geometry line up on the very first
 * paint before any measurement / persisted size exists.
 *
 * Single reader for BOTH runtimes — web (live xyflow `Node`) and server
 * (persisted `CanvasNode`, which is structurally the same ReactFlow node).
 * The priority chain is a superset that each side self-selects from, so no
 * per-side conversion is needed:
 *   `style.{width,height}` → `measured` → `node.width` → `initialSize` → 0.
 * Explicit sketch geometry is authored synchronously into `style`; React
 * Flow's measured size is an asynchronous DOM echo that can lag or round by a
 * fraction of a pixel. Using that stale value while rebasing strokes would
 * bake a visible micro-shift into every existing point. Persisted CSS-length
 * strings (for example `"420px"`) are parsed here. Whichever fields a given
 * runtime does not populate are simply `undefined` and skipped.
 */
export function getSketchRenderedSize(node: Node): {
  width: number;
  height: number;
} {
  const measured = node.measured as
    | { width?: number; height?: number }
    | undefined;
  const style = node.style as
    | { width?: number | string; height?: number | string }
    | undefined;
  const data = node.data as
    | { initialSize?: { width?: number; height?: number } }
    | undefined;

  const width =
    parseDimension(style?.width) ??
    parseDimension(measured?.width) ??
    parseDimension(node.width) ??
    data?.initialSize?.width ??
    0;
  const height =
    parseDimension(style?.height) ??
    parseDimension(measured?.height) ??
    parseDimension(node.height) ??
    data?.initialSize?.height ??
    0;

  return { width, height };
}
