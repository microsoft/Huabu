import { createId, type CanvasCommand } from '../../index.js';
import { placeNode } from '../autoLayout/index.js';
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

    // When content is provided, auto-schedule execution after 10s.
    // This matches the behavior of manually editing a question node and
    // blurring — useQuestionRunner watches for status==='pending' + runAt.
    const hasContent = cmd.content.trim().length > 0;
    const AUTO_RUN_DELAY_S = 10;

    const node: Node = {
      id: nodeId,
      type: nodeType,
      position: cmd.position ?? { x: 0, y: 0 },
      data: {
        type: nodeType,
        label,
        content: cmd.content,
        status: hasContent ? 'pending' : 'idle',
        ...(hasContent ? { runAt: Date.now() + AUTO_RUN_DELAY_S * 1000 } : {}),
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

    let finalNodes = selectOnly(
      normalizeTreeOrder([...state.nodes, node] as NestableNode[]),
      [node.id],
    );

    // Position: honour the caller's contract — if `position` is provided
    // it is used verbatim; otherwise run force-directed `placeNode` to
    // find a non-overlapping slot.
    if (!cmd.position) {
      const placed = placeNode(finalNodes, state.edges, node.id);
      if (placed) finalNodes = placed;
    }

    return {
      applied: true,
      nodes: finalNodes,
      edges: state.edges,
      ...(cmd.parentId ? { affectedFrameIds: [cmd.parentId as string] } : {}),
    };
  },
};

export default createQuestion;
