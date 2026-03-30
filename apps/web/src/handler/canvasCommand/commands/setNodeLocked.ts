import { toggleNodeLock } from '@/utils/node/helper';

import { noop, type CommandDefinition } from './types';

import type { NestableNode } from '../utils/frame';
import type { CanvasCommand } from '@sediment/shared';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_LOCKED' }>;

const setNodeLocked: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.items.length === 0) return noop(state);

    const lockMap = new Map(
      cmd.items.map((item) => [item.nodeId as string, item.locked]),
    );

    // Check that at least one target node exists.
    const anyExists = state.nodes.some((n) => lockMap.has(n.id));
    if (!anyExists) return noop(state, 'not-found');

    // For each item, use the toggleNodeLock utility which handles frame descendants.
    let result = state.nodes as NestableNode[];
    for (const item of cmd.items) {
      const id = item.nodeId as string;
      const node = result.find((n) => n.id === id);
      if (!node) continue;
      const currentLocked = node.data?.locked === true;
      if (currentLocked !== item.locked) {
        result = toggleNodeLock(result, id);
      }
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
    };
  },
};

export default setNodeLocked;
