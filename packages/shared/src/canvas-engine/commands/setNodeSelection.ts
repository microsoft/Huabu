// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop } from './types.js';

import type { CommandDefinition } from './types.js';
import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_SELECTION' }>;

const setNodeSelection: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'no',
    requiresEdgeReroute: false,
  },

  /**
   * Update node `selected` flags and clear edge selection. Critically, we
   * reuse the original `node` / `edge` references whenever their visible
   * `selected` flag does NOT change — and return the original `state.nodes`
   * / `state.edges` arrays unchanged when the batch had no effect at all.
   *
   * This is the linchpin of selection-click performance: every downstream
   * `React.memo` / `useMemo` / `nodes.find` / xyflow node reconciliation
   * relies on reference identity. Re-spreading every node on every click
   * defeated all of them and forced an O(N) walk through every subscriber
   * (Canvas, layer panel, chat refs, toolbars, …) on each selection
   * toggle.
   */
  handler(cmd, state) {
    const selectedIds = new Set(cmd.nodeIds as string[]);

    let nodesChanged = false;
    const nextNodes = state.nodes.map((n) => {
      const wanted = selectedIds.has(n.id);
      if (Boolean(n.selected) === wanted) return n;
      nodesChanged = true;
      return { ...n, selected: wanted };
    });

    let edgesChanged = false;
    const nextEdges = state.edges.map((edge) => {
      if (!edge.selected) return edge;
      edgesChanged = true;
      return { ...edge, selected: false };
    });

    if (!nodesChanged && !edgesChanged) {
      return noop(state, 'no-op');
    }

    return {
      applied: true,
      nodes: nodesChanged ? nextNodes : state.nodes,
      edges: edgesChanged ? nextEdges : state.edges,
    };
  },
};

export default setNodeSelection;
