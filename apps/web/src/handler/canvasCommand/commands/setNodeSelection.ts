import type { CommandDefinition } from './types';
import type { CanvasCommand } from '@sediment/shared';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_SELECTION' }>;

const setNodeSelection: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'no',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    const selectedIds = new Set(cmd.nodeIds as string[]);
    const nextNodes = state.nodes.map((n) => ({
      ...n,
      selected: selectedIds.has(n.id),
    }));

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
    };
  },
};

export default setNodeSelection;
