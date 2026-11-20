// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { withMasonryLayoutOrder } from '../autoLayout/gridLayout.js';
import { settlePaintOrder } from '../container/paintOrder.js';
import { getTopLevelIds, indexById } from '../container/tree.js';
import { materializeForestOrder } from '../container/zorder.js';
import { admitSiblingReorder, sameSiblingOrder } from '../siblingOrder.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'REORDER_NODES' }>;

const reorderNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length === 0) return noop(state);

    const byId = indexById(state.nodes);
    if (
      new Set(cmd.nodeIds).size !== cmd.nodeIds.length ||
      cmd.nodeIds.some((id) => !byId.has(id))
    ) {
      return noop(state, 'invalid-target');
    }
    // Legacy Layers callers expand Frame subtrees. Only their roots move;
    // new-protocol admission calls admitSiblingReorder on the original IDs.
    const roots = getTopLevelIds(state.nodes, cmd.nodeIds);
    const admission = admitSiblingReorder(state.nodes, roots, cmd.to);
    if (!admission.valid) return noop(state, admission.reason);
    if (sameSiblingOrder(admission.before, admission.after)) return noop(state);
    const seeded = admission.parentId
      ? withMasonryLayoutOrder(
          state.nodes,
          admission.parentId,
          undefined,
          state.edges,
        )
      : state.nodes;
    const seededById = indexById(seeded);
    const moving = new Set(roots);
    let index = 0;
    // Put the moved nodes where they go and take their keys away: settling
    // then keys exactly them, between the siblings they now stand between.
    const reordered = seeded.map((node) => {
      if ((node.parentId ?? null) !== admission.parentId) return node;
      const sibling = seededById.get(admission.after[index++]);
      if (!sibling) throw new Error('Admitted sibling disappeared');
      if (!moving.has(sibling.id) || !('paintKey' in sibling.data))
        return sibling;
      const { paintKey: _paintKey, ...data } = sibling.data;
      return { ...sibling, data };
    });
    return {
      applied: true,
      nodes: materializeForestOrder(settlePaintOrder(reordered)),
      edges: state.edges,
      mutatedNodes: seeded.filter((node, i) => node !== state.nodes[i]),
    };
  },
};

export default reorderNodes;
