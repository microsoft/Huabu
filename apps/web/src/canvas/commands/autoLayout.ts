import { noop, type CommandDefinition } from './types';
import {
  layoutAll as layoutAllNodes,
  layoutGroup as layoutGroupNodes,
} from '../../utils/layout';
import {
  fitFrameToChildren,
  fitFrames,
  type NestableNode,
} from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'AUTO_LAYOUT' }>;

const autoLayout: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
    needsTransitionCleanup: true,
  },

  handler(cmd, state) {
    const animate = cmd.options?.animate ?? true;

    let result: Node[] | null = null;

    switch (cmd.scope.type) {
      case 'canvas':
        result = layoutAllNodes(state.nodes, state.edges, { animate });
        break;
      case 'frame': {
        const frameId = cmd.scope.frameId as string;
        result = layoutGroupNodes(state.nodes, state.edges, frameId, {
          animate,
        });
        if (result) {
          result = fitFrameToChildren(result as NestableNode[], frameId);
        }
        break;
      }
    }

    if (!result) return noop(state);

    // Refit all frames when doing a full canvas layout.
    if (cmd.scope.type === 'canvas') {
      const frameIds = new Set<string>();
      for (const n of result) {
        if (n.parentId) frameIds.add(n.parentId);
      }
      if (frameIds.size > 0) {
        result = fitFrames(result as NestableNode[], frameIds);
      }
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
    };
  },
};

export default autoLayout;
