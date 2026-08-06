// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import {
  canParentNode,
  getDescendantIds,
  moveNodeIntoContainer,
  moveNodeOutOfContainer,
  type NestableNode,
} from '../container/index.js';

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
    const affectedPortalIds = new Set<string>();
    const parentId = cmd.parentId as string | null;

    // Whole-command validation gate. A missing target node or a missing
    // parent frame is a hard error surfaced to the caller (`invalid-target`
    // / `invalid-parent`), not a silent skip. Silent skipping previously
    // returned `applied: true` while doing nothing, leaving the agent
    // believing a reparent happened. Reject the whole command so the
    // caller can react — dependent reparents should run in a later turn
    // against the real ids returned by CREATE_NODES.
    for (const nodeId of cmd.nodeIds) {
      if (!result.some((n) => n.id === (nodeId as string))) {
        return noop(state, 'invalid-target');
      }
    }
    if (parentId) {
      const parent = result.find((node) => node.id === parentId);
      if (!parent) return noop(state, 'invalid-parent');
      if (parent.data?.locked) return noop(state, 'invalid-parent');
      for (const nodeId of cmd.nodeIds) {
        const child = result.find((node) => node.id === (nodeId as string));
        if (!canParentNode(parent, child)) {
          return noop(state, 'invalid-parent');
        }
        if (
          child?.parentId !== parentId &&
          getDescendantIds(result, child?.id ?? '').includes(parentId)
        ) {
          return noop(state, 'invalid-parent');
        }
      }
    } else {
      for (const nodeId of cmd.nodeIds) {
        const child = result.find((node) => node.id === (nodeId as string));
        const parent = child?.parentId
          ? result.find((node) => node.id === child.parentId)
          : undefined;
        if (
          (child?.type === 'nodeRef' || child?.type === 'frameRef') &&
          (parent?.type === 'canvasRef' || parent?.type === 'frameRef')
        ) {
          return noop(state, 'invalid-parent');
        }
        if (parent?.data?.locked) return noop(state, 'invalid-parent');
      }
    }

    let changed = false;
    for (const nodeId of cmd.nodeIds) {
      const id = nodeId as string;
      const node = result.find((n) => n.id === id);
      if (!node) continue;

      const prevParentId = node.parentId;

      if (parentId) {
        const next = moveNodeIntoContainer(result, id, parentId);
        if (next === result) continue;
        result = next;
        changed = true;
        if (
          result.find((candidate) => candidate.id === parentId)?.type ===
          'frame'
        ) {
          affectedFrameIds.add(parentId);
        }
        if (
          result.find((candidate) => candidate.id === parentId)?.type ===
            'frameRef' ||
          result.find((candidate) => candidate.id === parentId)?.type ===
            'canvasRef'
        ) {
          affectedPortalIds.add(parentId);
        }
        if (
          prevParentId &&
          prevParentId !== parentId &&
          result.find((candidate) => candidate.id === prevParentId)?.type ===
            'frame'
        ) {
          affectedFrameIds.add(prevParentId);
        }
        if (
          prevParentId &&
          prevParentId !== parentId &&
          ['frameRef', 'canvasRef'].includes(
            result.find((candidate) => candidate.id === prevParentId)?.type ??
              '',
          )
        ) {
          affectedPortalIds.add(prevParentId);
        }
        // Queue affected frames for label re-resolution.
        const targetFrame = result.find((n) => n.id === parentId);
        if (
          targetFrame?.type === 'frame' &&
          !mutatedNodes.some((p) => p.id === targetFrame.id)
        ) {
          mutatedNodes.push(targetFrame as Node);
        }
        if (prevParentId && prevParentId !== parentId) {
          const prevFrame = result.find((n) => n.id === prevParentId);
          if (
            prevFrame?.type === 'frame' &&
            !mutatedNodes.some((p) => p.id === prevFrame.id)
          ) {
            mutatedNodes.push(prevFrame as Node);
          }
        }
      } else {
        // Move out of frame.
        const frame = prevParentId
          ? (result.find((n) => n.id === prevParentId) as Node | undefined)
          : undefined;
        const next = moveNodeOutOfContainer(result, id);
        if (next === result) continue;
        result = next;
        changed = true;
        if (frame?.type === 'frame') {
          affectedFrameIds.add(frame.id);
          if (!mutatedNodes.some((p) => p.id === frame.id)) {
            mutatedNodes.push(frame);
          }
        }
      }
    }

    if (!changed) return noop(state);
    return {
      applied: true,
      nodes: result,
      edges: state.edges,
      mutatedNodes,
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
      ...(affectedPortalIds.size > 0
        ? { affectedPortalIds: Array.from(affectedPortalIds) }
        : {}),
    };
  },
};

export default setNodeParent;
