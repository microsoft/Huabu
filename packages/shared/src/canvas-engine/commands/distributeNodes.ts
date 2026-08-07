// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { spreadNodes } from '../utils/alignment.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'DISTRIBUTE_NODES' }>;

const distributeNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length < 3) return noop(state);

    const targetIds = new Set(cmd.nodeIds as string[]);

    const result = spreadNodes(state.nodes, 24, cmd.nodeIds as string[]);
    if (!result) return noop(state);

    // Declare affected Containers for their type-specific fit passes.
    const affectedFrameIds = new Set<string>();
    const affectedPortalIds = new Set<string>();
    const byId = new Map(result.map((node) => [node.id, node]));
    for (const n of result) {
      if (!targetIds.has(n.id) || !n.parentId) continue;
      const parentType = byId.get(n.parentId)?.type;
      if (parentType === 'canvasRef' || parentType === 'frameRef') {
        affectedPortalIds.add(n.parentId);
      } else {
        affectedFrameIds.add(n.parentId);
      }
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
      ...(affectedPortalIds.size > 0
        ? { affectedPortalIds: Array.from(affectedPortalIds) }
        : {}),
    };
  },
};

export default distributeNodes;
