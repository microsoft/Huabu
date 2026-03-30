import { noop, type CommandDefinition } from './types';
import { unframe, type NestableNode } from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';

type Cmd = Extract<CanvasCommand, { type: 'DISSOLVE_FRAME' }>;

const dissolveFrame: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    const frameId = cmd.frameId as string;
    const frame = state.nodes.find((n) => n.id === frameId);
    if (!frame) return noop(state, 'not-found');

    const result = unframe(state.nodes as NestableNode[], state.edges, frameId);

    return {
      applied: true,
      nodes: result.nodes,
      edges: result.edges,
    };
  },
};

export default dissolveFrame;
