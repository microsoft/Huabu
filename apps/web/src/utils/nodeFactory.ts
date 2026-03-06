/**
 * Centralized node-creation defaults.
 *
 * Every call-site that builds a ReactFlow Node before calling `addNode()`
 * should use these helpers so that sizing, `data.type`, and centering
 * logic stay consistent across drag-drop, paste, click-to-place, etc.
 */

import { createId } from '@sediment/shared';

import type { NodeOrigin } from '@sediment/shared';
import type { Node } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Default dimensions per node type
// ---------------------------------------------------------------------------

export interface NodeSize {
  width: number;
  height: number;
}

const DEFAULT_SIZES: Record<string, NodeSize> = {
  note: { width: 400, height: 300 },
  web: { width: 300, height: 200 },
  pdf: { width: 400, height: 300 },
  video: { width: 400, height: 300 },
  image: { width: 300, height: 200 },
  frame: { width: 400, height: 300 },
};

/** Default image node size — safe to reference directly without null checks. */
export const IMAGE_DEFAULT_SIZE: NodeSize = DEFAULT_SIZES.image;

/**
 * Return the canonical default size for a node type.
 * Text nodes auto-size, so they deliberately have **no** default style.
 */
export function getNodeSize(nodeType: string): NodeSize | null {
  if (nodeType === 'text' || nodeType === 'note') return null; // auto-height
  return DEFAULT_SIZES[nodeType] ?? { width: 400, height: 300 };
}

/**
 * Compute the display size for an image node, scaling to a fixed width
 * while preserving the original aspect ratio.
 *
 * If natural dimensions are unknown (0 or missing), returns the default.
 */
export function computeImageSize(
  naturalWidth: number,
  naturalHeight: number,
): NodeSize {
  const defaultSize = DEFAULT_SIZES.image;
  const targetWidth = defaultSize.width;

  if (naturalWidth <= 0 || naturalHeight <= 0) return defaultSize;

  return {
    width: targetWidth,
    height: Math.round(targetWidth * (naturalHeight / naturalWidth)),
  };
}

// ---------------------------------------------------------------------------
// Centering helper
// ---------------------------------------------------------------------------

/**
 * Center a node of given size at a flow-coordinate point.
 * For text nodes (no fixed size), offsets by a small amount for visual centering.
 */
export function centeredPosition(
  pos: { x: number; y: number },
  nodeType: string,
  size: NodeSize | null,
): { x: number; y: number } {
  if (nodeType === 'text' || !size) {
    return { x: pos.x - 15, y: pos.y - 12 };
  }
  return { x: pos.x - size.width / 2, y: pos.y - size.height / 2 };
}

// ---------------------------------------------------------------------------
// Node builder
// ---------------------------------------------------------------------------

export interface BuildNodeOptions {
  /** Node type – 'note', 'text', 'web', 'image', 'pdf', 'video', 'frame' */
  type: string;
  /** Flow-coordinate position (center point – will be adjusted) */
  position: { x: number; y: number };
  /** Data payload. `type` will be injected automatically if missing. */
  data: Record<string, unknown>;
  /**
   * Optional explicit size — highest priority, skips auto-computation.
   */
  size?: NodeSize;
  /**
   * Original image dimensions (before scaling).
   * When provided for an `image` node, `computeImageSize` is called automatically.
   */
  naturalDimensions?: { width: number; height: number };
  /** Optional explicit node id. */
  id?: string;
}

/**
 * Build a ready-to-add ReactFlow Node with consistent defaults.
 *
 * Size resolution order:
 *  1. Explicit `size` option (caller override)
 *  2. Auto-computed from dimensions:
 *     - `image` + `naturalDimensions` → `computeImageSize`
 *  3. Default from `DEFAULT_SIZES`
 *  4. `null` for `text` and `note` nodes (auto-height, width-only style)
 *
 * The caller should still pass the result to `addNode()` which handles
 * auto-labeling and frame detection in `handleAddNode`.
 */
export function buildNode(opts: BuildNodeOptions): Node {
  const { type, position, data, id } = opts;

  let size: NodeSize | null;

  if (opts.size) {
    // 1. Explicit override
    size = opts.size;
  } else if (type === 'image' && opts.naturalDimensions) {
    // 2a. Image with known original dimensions
    size = computeImageSize(
      opts.naturalDimensions.width,
      opts.naturalDimensions.height,
    );
  } else {
    // 3/4. Default or null (text / note auto-height)
    size = getNodeSize(type);
  }

  const node: Node = {
    id: id ?? createId('node'),
    type,
    position: centeredPosition(position, type, size),
    data: {
      ...data,
      type,
    },
  };

  if (type === 'note') {
    // Note nodes use CSS auto-height — only set width
    node.style = { width: (size ?? DEFAULT_SIZES.note).width };
  } else if (size) {
    node.style = { width: size.width, height: size.height };
  }

  return node;
}

// ---------------------------------------------------------------------------
// Convenience: build node for a source-library item
// ---------------------------------------------------------------------------

export interface SourceNodeOptions {
  sourceId: string;
  /** The source's own type (e.g. 'web', 'pdf', 'note', 'text'). */
  sourceType: string | undefined;
  /** Drop / paste position (center). */
  position: { x: number; y: number };
  origin: NodeOrigin;
  /** All extra data fields from the source. */
  extra: Record<string, unknown>;
  /** Resolved node types from the canvas (to validate sourceType). */
  validNodeTypes: readonly string[];
}

/**
 * Build a node from a knowledge-library source drag payload.
 * Resolves the actual node type from the source's declared type and
 * ensures consistent sizing and data shape.
 */
export function buildSourceNode(opts: SourceNodeOptions): Node {
  const { sourceId, sourceType, position, origin, extra, validNodeTypes } =
    opts;

  let nodeType = 'text';
  if (typeof sourceType === 'string' && validNodeTypes.includes(sourceType)) {
    nodeType = sourceType;
  }

  const data: Record<string, unknown> = {
    ...extra,
    sourceId,
    origin,
  };

  return buildNode({ type: nodeType, position, data });
}
