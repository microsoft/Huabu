import { noop, type CommandDefinition } from './types.js';
import { spreadNodes } from '../utils/alignment.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'DISTRIBUTE_NODES' }>;

const distributeNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length < 3) return noop(state);

    const targetIds = new Set(cmd.nodeIds as string[]);

    const result = spreadNodes(state.nodes, 24, cmd.nodeIds as string[]);
    if (!result) return noop(state);

    // Declare affected parent frames; the executor performs a single
    // `fitFrames` pass at end of batch.
    const affectedFrameIds = new Set<string>();
    for (const n of result) {
      if (targetIds.has(n.id) && n.parentId) affectedFrameIds.add(n.parentId);
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
    };
  },
};

export default distributeNodes;
