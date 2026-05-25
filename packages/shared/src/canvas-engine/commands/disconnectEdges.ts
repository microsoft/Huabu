import { noop, type CommandDefinition } from './types.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'DISCONNECT_EDGES' }>;

const disconnectEdges: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
  },

  handler(cmd, state) {
    if (cmd.edges.length === 0) return noop(state);

    // Build the set of edge IDs to remove. Edges can be referenced by ID or
    // by source/target pair.
    const removeById = new Set<string>();
    const removeByPair = new Set<string>();

    for (const ref of cmd.edges) {
      if (typeof ref === 'string') {
        removeById.add(ref);
      } else {
        removeByPair.add(`${ref.source}|${ref.target}`);
      }
    }

    const nextEdges = state.edges.filter((e) => {
      const shouldRemove =
        removeById.has(e.id) || removeByPair.has(`${e.source}|${e.target}`);
      return !shouldRemove;
    });

    if (nextEdges.length === state.edges.length)
      return noop(state, 'not-found');

    return {
      applied: true,
      nodes: state.nodes,
      edges: nextEdges,
    };
  },
};

export default disconnectEdges;
