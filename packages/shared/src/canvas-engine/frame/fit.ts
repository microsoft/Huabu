// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frame Fit - Frame policy over generic Container content-hug geometry.
 */

import {
  applyContainerFit,
  computeContainerFit,
  type ContainerFitResult,
  type FitContainerOptions,
} from '../container/fit.js';
import { indexById, type NestableNode } from '../container/tree.js';

import type { FrameLayoutMode } from '../../types/canvas/node.js';

export type FitFrameOptions = FitContainerOptions;
export type FrameFitResult = Omit<ContainerFitResult, 'containerId'> & {
  frameId: string;
};

export function computeFrameFit(
  nodes: NestableNode[],
  frameId: string,
  options: FitFrameOptions = {},
): FrameFitResult | null {
  const frame = nodes.find((node) => node.id === frameId);
  if (frame?.type !== 'frame' || frame.data?.locked) return null;

  const fit = computeContainerFit(nodes, frameId, options);
  if (!fit) return null;
  const { containerId: _containerId, ...geometry } = fit;
  return { frameId, ...geometry };
}

export function fitFrameToChildren(
  nodes: NestableNode[],
  frameId: string,
  options: FitFrameOptions = {},
): NestableNode[] {
  const frame = nodes.find((node) => node.id === frameId);
  if (frame?.type !== 'frame' || frame.data?.locked) return nodes;

  const layoutMode = (frame.data as { layoutMode?: FrameLayoutMode })
    ?.layoutMode;
  // Structured frames carry their own content-driven size from the
  // grid solver, so the generic bounding-box fit must not fight it.
  if (
    layoutMode === 'column' ||
    layoutMode === 'row' ||
    layoutMode === 'grid'
  ) {
    return nodes;
  }

  const fit = computeContainerFit(nodes, frameId, options);
  return fit ? applyContainerFit(nodes, fit) : nodes;
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
