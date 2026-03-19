import { createId, type CanvasCommand } from '@sediment/shared';
import { addEdge } from '@xyflow/react';

import { noop, type CommandDefinition } from './types';

type Cmd = Extract<CanvasCommand, { type: 'CONNECT_NODES' }>;

const connectNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.edges.length === 0) return noop(state);

    let nextEdges = state.edges;

    for (const edgeInput of cmd.edges) {
      const source = edgeInput.source as string;
      const target = edgeInput.target as string;
      const id = (edgeInput.id as string | undefined) ?? createId('edge');
      nextEdges = addEdge({ id, source, target }, nextEdges);
    }

    return {
      applied: true,
      nodes: state.nodes,
      edges: nextEdges,
    };
  },
};

export default connectNodes;
