import type { CommandDefinition } from './types.js';
import type { CanvasCommand } from '../../index.js';

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
    const nextEdges = state.edges.map((edge) => ({
      ...edge,
      selected: false,
    }));

    return {
      applied: true,
      nodes: nextNodes,
      edges: nextEdges,
    };
  },
};

export default setNodeSelection;
