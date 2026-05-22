/**
 * Frame Fit - Auto-resize frames to wrap their children
 *
 * Read-only computation (`computeFrameFit`) plus the apply variants
 * (`fitFrameToChildren`, `fitFrames`). All functions return new arrays
 * and preserve children's visual (absolute) positions on the canvas.
 *
 * `fitFrames` performs a deepest-first cascade so refitting an inner
 * frame also refits any ancestors whose interior bounds changed.
 */

import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from './tree.js';
import { FRAME_PADDING } from '../utils/constants.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { XYPosition } from '@xyflow/react';

export type FitFrameOptions = {
  /** Padding around the bounding box of children. Default: FRAME_PADDING (48). */
  padding?: number;
  /** Minimum frame width. Default: 240. */
  minWidth?: number;
  /** Minimum frame height. Default: 160. */
  minHeight?: number;
  /** Children to exclude from the bounding-box calculation (e.g. nodes about to leave). */
  excludeNodeIds?: ReadonlySet<string>;
  /**
   * Extra rects in absolute canvas coordinates to include in the bounding box.
   * Used by the drag-preview system to show how the frame would look if a
   * currently-dragged node (not yet a child) were dropped at its current position.
   */
  includeAbsoluteRects?: ReadonlyArray<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

/**
 * Computed fit result describing the ideal position and size for a frame
 * to tightly wrap its children. Used both by `fitFrameToChildren` (which
 * applies the result) and by the drag-preview system (which only reads it).
 */
export type FrameFitResult = {
  frameId: string;
  /** Position of the frame (absolute when used as preview overlay). */
  position: XYPosition;
  /** New width and height. */
  width: number;
  height: number;
};

/**
 * Compute the ideal frame position and size to tightly wrap all its direct
 * children, without mutating any nodes. Returns `null` if the frame has no
 * children or does not exist.
 *
 * This is a pure read-only function — use `fitFrameToChildren` to apply the
 * result to a nodes array.
 */
export function computeFrameFit(
  nodes: NestableNode[],
  frameId: string,
  options: FitFrameOptions = {},
): FrameFitResult | null {
  const byId = indexById(nodes);
  const frame = byId.get(frameId);
  if (!frame) return null;
  if (frame.type !== 'frame') return null;
  if (frame.data?.locked) return null;

  const padding = options.padding ?? FRAME_PADDING;
  const minWidth = options.minWidth ?? 20;
  const minHeight = options.minHeight ?? 20;

  // Collect direct children (optionally excluding specific nodes)
  const excludeIds = options.excludeNodeIds;
  const children = nodes.filter(
    (n) => n.parentId === frameId && (!excludeIds || !excludeIds.has(n.id)),
  );
  const hasExtraRects = (options.includeAbsoluteRects?.length ?? 0) > 0;
  if (children.length === 0 && !hasExtraRects) return null;

  // Build bounding box from children's relative positions
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const child of children) {
    const size = getNodeSize(child);
    minX = Math.min(minX, child.position.x);
    minY = Math.min(minY, child.position.y);
    maxX = Math.max(maxX, child.position.x + size.width);
    maxY = Math.max(maxY, child.position.y + size.height);
  }

  // Include extra absolute rects (nodes about to enter the frame).
  // Convert from absolute canvas coords to frame-relative coords.
  if (hasExtraRects) {
    const getAbs = createAbsolutePositionGetter(byId);
    const frameAbsPos = getAbs(frameId);
    if (frameAbsPos) {
      for (const rect of options.includeAbsoluteRects ?? []) {
        const relX = rect.x - frameAbsPos.x;
        const relY = rect.y - frameAbsPos.y;
        minX = Math.min(minX, relX);
        minY = Math.min(minY, relY);
        maxX = Math.max(maxX, relX + rect.width);
        maxY = Math.max(maxY, relY + rect.height);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  // The children's relative positions are relative to the frame's position.
  // If a child is at negative relative coords, the frame needs to shift left/up.
  const deltaX = minX - padding;
  const deltaY = minY - padding;

  const width = Math.max(minWidth, maxX - minX + padding * 2);
  const height = Math.max(minHeight, maxY - minY + padding * 2);

  // Compute new frame position in the same coordinate space as the current frame.
  const newPosition: XYPosition = {
    x: frame.position.x + deltaX,
    y: frame.position.y + deltaY,
  };

  return { frameId, position: newPosition, width, height };
}

/**
 * Resize a frame to tightly fit all its direct children, preserving the
 * visual (absolute) positions of all children on the canvas.
 *
 * Returns the original nodes array unchanged if:
 * - The frame doesn't exist or is not a frame type
 * - The frame is locked
 * - The frame has no children
 */
export function fitFrameToChildren(
  nodes: NestableNode[],
  frameId: string,
  options: FitFrameOptions = {},
): NestableNode[] {
  const fit = computeFrameFit(nodes, frameId, options);
  if (!fit) return nodes;

  const frame = nodes.find((n) => n.id === frameId);
  if (!frame) return nodes;

  // Compute the delta between old and new frame origins so we can offset
  // children to keep them visually stationary.
  const deltaX = fit.position.x - frame.position.x;
  const deltaY = fit.position.y - frame.position.y;

  // No-op short-circuit: when the computed fit matches the frame's
  // current geometry exactly AND there is no origin shift to apply to
  // children, return the input array reference. This preserves
  // reference-equality so callers (e.g. `scheduleDeferredFrameFit`'s
  // `next !== current` guard) can skip a needless `set({ nodes })`
  // and the rerender it triggers.
  const currentWidth = frame.style?.width;
  const currentHeight = frame.style?.height;
  if (
    deltaX === 0 &&
    deltaY === 0 &&
    currentWidth === fit.width &&
    currentHeight === fit.height
  ) {
    return nodes;
  }

  return nodes.map((n) => {
    if (n.id === frameId) {
      // Mirror the new size into `measured` so the immediately-following
      // pass for this frame's *parent* (see `fitFrames` cascade) sees the
      // post-fit dimensions. Without this, `getNodeSize` would return the
      // stale `measured` value (it takes precedence over `style`) and the
      // outer frame would compute its bounding box against the inner
      // frame's previous size — defeating the cascade. ReactFlow's
      // ResizeObserver writes the same number back on the next frame, so
      // there's no jitter from doing this eagerly here.
      const prevMeasured = (n.measured ?? {}) as {
        width?: number;
        height?: number;
      };
      return {
        ...n,
        position: fit.position,
        style: {
          ...(n.style ?? {}),
          width: fit.width,
          height: fit.height,
        },
        measured: {
          ...prevMeasured,
          width: fit.width,
          height: fit.height,
        },
      };
    }

    // Offset direct children to compensate for frame origin shift
    if (n.parentId === frameId) {
      return {
        ...n,
        position: {
          x: n.position.x - deltaX,
          y: n.position.y - deltaY,
        },
      };
    }

    return n;
  });
}

/**
 * Apply `fitFrameToChildren` to multiple frames in a single pass.
 *
 * Cascades to ancestor frames: if frame B is nested inside frame A and
 * B's size changes, A is also refit (bottom-up) so the outer frame
 * doesn't keep an outdated hole sized to B's previous bounds. The
 * no-op short-circuit in `fitFrameToChildren` makes already-fitting
 * ancestors a zero-cost walk, so the cascade only does work where it
 * matters.
 */
export function fitFrames(
  nodes: NestableNode[],
  frameIds: Iterable<string>,
  options: FitFrameOptions = {},
): NestableNode[] {
  const byId = indexById(nodes);

  // Expand the input set with each frame's ancestor chain.
  const targets = new Set<string>();
  for (const id of frameIds) {
    let cursor: string | undefined = id;
    while (cursor && !targets.has(cursor)) {
      const node = byId.get(cursor);
      if (!node) break;
      targets.add(cursor);
      cursor = node.parentId;
    }
  }

  // Sort deepest-first (true tree depth) so each parent observes the
  // freshly-fitted size of its child in the same pass. Caller-supplied
  // ids may include both an inner frame and its outer frame, so the
  // ad-hoc "hops from seed" metric isn't reliable — compute real depth.
  // The hop cap defends against malformed parentId cycles (normally
  // pre-stripped by `normalizeTreeOrder`, but cheap insurance here).
  // Memoize so the sort comparator doesn't re-walk the parent chain
  // O(n log n) times.
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const visited = new Set<string>();
    let depth = 0;
    let cursor: string | undefined = byId.get(id)?.parentId;
    while (cursor && !visited.has(cursor)) {
      const cachedAncestor = depthCache.get(cursor);
      if (cachedAncestor !== undefined) {
        depth += cachedAncestor + 1;
        break;
      }
      visited.add(cursor);
      depth += 1;
      cursor = byId.get(cursor)?.parentId;
    }
    depthCache.set(id, depth);
    return depth;
  };

  const ordered = [...targets].sort((a, b) => depthOf(b) - depthOf(a));

  let result = nodes;
  for (const id of ordered) {
    result = fitFrameToChildren(result, id, options);
  }
  return result;
}
