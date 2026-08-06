// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'DELETE_NODES' }>;

const deleteNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length === 0) return noop(state);

    // Expand deletion set to include all descendants of deleted frames.
    const removedIds = new Set(cmd.nodeIds as string[]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of state.nodes) {
        if (n.parentId && removedIds.has(n.parentId) && !removedIds.has(n.id)) {
          removedIds.add(n.id);
          changed = true;
        }
      }
    }

    const toDelete = state.nodes.filter((n) => removedIds.has(n.id));
    if (toDelete.length === 0) return noop(state, 'not-found');

    // Collect parent frame IDs of deleted nodes so the executor can shrink them.
    const affectedFrameIds = new Set<string>();
    for (const n of toDelete) {
      if (n.parentId && !removedIds.has(n.parentId)) {
        const parent = state.nodes.find((p) => p.id === n.parentId);
        if (parent?.type === 'frame') affectedFrameIds.add(n.parentId);
      }
    }

    const nextNodes = state.nodes.filter((n) => !removedIds.has(n.id));
    const nextEdges = state.edges.filter(
      (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
    );

    return {
      applied: true,
      nodes: nextNodes,
      edges: nextEdges,
      deletedNodeIds: Array.from(removedIds),
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
    };
  },
};

export default deleteNodes;
