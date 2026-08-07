// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { unframe, type NestableNode } from '../frame/index.js';

import type { CanvasCommand } from '../../index.js';

type Cmd = Extract<CanvasCommand, { type: 'DISSOLVE_FRAME' }>;

const dissolveFrame: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    const frameId = cmd.frameId as string;
    const frame = state.nodes.find((n) => n.id === frameId);
    if (!frame) return noop(state, 'not-found');

    const result = unframe(state.nodes as NestableNode[], state.edges, frameId);

    return {
      applied: true,
      nodes: result.nodes,
      edges: result.edges,
      // The frame node itself is removed from canvas state — its
      // sibling `<safe(label)>.md` (frontmatter-only, written by the
      // autosave PUT for every MD-backed node type, frame included)
      // would otherwise be left orphaned in `<canvasDir>/nodes/`.
      deletedNodeIds: [frameId],
    };
  },
};

export default dissolveFrame;
