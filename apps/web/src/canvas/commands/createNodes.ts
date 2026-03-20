import { createId, type CanvasCommand } from '@sediment/shared';

import { noop, type CommandDefinition } from './types';
import { needsLabelResolve } from '../../utils/io/resolveLabel';
import { placeNode } from '../../utils/layout';
import { deduplicateLabel, generateNextLabel } from '../../utils/node/labels';
import { getNodeDefaultSize } from '../../utils/node/nodeDefaultSize';
import { selectOnly } from '../utils';
import {
  fitFrames,
  normalizeTreeOrder,
  type NestableNode,
} from '../utils/frame';

import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'CREATE_NODES' }>;

const createNodes: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'yes',
    requiresEdgeReroute: true,
    needsTransitionCleanup: false,
  },

  handler(cmd, state) {
    if (cmd.nodes.length === 0) return noop(state);

    const existingLabels = state.nodes.map(
      (n) => n.data?.label as string | undefined,
    );
    const newNodes: Node[] = [];
    const labelResolveNodeIds: string[] = [];

    for (const input of cmd.nodes) {
      const nodeId = input.id ?? createId('node');
      const nodeType = input.nodeType;

      // ---------------------------------------------------------------
      // 1. Resolve label: if not provided, derive from content/src or
      //    auto-generate (e.g. "Note 1"). Also collect nodes needing
      //    async LLM label resolution.
      // ---------------------------------------------------------------
      let label = (input.data as Record<string, unknown> | undefined)?.label as
        | string
        | undefined;
      if (!label || label.trim() === '') {
        const data = (input.data ?? {}) as Record<string, unknown>;
        const content = typeof data.content === 'string' ? data.content : '';
        const src = typeof data.src === 'string' ? data.src : '';

        if (content.trim()) {
          label =
            content
              .split('\n')
              .find((l) => l.trim())
              ?.trim()
              .slice(0, 50) || '';
        } else if (src && nodeType === 'web') {
          try {
            label = new URL(src).hostname;
          } catch {
            label = '';
          }
        }

        if (!label || label.trim() === '') {
          label = generateNextLabel(nodeType, existingLabels);
        } else {
          label = deduplicateLabel(label, existingLabels);
        }
      } else {
        label = deduplicateLabel(label, existingLabels);
      }
      existingLabels.push(label);
      // Collect nodes needing async LLM label resolution.
      if (needsLabelResolve(nodeType)) labelResolveNodeIds.push(nodeId);

      // ---------------------------------------------------------------
      // 2. Build the final ReactFlow node from the resolved command
      //    input. Position defaults to (0,0) and is adjusted in step 5.
      // ---------------------------------------------------------------
      const size = input.size ?? getNodeDefaultSize(nodeType);

      const node: Node = {
        id: nodeId,
        type: nodeType,
        position: input.position ?? { x: 0, y: 0 },
        data: { ...(input.data ?? {}), label, type: nodeType },
        ...(size
          ? {
              style:
                typeof size.height === 'number'
                  ? { width: size.width, height: size.height }
                  : { width: size.width },
            }
          : {}),
      };

      // ---------------------------------------------------------------
      // 3. Assign parent frame and queue its label for resolution.
      // ---------------------------------------------------------------
      if (input.parentId) {
        node.parentId = input.parentId;
        labelResolveNodeIds.push(input.parentId);
      }

      newNodes.push(node);
    }

    // ---------------------------------------------------------------
    // 4. Normalize tree order and select new nodes.
    // ---------------------------------------------------------------
    let finalNodes = selectOnly(
      normalizeTreeOrder([...state.nodes, ...newNodes] as NestableNode[]),
      newNodes.map((n) => n.id),
    );

    // ---------------------------------------------------------------
    // 5. Resolve position: if not provided, use force-directed
    //    placement to find a non-overlapping position. If provided
    //    but auto-layout is enabled (and not skipped / parent not
    //    locked), re-place to optimize layout.
    // ---------------------------------------------------------------
    for (const [i, n] of newNodes.entries()) {
      const input = cmd.nodes[i];
      const hasExplicitPosition = !!input.position;

      if (hasExplicitPosition) {
        // Explicit position: only re-place if auto-layout applies.
        if (input.skipAutoLayout) continue;
        if (!state.autoLayoutEnabled) continue;
        const parentFrame = n.parentId
          ? state.nodes.find((fn) => fn.id === n.parentId)
          : undefined;
        if (parentFrame?.data?.locked === true) continue;
      }

      const placed = placeNode(finalNodes, state.edges, n.id);
      if (placed) finalNodes = placed;
    }

    // ---------------------------------------------------------------
    // 6. Auto-resize parent frames that received new children
    //    (only when auto-layout is enabled).
    // ---------------------------------------------------------------
    if (state.autoLayoutEnabled) {
      const affectedFrameIds = new Set<string>();
      for (const n of newNodes) {
        if (n.parentId) affectedFrameIds.add(n.parentId);
      }
      if (affectedFrameIds.size > 0) {
        finalNodes = fitFrames(finalNodes as NestableNode[], affectedFrameIds);
      }
    }

    return {
      applied: true,
      nodes: finalNodes,
      edges: state.edges,
      ingestNodes: newNodes,
      labelResolveNodeIds,
    };
  },
};

export default createNodes;
