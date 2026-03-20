import { noop, type CommandDefinition } from './types';
import {
  moveNodeIntoFrame,
  moveNodeOutOfFrame,
  fitFrameToChildren,
  type NestableNode,
} from '../utils/frame';

import type { CanvasCommand } from '@sediment/shared';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_PARENT' }>;

const setNodeParent: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length === 0) return noop(state);

    let result = state.nodes as NestableNode[];
    const preprocessNodes: Node[] = [];
    const parentId = cmd.parentId as string | null;

    for (const nodeId of cmd.nodeIds) {
      const id = nodeId as string;
      const node = result.find((n) => n.id === id);
      if (!node) continue;

      const prevParentId = node.parentId;

      if (parentId) {
        // Move into frame.
        const frame = result.find((n) => n.id === parentId);
        if (!frame) continue;
        result = moveNodeIntoFrame(result, id, parentId);
        if (state.autoLayoutEnabled) {
          result = fitFrameToChildren(result, parentId);
          if (prevParentId && prevParentId !== parentId) {
            result = fitFrameToChildren(result, prevParentId);
          }
        }
        // Queue affected frames for label re-resolution.
        const targetFrame = result.find((n) => n.id === parentId);
        if (
          targetFrame &&
          !preprocessNodes.some((p) => p.id === targetFrame.id)
        ) {
          preprocessNodes.push(targetFrame as Node);
        }
        if (prevParentId && prevParentId !== parentId) {
          const prevFrame = result.find((n) => n.id === prevParentId);
          if (
            prevFrame &&
            !preprocessNodes.some((p) => p.id === prevFrame.id)
          ) {
            preprocessNodes.push(prevFrame as Node);
          }
        }
      } else {
        // Move out of frame.
        const frame = prevParentId
          ? (result.find((n) => n.id === prevParentId) as Node | undefined)
          : undefined;
        result = moveNodeOutOfFrame(result, id);
        if (frame) {
          if (state.autoLayoutEnabled) {
            result = fitFrameToChildren(result, frame.id);
          }
          if (!preprocessNodes.some((p) => p.id === frame.id)) {
            preprocessNodes.push(frame);
          }
        }
      }
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
      preprocessNodes,
    };
  },
};

export default setNodeParent;
