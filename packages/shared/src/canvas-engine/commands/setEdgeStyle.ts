import { noop, type CommandDefinition } from './types.js';
import { mergeEdgeStyle } from '../utils/edge.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'SET_EDGE_STYLE' }>;

const setEdgeStyle: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.edges.length === 0) return noop(state);

    // Build lookup: edgeId → style patch
    const patchById = new Map<string, Cmd['edges'][number]['style']>();
    const patchByPair = new Map<string, Cmd['edges'][number]['style']>();

    for (const entry of cmd.edges) {
      if (typeof entry.edge === 'string') {
        patchById.set(entry.edge, entry.style);
      } else {
        patchByPair.set(
          `${entry.edge.source}|${entry.edge.target}`,
          entry.style,
        );
      }
    }

    let changed = false;
    const nextEdges = state.edges.map((e) => {
      const patch =
        patchById.get(e.id) ?? patchByPair.get(`${e.source}|${e.target}`);
      if (!patch) return e;
      changed = true;
      return mergeEdgeStyle(e, patch);
    });

    if (!changed) return noop(state);

    return {
      applied: true,
      nodes: state.nodes,
      edges: nextEdges,
    };
  },
};

export default setEdgeStyle;
