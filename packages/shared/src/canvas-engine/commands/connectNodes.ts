// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { createId, type CanvasCommand } from '../../index.js';
import { applyEdgeStyle, getInternalEdgeFrameIds } from '../utils/edge.js';

import type { Edge } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'CONNECT_NODES' }>;

const connectNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.edges.length === 0) return noop(state);

    // Endpoint existence check (whole-command gate). Every edge's source
    // and target must resolve to a live node; a missing endpoint is a
    // hard error, not a silent skip. Rejecting the whole command (rather
    // than dropping the offending edge) gives the agent an actionable
    // `invalid-target` result to react to — the alternative (partial,
    // silent application) leaves it believing edges landed that never
    // did. Dependent connects should run in a later turn against the
    // real ids returned by CREATE_NODES, so a well-formed batch never
    // trips this.
    const nodeIds = new Set(state.nodes.map((n) => n.id));
    const hasMissingEndpoint = cmd.edges.some(
      (e) =>
        !nodeIds.has(e.source as string) || !nodeIds.has(e.target as string),
    );
    if (hasMissingEndpoint) return noop(state, 'invalid-target');

    const nextEdges: Edge[] = [...state.edges];
    const addedEdges: Edge[] = [];

    for (const edgeInput of cmd.edges) {
      const source = edgeInput.source as string;
      const target = edgeInput.target as string;
      const id = (edgeInput.id as string | undefined) ?? createId('edge');

      // Skip self-loops (an edge whose source and target are the same
      // node). Self-connections carry no meaning here and are awkward to
      // select/delete, so we drop them silently as a no-op rather than
      // failing the whole command.
      if (source === target) continue;

      // Skip duplicate edges (same behavior as RF addEdge). A duplicate
      // is a legitimate no-op, not a failure — the command still applies.
      const exists = nextEdges.some(
        (e) => e.source === source && e.target === target,
      );
      if (!exists) {
        const edge = applyEdgeStyle({ id, source, target }, edgeInput.style);
        nextEdges.push(edge);
        addedEdges.push(edge);
      }
    }

    return {
      applied: true,
      nodes: state.nodes,
      edges: nextEdges,
      affectedFrameIds: getInternalEdgeFrameIds(state.nodes, addedEdges),
    };
  },
};

export default connectNodes;
