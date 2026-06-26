import { createId, type CanvasCommand } from '../../index.js';
import { normalizeTreeOrder, type NestableNode } from '../frame/index.js';
import { deduplicateLabel, generateNextLabel } from '../utils/labels.js';
import { getNodeDefaultSize } from '../utils/nodeSizes.js';
import { selectOnly } from '../utils/selection.js';

import type { CommandDefinition } from './types.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'CREATE_QUESTION' }>;

const createQuestion: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    const nodeId = cmd.id ?? createId('node');
    const nodeType = 'question';
    const existingLabels = state.nodes.map(
      (n) => n.data?.label as string | undefined,
    );

    // Derive label from content or auto-generate.
    let label = cmd.content
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 50);
    if (!label || label.trim() === '') {
      label = generateNextLabel(nodeType, existingLabels);
    } else {
      label = deduplicateLabel(label, existingLabels);
    }

    const size = cmd.size ?? getNodeDefaultSize(nodeType);

    const node: Node = {
      id: nodeId,
      type: nodeType,
      position: cmd.position ?? { x: 0, y: 0 },
      data: {
        type: nodeType,
        label,
        content: cmd.content,
        // Created idle: the user opens the node in the chat panel to
        // engage with it. There is no headless auto-run anymore.
        status: 'idle',
      },
      ...(size
        ? {
            style:
              typeof size.height === 'number'
                ? { width: size.width, height: size.height }
                : { width: size.width },
          }
        : {}),
    };

    if (cmd.parentId) {
      node.parentId = cmd.parentId;
    }

    // Position is honoured verbatim — `position` is required by the
    // command schema, so every caller commits to a slot up front. The
    // engine no longer ships a fallback layout pass.
    const finalNodes = selectOnly(
      normalizeTreeOrder([...state.nodes, node] as NestableNode[]),
      [node.id],
    );

    return {
      applied: true,
      nodes: finalNodes,
      edges: state.edges,
      ...(cmd.parentId ? { affectedFrameIds: [cmd.parentId as string] } : {}),
    };
  },
};

export default createQuestion;
