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

import type { NodeSize } from '../../index.js';
import type { Node } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Default dimensions per node type
// ---------------------------------------------------------------------------
const DEFAULT_SIZES: Record<string, NodeSize> = {
  text: { width: 200 },
  // Note nodes auto-size by content height but have a minimum intrinsic
  // height of ~50px (NOTE_AUTO_HEIGHT_MIN) plus borders/padding when empty.
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
  // Question nodes auto-size to content (height-driven by text), matching
  // the behaviour of text/note nodes. The width sets the wrap width when
  // a question is created with content. Use 32px as a nominal default for
  // layout calculations (fits one line of text + padding at default zoom).
  question: { width: 200, height: 32 },
};

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

// ---------------------------------------------------------------------------
// Rendered node dimensions
// ---------------------------------------------------------------------------

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

  const width =
    (typeof measured?.width === 'number' ? measured.width : undefined) ??
    (typeof style?.width === 'number'
      ? style.width
      : typeof style?.width === 'string'
        ? Number.parseFloat(style.width)
        : undefined) ??
    0;

  const height =
    (typeof measured?.height === 'number' ? measured.height : undefined) ??
    (typeof style?.height === 'number'
      ? style.height
      : typeof style?.height === 'string'
        ? Number.parseFloat(style.height)
        : undefined) ??
    0;

  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
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
