// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Ignore retired Portal/Pin topology at load/import boundaries, without I/O.
 * Only exact legacy node types and edges incident to their ids are removed;
 * reference targets, unrelated dangling edges and unknown node types survive.
 * A surviving node directly parented by a removed node is detached to the root,
 * with its parent-local position rebased through the original ancestor chain.
 * Missing positions contribute zero; missing ancestors and cycles stop the walk.
 * Inputs are never mutated. Unaffected objects retain identity and array order.
 */
export function stripLegacyPortalTopology<
  N extends {
    id: string;
    type?: string;
    parentId?: string;
    position?: { x: number; y: number };
  },
  E extends { source: string; target: string },
>(nodes: readonly N[], edges: readonly E[]): { nodes: N[]; edges: E[] } {
  const isLegacy = (node: N) =>
    node.type === 'canvasRef' ||
    node.type === 'frameRef' ||
    node.type === 'nodeRef';
  const removedIds = new Set(nodes.filter(isLegacy).map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const survivingNodes = nodes
    .filter((node) => !isLegacy(node))
    .map((node) => {
      if (!node.parentId || !removedIds.has(node.parentId)) return node;

      const detached = { ...node };
      delete detached.parentId;
      // A parent-relative extent is invalid once the node becomes a root.
      if ('extent' in detached && detached.extent === 'parent') {
        delete detached.extent;
      }
      if (node.position) {
        const position = { ...node.position };
        const visited = new Set([node.id]);
        let parentId: string | undefined = node.parentId;
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          const parent = byId.get(parentId);
          if (!parent) break;
          position.x += parent.position?.x ?? 0;
          position.y += parent.position?.y ?? 0;
          parentId = parent.parentId;
        }
        detached.position = position;
      }
      return detached;
    });
  return {
    nodes: survivingNodes,
    edges: edges.filter(
      (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target),
    ),
  };
}
