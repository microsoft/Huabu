import { noop, type CommandDefinition } from './types.js';
import {
  moveNodeIntoFrame,
  moveNodeOutOfFrame,
  type NestableNode,
} from '../utils/frame.js';

import type { CanvasCommand } from '../../index.js';
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
    const affectedFrameIds = new Set<string>();
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
        affectedFrameIds.add(parentId);
        if (prevParentId && prevParentId !== parentId) {
          affectedFrameIds.add(prevParentId);
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
          affectedFrameIds.add(frame.id);
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
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
    };
  },
};

export default setNodeParent;
