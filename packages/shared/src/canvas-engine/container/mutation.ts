// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { canParentNode } from './policy.js';
import {
  createAbsolutePositionGetter,
  getDescendantIds,
  indexById,
  normalizeTreeOrder,
  subPos,
  type NestableNode,
} from './tree.js';

/**
 * Parent a node under a Container while preserving its absolute position.
 */
export function moveNodeIntoContainer(
  nodes: NestableNode[],
  nodeId: string,
  containerId: string,
  options: { ignoreContainerLock?: boolean } = {},
): NestableNode[] {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  const container = byId.get(containerId);

  if (!canParentNode(container, node)) return nodes;
  if (container?.data?.locked && !options.ignoreContainerLock) return nodes;
  if (node?.parentId === containerId) return nodes;

  const descendants = new Set(getDescendantIds(nodes, nodeId));
  if (descendants.has(containerId)) return nodes;

  const getAbs = createAbsolutePositionGetter(byId);
  const nodeAbs = getAbs(nodeId);
  const containerAbs = getAbs(containerId);
  if (!nodeAbs || !containerAbs) return nodes;

  const nextNodes = nodes.map((candidate) =>
    candidate.id === nodeId
      ? {
          ...candidate,
          parentId: containerId,
          position: subPos(nodeAbs, containerAbs),
          extent: undefined,
          zIndex: -1,
        }
      : candidate,
  );
  return normalizeTreeOrder(nextNodes);
}

export function syncInheritedContainerLocks(
  nodes: NestableNode[],
  rootId: string,
): NestableNode[] {
  const byId = indexById(nodes);
  const affected = new Set([rootId, ...getDescendantIds(nodes, rootId)]);
  return nodes.map((node) => {
    if (!affected.has(node.id)) return node;
    const visited = new Set<string>([node.id]);
    let parentId = node.parentId;
    let inherited = false;
    while (parentId) {
      if (visited.has(parentId)) break;
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.data?.locked === true) {
        inherited = true;
        break;
      }
      parentId = parent.parentId;
    }
    const hasMarker = node.data?.__dragDisabledByFrameLock === true;
    if (inherited) {
      if (hasMarker && node.draggable === false) return node;
      return {
        ...node,
        draggable: false,
        data: { ...node.data, __dragDisabledByFrameLock: true },
      };
    }
    if (!hasMarker) return node;
    const { __dragDisabledByFrameLock: _marker, ...data } = node.data ?? {};
    void _marker;
    return {
      ...node,
      draggable: node.data?.locked === true ? false : true,
      data,
    };
  });
}

/**
 * Detach a node from its Container while preserving its absolute position.
 */
export function moveNodeOutOfContainer(
  nodes: NestableNode[],
  nodeId: string,
): NestableNode[] {
  const byId = indexById(nodes);
  const node = byId.get(nodeId);
  if (!node?.parentId) return nodes;

  const parent = byId.get(node.parentId);
  if (parent?.data?.locked) return nodes;

  const nodeAbs = createAbsolutePositionGetter(byId)(nodeId);
  if (!nodeAbs) return nodes;

  const nextNodes = nodes.map((candidate) => {
    if (candidate.id !== nodeId) return candidate;
    const { parentId: _parentId, zIndex: _zIndex, ...rest } = candidate;
    return {
      ...rest,
      position: nodeAbs,
      extent: undefined,
    };
  });
  return normalizeTreeOrder(nextNodes);
}
