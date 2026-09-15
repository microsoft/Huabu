// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { alignNodes } from '../utils/alignment.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'ALIGN_NODES' }>;

const alignNodesDef: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.nodeIds.length === 0) return noop(state);

    const targetIds = new Set(cmd.nodeIds as string[]);

    const result = alignNodes(
      state.nodes,
      cmd.direction,
      cmd.nodeIds as string[],
    );
    if (!result) return noop(state);

    // Declare affected Frames for the end-of-batch fit pass.
    const affectedFrameIds = new Set<string>();
    for (const n of result) {
      if (!targetIds.has(n.id) || !n.parentId) continue;
      affectedFrameIds.add(n.parentId);
    }

    return {
      applied: true,
      nodes: result,
      edges: state.edges,
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
    };
  },
};

export default alignNodesDef;
