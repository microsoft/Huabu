// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { getInternalEdgeFrameIds, mergeEdgeStyle } from '../utils/edge.js';

import type { CanvasCommand } from '../../index.js';
import type { Edge } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'SET_EDGE_STYLE' }>;

const setEdgeStyle: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
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
    const changedEdges: Edge[] = [];
    const nextEdges = state.edges.map((e) => {
      const patch =
        patchById.get(e.id) ?? patchByPair.get(`${e.source}|${e.target}`);
      if (!patch) return e;
      changed = true;
      const next = mergeEdgeStyle(e, patch);
      changedEdges.push(next);
      return next;
    });

    if (!changed) return noop(state);

    return {
      applied: true,
      nodes: state.nodes,
      edges: nextEdges,
      affectedFrameIds: getInternalEdgeFrameIds(state.nodes, changedEdges),
    };
  },
};

export default setEdgeStyle;
