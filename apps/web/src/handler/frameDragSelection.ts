// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getTopLevelIds, indexById } from '@huabu/shared/canvas-engine';

import type { Node } from '@xyflow/react';

/** Movement-only roots; never writes the canonical selection. */
export function getFrameDragRoots(nodes: Node[], draggedNodes: Node[]): Node[] {
  const byId = indexById(nodes);
  const included = new Set(draggedNodes.map((node) => node.id));
  if (included.size > 1) {
    const children = new Map<string, string[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
    const visiting = new Set<string>();
    const covered = (id: string): boolean => {
      if (included.has(id)) return true;
      const node = byId.get(id);
      const childIds = children.get(id);
      if (
        node?.type !== 'frame' ||
        node.draggable === false ||
        node.data.locked ||
        !childIds?.length ||
        visiting.has(id)
      )
        return false;
      visiting.add(id);
      const complete = childIds.every(covered);
      visiting.delete(id);
      if (complete) included.add(id);
      return complete;
    };
    for (const node of nodes) covered(node.id);
  }
  const roots = new Set(getTopLevelIds(nodes, [...included]));
  return nodes.filter((node) => roots.has(node.id));
}
