import { noop, type CommandDefinition } from './types.js';
import {
  moveNodeIntoFrame,
  moveNodeOutOfFrame,
  type NestableNode,
} from '../frame/index.js';

import type { CanvasCommand } from '../../index.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_PARENT' }>;

const setNodeParent: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length === 0) return noop(state);

    let result = state.nodes as NestableNode[];
    // Frames whose group label may need re-resolution because their
    // child set changed. The server's preprocessing dispatcher decides
    // whether to actually run.
    const mutatedNodes: Node[] = [];
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
        if (targetFrame && !mutatedNodes.some((p) => p.id === targetFrame.id)) {
          mutatedNodes.push(targetFrame as Node);
        }
        if (prevParentId && prevParentId !== parentId) {
          const prevFrame = result.find((n) => n.id === prevParentId);
          if (prevFrame && !mutatedNodes.some((p) => p.id === prevFrame.id)) {
            mutatedNodes.push(prevFrame as Node);
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
          if (!mutatedNodes.some((p) => p.id === frame.id)) {
            mutatedNodes.push(frame);
          }
        }
      }
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
      mutatedNodes,
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
    };
  },
};

export default setNodeParent;
