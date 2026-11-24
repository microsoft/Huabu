// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createAbsolutePositionGetter,
  getLayoutNodeSize,
} from '@huabu/shared/canvas-engine';

import type { OrthogonalRect } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

export type RoutingSceneNode = {
  rect: OrthogonalRect;
  parentId?: string;
  hidden?: boolean;
};

export type RoutingScene = ReadonlyMap<string, RoutingSceneNode>;

/** Cache only visible geometry and hierarchy, not selection or card contents. */
export function createRoutingSceneCache() {
  let scene: RoutingScene = new Map();
  return (nodes: Node[]): RoutingScene => {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const resolve = createAbsolutePositionGetter(nodeMap);
    let unchanged = nodeMap.size === scene.size;
    const entries: Array<readonly [string, RoutingSceneNode]> = [];
    for (const [id, node] of nodeMap) {
      const pos = resolve(id) ?? node.position;
      const size = getLayoutNodeSize(node);
      const entry: RoutingSceneNode = {
        rect: { x: pos.x, y: pos.y, w: size.w, h: size.h },
        parentId: node.parentId,
        hidden: node.hidden,
      };
      entries.push([id, entry]);
      if (unchanged) {
        const prev = scene.get(id);
        if (
          !prev ||
          !Object.is(prev.rect.x, entry.rect.x) ||
          !Object.is(prev.rect.y, entry.rect.y) ||
          !Object.is(prev.rect.w, entry.rect.w) ||
          !Object.is(prev.rect.h, entry.rect.h) ||
          prev.parentId !== entry.parentId ||
          prev.hidden !== entry.hidden
        ) {
          unchanged = false;
        }
      }
    }
    if (unchanged) return scene;
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    scene = new Map(entries);
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
