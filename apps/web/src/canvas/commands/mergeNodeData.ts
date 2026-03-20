import { noop, type CommandDefinition } from './types';
import { shouldPreprocessOnUpdate } from '../../utils/io/preprocess';

import type { CanvasCommand } from '@sediment/shared';
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
    const ingestNodes: Node[] = [];
    const labelResolveNodeIds: string[] = [];
    let anyApplied = false;

    const nextNodes = state.nodes.map((n) => {
      const patch = patchMap.get(n.id);
      if (!patch) return n;
      anyApplied = true;
      const updated: Node = {
        ...n,
        data: { ...(n.data ?? {}), ...patch },
      };
      if (shouldPreprocessOnUpdate(n, updated)) {
        ingestNodes.push(updated);
      }
      if (
        (patch as Record<string, unknown>).label !== undefined &&
        updated.parentId
      ) {
        labelResolveNodeIds.push(updated.parentId);
      }
      return updated;
    });

    if (!anyApplied) return noop(state, 'not-found');

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      ingestNodes,
      labelResolveNodeIds,
    };
  },
};

export default mergeNodeData;
