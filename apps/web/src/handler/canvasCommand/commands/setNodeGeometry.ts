import { noop, type CommandDefinition } from './types';
import { fitFrames, type NestableNode } from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_GEOMETRY' }>;

const setNodeGeometry: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'caller',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.items.length === 0) return noop(state);

    const updateMap = new Map(
      cmd.items.map((item) => [item.nodeId as string, item]),
    );
    const affectedFrameIds = new Set<string>();

    let nextNodes = state.nodes.map((n) => {
      const update = updateMap.get(n.id);
      if (!update) return n;

      let updated = n;
      if (update.position) {
        updated = { ...updated, position: update.position };
      }
      if (update.size) {
        const nextStyle = {
          ...updated.style,
          width: update.size.width,
        };
        if (typeof update.size.height === 'number') {
          nextStyle.height = update.size.height;
        } else {
          delete nextStyle.height;
        }

        updated = {
          ...updated,
          style: nextStyle,
        };
      }
      if (updated.parentId) affectedFrameIds.add(updated.parentId);
      return updated;
    });

    // Auto-resize parent frames (only when auto-layout is on).
    if (state.autoLayoutEnabled && affectedFrameIds.size > 0) {
      nextNodes = fitFrames(nextNodes as NestableNode[], affectedFrameIds);
    }

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
    };
  },
};

export default setNodeGeometry;
