// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createAbsolutePositionGetter,
  getLayoutNodeSize,
} from '@huabu/shared/canvas-engine';

import type { OrthogonalRect } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

export type RoutingScene = ReadonlyMap<
  string,
  { rect: OrthogonalRect; parentId?: string; hidden?: boolean }
>;

/** Cache only visible geometry and hierarchy, not selection or card contents. */
export function createRoutingSceneCache() {
  let previousKey = '';
  let scene: RoutingScene = new Map();
  return (nodes: Node[]): RoutingScene => {
    const resolve = createAbsolutePositionGetter(
      new Map(nodes.map((n) => [n.id, n])),
    );
    const entries = nodes
      .map(
        (node) =>
          [
            node.id,
            {
              rect: {
                ...(resolve(node.id) ?? node.position),
                ...getLayoutNodeSize(node),
              },
              parentId: node.parentId,
              hidden: node.hidden,
            },
          ] as const,
      )
      .sort((a, b) => a[0].localeCompare(b[0]));
    const key = JSON.stringify(entries);
    if (key !== previousKey) {
      scene = new Map(entries);
      previousKey = key;
    }
    return scene;
  };
}

/** Ancestor backgrounds must remain traversable for connections leaving a Frame. */
export function getRouteObstacles(
  scene: RoutingScene,
  source: string,
  target: string,
) {
  const ancestors = (id: string) => {
    const result = new Set<string>();
    let parentId = scene.get(id)?.parentId;
    while (parentId && !result.has(parentId)) {
      result.add(parentId);
      parentId = scene.get(parentId)?.parentId;
    }
    return result;
  };
  const sourceAncestors = ancestors(source);
  const targetAncestors = ancestors(target);
  return {
    obstacles: [...scene]
      .filter(
        ([id, node]) =>
          !node.hidden &&
          id !== source &&
          id !== target &&
          !sourceAncestors.has(id) &&
          !targetAncestors.has(id),
      )
      .map(([, node]) => node.rect),
    sourceRect: targetAncestors.has(source)
      ? undefined
      : scene.get(source)?.rect,
    targetRect: sourceAncestors.has(target)
      ? undefined
      : scene.get(target)?.rect,
  };
}
