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

    const targetIds = new Set(cmd.nodeIds as string[]);

    const result = alignNodes(
      state.nodes,
      cmd.direction,
      cmd.nodeIds as string[],
    );
    if (!result) return noop(state);

    let finalNodes = result;

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
