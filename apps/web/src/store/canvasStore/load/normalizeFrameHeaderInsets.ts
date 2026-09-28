// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  resolveFrameResponsiveLayout,
  getFrameSizing,
  getNodeSize,
} from '@huabu/shared/canvas-engine';

import type { Node } from '@xyflow/react';

/**
 * Expands legacy Hug Frame shells upward when their persisted geometry lacks
 * the responsive title region. Child absolute positions and the Frame's
 * bottom edge remain unchanged; Manual and locked Frames retain authored
 * geometry.
 */
export function normalizeFrameHeaderInsets(nodes: Node[]): Node[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const depthOf = (node: Node): number => {
    const cached = depths.get(node.id);
    if (cached !== undefined) return cached;
    let depth = 0;
    let parentId = node.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    depths.set(node.id, depth);
    return depth;
  };

  const frameIds = nodes
    .filter(
      (node) =>
        node.type === 'frame' &&
        !node.data?.locked &&
        getFrameSizing(node) === 'hug',
    )
    .sort((left, right) => depthOf(right) - depthOf(left))
    .map((node) => node.id);

  let working = nodes;
  for (const frameId of frameIds) {
    const frame = working.find((node) => node.id === frameId);
    if (!frame) continue;
    const children = working.filter((node) => node.parentId === frameId);
    if (children.length === 0) continue;
    const currentTopInset = Math.min(
      ...children.map((child) => child.position.y),
    );
    const frameSize = getNodeSize(frame);
    const { delta } = resolveFrameResponsiveLayout((metrics) => {
      const delta = Math.max(0, metrics.headerInset - currentTopInset);
      return {
        delta,
        frameSize: { width: frameSize.width, height: frameSize.height + delta },
      };
    });
    if (delta === 0) continue;
    const currentHeight = frameSize.height;
    working = working.map((node) => {
      if (node.id === frameId) {
        return {
          ...node,
          position: { ...node.position, y: node.position.y - delta },
          style: {
            ...(node.style ?? {}),
            height: currentHeight + delta,
          },
          measured: {
            ...(node.measured ?? {}),
            height: currentHeight + delta,
          },
        };
      }
      if (node.parentId !== frameId) return node;
      return {
        ...node,
        position: { ...node.position, y: node.position.y + delta },
      };
    });
  }

  return working;
}
