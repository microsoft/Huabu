import { noop, type CommandDefinition } from './types';
import { alignNodes } from '../utils/alignment';
import { fitFrames, type NestableNode } from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';

type Cmd = Extract<CanvasCommand, { type: 'ALIGN_NODES' }>;

const alignNodesDef: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length === 0) return noop(state);

    // alignNodes utility works on selected nodes, so we need to temporarily
    // mark the target nodes as selected.
    const targetIds = new Set(cmd.nodeIds as string[]);
    const nodesWithSelection = state.nodes.map((n) => ({
      ...n,
      selected: targetIds.has(n.id),
    }));

    const result = alignNodes(nodesWithSelection, cmd.direction);
    if (!result) return noop(state);

    // Restore original selection state after alignment.
    const alignedMap = new Map(result.map((n) => [n.id, n]));
    let finalNodes = state.nodes.map((n) => {
      const aligned = alignedMap.get(n.id);
      if (!aligned) return n;
      // Keep original selected state, take aligned position.
      return { ...aligned, selected: n.selected };
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

export default alignNodesDef;
