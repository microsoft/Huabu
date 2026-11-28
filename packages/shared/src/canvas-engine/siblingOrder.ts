// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isContainerNode } from './container/policy.js';
import { indexById } from './container/tree.js';

import type { CanvasNode } from './interfaces.js';

export function sameSiblingOrder(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export type SiblingReorderTarget =
  | 'top'
  | 'bottom'
  | { before: string }
  | { after: string };

export type SiblingReorderAdmission =
  | { valid: true; parentId: string | null; before: string[]; after: string[] }
  | { valid: false; reason: 'invalid-target' | 'invalid-parent' };

export function hasUnlockedAncestry(
  byId: ReadonlyMap<string, CanvasNode>,
  nodeId: string,
): boolean {
  let node = byId.get(nodeId);
  const visited = new Set<string>();
  while (node) {
    if (visited.has(node.id) || node.data.locked) return false;
    visited.add(node.id);
    if (node.parentId === undefined || node.parentId === null) return true;
    node = byId.get(node.parentId);
    if (!isContainerNode(node)) return false;
  }
  return false;
}

/** Live-state admission; lifetime/ABA and writer-version guards belong to the server. */
export function admitSiblingReorder(
  nodes: CanvasNode[],
  nodeIds: readonly string[],
  to: SiblingReorderTarget,
): SiblingReorderAdmission {
  const byId = indexById(nodes);
  const moving = new Set(nodeIds);
  if (
    moving.size === 0 ||
    moving.size !== nodeIds.length ||
    nodeIds.some((id) => !byId.has(id))
  ) {
    return { valid: false, reason: 'invalid-target' };
  }
  const first = byId.get(nodeIds[0]);
  if (!first) return { valid: false, reason: 'invalid-target' };
  const parentId = first.parentId ?? null;
  if (
    nodeIds.some((id) => {
      const node = byId.get(id);
      return (
        !node ||
        (node.parentId ?? null) !== parentId ||
        !hasUnlockedAncestry(byId, id)
      );
    })
  ) {
    return { valid: false, reason: 'invalid-parent' };
  }
  const before = nodes
    .filter((node) => (node.parentId ?? null) === parentId)
    .map((node) => node.id);
  const group = before.filter((id) => moving.has(id));
  const rest = before.filter((id) => !moving.has(id));
  let index = to === 'bottom' ? 0 : rest.length;
  if (typeof to === 'object') {
    const anchorId = 'before' in to ? to.before : to.after;
    index = rest.indexOf(anchorId);
    if (index === -1) return { valid: false, reason: 'invalid-target' };
    if ('after' in to) index++;
  }
  const after = [...rest.slice(0, index), ...group, ...rest.slice(index)];
  return { valid: true, parentId, before, after };
}
