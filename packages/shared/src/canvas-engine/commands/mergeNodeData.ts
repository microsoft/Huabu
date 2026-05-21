import { shouldPreprocessOnUpdate } from '../preprocess.js';
import { noop, type CommandDefinition } from './types.js';

import type { CanvasCommand } from '../../index.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'MERGE_NODE_DATA' }>;

const mergeNodeData: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: false,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.patches.length === 0) return noop(state);

    const patchMap = new Map(
      cmd.patches.map((p) => [p.nodeId as string, p.patch]),
    );
    const preprocessNodes: Node[] = [];
    const contentEditedNodeIds: string[] = [];
    let anyApplied = false;

    const nextNodes = state.nodes.map((n) => {
      const patch = patchMap.get(n.id);
      if (!patch) return n;
      anyApplied = true;
      const patchRec = patch as Record<string, unknown>;
      const dataRec = (n.data ?? {}) as Record<string, unknown>;

      const updated: Node = {
        ...n,
        data: {
          ...dataRec,
          ...patchRec,
        },
      };
      if (shouldPreprocessOnUpdate(n, updated)) {
        preprocessNodes.push(updated);
      }
      // Engine-neutral fact: the node's `content` field was rewritten.
      // Hosts decide what to do with this (web/agent batches use it to
      // flag AI-authored rewrites for the editor; other hosts ignore it).
      if (typeof patchRec.content === 'string') {
        contentEditedNodeIds.push(n.id);
      }
      // When a child's label changes, the parent frame needs re-resolution.
      if (
        (patch as Record<string, unknown>).label !== undefined &&
        updated.parentId
      ) {
        const parentFrame = state.nodes.find(
          (pn) => pn.id === updated.parentId,
        );
        if (
          parentFrame &&
          !preprocessNodes.some((p) => p.id === parentFrame.id)
        ) {
          preprocessNodes.push(parentFrame);
        }
      }
      return updated;
    });

    if (!anyApplied) return noop(state, 'not-found');

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      preprocessNodes,
      ...(contentEditedNodeIds.length > 0 ? { contentEditedNodeIds } : {}),
    };
  },
};

export default mergeNodeData;
