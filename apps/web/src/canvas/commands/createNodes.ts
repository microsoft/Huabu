import { createId, type CanvasCommand } from '@sediment/shared';

import { noop, type CommandDefinition } from './types';
import { needsLabelResolve } from '../../utils/io/resolveLabel';
import { placeNode } from '../../utils/layout';
import { getNodeSize } from '../../utils/node/factory';
import { deduplicateLabel, generateNextLabel } from '../../utils/node/labels';
import { selectOnly } from '../utils';
import {
  findFrameAtPoint,
  fitFrames,
  getAbsolutePosition,
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
      // 2. Resolve parentId: if not provided and position falls inside
      //    an existing frame, auto-nest into that frame and convert
      //    position to frame-relative coordinates.
      // ---------------------------------------------------------------
      let parentId: string | undefined = input.parentId ?? undefined;
      let position = input.position ?? { x: 0, y: 0 };

      if (input.position && !parentId && nodeType !== 'frame') {
        const resolvedSize = input.size ?? getNodeSize(nodeType);
        const w = resolvedSize?.width ?? 0;
        const h = resolvedSize?.height ?? 0;
        const checkPoint = {
          x: position.x + w / 2,
          y: position.y + h / 2,
        };
        const allNodes = [...state.nodes, ...newNodes] as NestableNode[];
        const frameId = findFrameAtPoint(allNodes, checkPoint);
        if (frameId) {
          const frameAbs = getAbsolutePosition(allNodes, frameId);
          if (frameAbs) {
            parentId = frameId;
            position = {
              x: position.x - frameAbs.x,
              y: position.y - frameAbs.y,
            };
          }
        }
      }

      // ---------------------------------------------------------------
      // 3. Resolve size: if not provided, use canonical defaults from
      //    factory. Text/note only get width (CSS auto-height).
      //    Build the final node object.
      // ---------------------------------------------------------------
      const size = input.size ?? getNodeSize(nodeType);
      const node: Node = {
        id: nodeId,
        type: nodeType,
        position,
        data: { ...(input.data ?? {}), label },
        ...(size ? { style: size } : {}),
        ...(parentId ? { parentId } : {}),
      };

      // Also resolve parent frame labels when a node is nested.
      if (parentId) labelResolveNodeIds.push(parentId);

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
