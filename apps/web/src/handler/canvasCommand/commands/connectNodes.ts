import { createId, type CanvasCommand } from '@sediment/shared';

import { noop, type CommandDefinition } from './types';

import type { Edge } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'CONNECT_NODES' }>;

const connectNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.edges.length === 0) return noop(state);

    const nextEdges: Edge[] = [...state.edges];

    for (const edgeInput of cmd.edges) {
      const source = edgeInput.source as string;
      const target = edgeInput.target as string;
      const id = (edgeInput.id as string | undefined) ?? createId('edge');

      // Skip duplicate edges (same behavior as RF addEdge).
      const exists = nextEdges.some(
        (e) => e.source === source && e.target === target,
      );
      if (!exists) {
        nextEdges.push({ id, source, target });
      }
    }

    return {
      applied: true,
      nodes: state.nodes,
      edges: nextEdges,
    };
  },
};

export default connectNodes;
