import { noop, type CommandDefinition } from './types';
import { spreadNodes } from '../utils/alignment';
import { fitFrames, type NestableNode } from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';

type Cmd = Extract<CanvasCommand, { type: 'DISTRIBUTE_NODES' }>;

const distributeNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length < 3) return noop(state);

    // spreadNodes utility works on selected nodes.
    const targetIds = new Set(cmd.nodeIds as string[]);
    const nodesWithSelection = state.nodes.map((n) => ({
      ...n,
      selected: targetIds.has(n.id),
    }));

    const result = spreadNodes(nodesWithSelection);
    if (!result) return noop(state);

    // Restore original selection state after distribution.
    const distributedMap = new Map(result.map((n) => [n.id, n]));
    let finalNodes = state.nodes.map((n) => {
      const distributed = distributedMap.get(n.id);
      if (!distributed) return n;
      return { ...distributed, selected: n.selected };
    });

    // Resize affected parent frames (only when auto-layout is on).
    const affectedFrameIds = new Set<string>();
    for (const n of finalNodes) {
      if (targetIds.has(n.id) && n.parentId) affectedFrameIds.add(n.parentId);
    }
    if (state.autoLayoutEnabled && affectedFrameIds.size > 0) {
      finalNodes = fitFrames(finalNodes as NestableNode[], affectedFrameIds);
    }

    return {
      applied: true,
      nodes: finalNodes,
      edges: state.edges,
    };
  },
};

export default distributeNodes;
