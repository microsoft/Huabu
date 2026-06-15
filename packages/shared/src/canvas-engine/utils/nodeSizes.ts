/**
 * @file Shared node-size helpers.
 *
 * Two related concerns live here:
 *  1. `getNodeDefaultSize` — canonical default dimensions per node type
 *     (used when creating nodes before they are measured).
 *  2. `getNodeSize` / `getLayoutNodeSize` — read the rendered dimensions of
 *     an existing `Node`, with priority `measured` → `style` → fallback.
 *
 * Consumed by frameHelper (frame fitting), layout/graphModel (Cola/fCoSE),
 * alignment (align/spread), and the create-node commands.
 */

import type { NodeSize } from '../../index.js';
import type { Node } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Default dimensions per node type
// ---------------------------------------------------------------------------
const DEFAULT_SIZES: Record<string, NodeSize> = {
  text: { width: 200 },
  note: { width: 400 },
  web: { width: 400, height: 400 },
  pdf: { width: 400, height: 400 },
  video: { width: 400, height: 300 },
  image: { width: 400, height: 300 },
  // Compact recorder: fits the recording controls on one row.
  audio: { width: 200, height: 56 },
  frame: { width: 400, height: 300 },
  // Question nodes auto-size to content (height-driven by text), matching
  // the behaviour of text/note nodes. The width sets the wrap width when
  // a question is created with content; empty questions shrink to one line.
  question: { width: 200 },
};

/**
 * Return the canonical default size hints for a node type.
 * Text and note nodes expose only a default width because their height is
 * content-driven at render time.
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
