// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';

import type { CanvasCommand } from '../../index.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'REORDER_NODES' }>;

const reorderNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
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
    } else if ('before' in cmd.to) {
      // { before: CanvasNodeId }
      // insert moving nodes before the target.
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
    } else {
      // { after: CanvasNodeId }
      // insert moving nodes after the target.
      const targetId = cmd.to.after as string;
      const targetIndex = rest.findIndex((n) => n.id === targetId);
      if (targetIndex === -1) {
        reordered = [...rest, ...moving];
      } else {
        reordered = [
          ...rest.slice(0, targetIndex + 1),
          ...moving,
          ...rest.slice(targetIndex + 1),
        ];
      }
    }

    // Array order IS the reorder result; the executor runs a single
    // end-of-batch `normalizeTreeOrder` pass that repairs parent-before-
    // child order (and frame-child zIndex) using this array's order as the
    // stable sort key, so no per-command normalization is needed here.
    return {
      applied: true,
      nodes: reordered,
      edges: state.edges,
    };
  },
};

export default reorderNodes;
