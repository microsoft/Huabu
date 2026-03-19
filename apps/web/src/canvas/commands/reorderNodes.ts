import { noop, type CommandDefinition } from './types';
import { normalizeTreeOrder, type NestableNode } from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'REORDER_NODES' }>;

const reorderNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length === 0) return noop(state);

    const moveSet = new Set(cmd.nodeIds as string[]);
    const moving = state.nodes.filter((n) => moveSet.has(n.id));
    if (moving.length === 0) return noop(state, 'not-found');

    const rest = state.nodes.filter((n) => !moveSet.has(n.id));

    let reordered: Node[];
    if (cmd.to === 'top') {
      reordered = [...rest, ...moving];
    } else if (cmd.to === 'bottom') {
      reordered = [...moving, ...rest];
    } else {
      // { before: CanvasNodeId } �?insert moving nodes before the target.
      const targetId = cmd.to.before as string;
      const targetIndex = rest.findIndex((n) => n.id === targetId);
      if (targetIndex === -1) {
        reordered = [...rest, ...moving];
      } else {
        reordered = [
          ...rest.slice(0, targetIndex),
          ...moving,
          ...rest.slice(targetIndex),
        ];
      }
    }

    reordered = normalizeTreeOrder(reordered as NestableNode[]);

    return {
      applied: true,
      nodes: reordered,
      edges: state.edges,
    };
  },
};

export default reorderNodes;
