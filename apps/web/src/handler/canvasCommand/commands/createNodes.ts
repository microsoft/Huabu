import { createId, type CanvasCommand } from '@sediment/shared';

import { getNodeDefaultSize } from '@/config/nodeSizes';
import { placeNode } from '@/handler/autoLayout';
import { needsPreprocessing } from '@/handler/canvasCommand/preprocess';
import { deduplicateLabel, generateNextLabel } from '@/utils/node/labels';

import { noop, type CommandDefinition } from './types';
import { selectOnly } from '../utils';
import {
  fitFrames,
  normalizeTreeOrder,
  type NestableNode,
} from '../utils/frame';

import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'CREATE_NODES' }>;

/**
 * Per-type default accent applied at creation time when the caller did not
 * provide one. Fresh frames and notes start on a clean white card; text
 * nodes intentionally start transparent so they read as a typographic
 * overlay on the canvas.
 *
 * Only types listed here get a default. Any value already present on
 * `data.style.accent` (including an explicit `null`) is preserved — this
 * keeps clipboard paste, undo/redo, and other passthroughs lossless.
 */
const DEFAULT_ACCENT_BY_TYPE: Partial<Record<string, string | null>> = {
  frame: 'white',
  note: 'white',
  text: null,
};

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
    const preprocessNodes: Node[] = [];

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

        if (content.trim()) {
          label =
            content
              .split('\n')
              .find((l) => l.trim())
              ?.trim()
              .slice(0, 50) || '';
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

      // ---------------------------------------------------------------
      // 2. Build the final ReactFlow node from the resolved command
      //    input. Position defaults to (0,0) and is adjusted in step 5.
      // ---------------------------------------------------------------
      const size = input.size ?? getNodeDefaultSize(nodeType);

      // Apply the per-type default accent, but only if the caller did
      // not explicitly set one (preserves clipboard paste / undo data).
      const inputData = (input.data ?? {}) as Record<string, unknown>;
      const inputStyle = (inputData.style ?? {}) as Record<string, unknown>;
      const hasExplicitAccent = 'accent' in inputStyle;
      const defaultAccent = DEFAULT_ACCENT_BY_TYPE[nodeType];
      const styleWithAccent =
        !hasExplicitAccent && defaultAccent !== undefined
          ? { ...inputStyle, accent: defaultAccent }
          : inputStyle;

      const node: Node = {
        id: nodeId,
        type: nodeType,
        position: input.position ?? { x: 0, y: 0 },
        data: {
          ...inputData,
          ...(Object.keys(styleWithAccent).length > 0
            ? { style: styleWithAccent }
            : {}),
          label,
          type: nodeType,
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

      // ---------------------------------------------------------------
      // 3. Assign parent frame and queue its label for resolution.
      // ---------------------------------------------------------------
      if (input.parentId) {
        node.parentId = input.parentId;
        // Parent frame needs re-resolution of its group label.
        const parentFrame = state.nodes.find((n) => n.id === input.parentId);
        if (
          parentFrame &&
          !preprocessNodes.some((p) => p.id === parentFrame.id)
        ) {
          preprocessNodes.push(parentFrame);
        }
      }

      newNodes.push(node);
    }

    // ---------------------------------------------------------------
    // 4. Normalize tree order and select new nodes.
    //
    // Sketch (annotation) nodes are intentionally excluded from
    // auto-selection: drawing many strokes in a row should not keep
    // hijacking the selection (which would dismiss other toolbars and
    // scroll the canvas around). When the entire batch is sketches we
    // skip `selectOnly` entirely so any pre-existing selection is
    // preserved.
    // ---------------------------------------------------------------
    const orderedNodes = normalizeTreeOrder([
      ...state.nodes,
      ...newNodes,
    ] as NestableNode[]);
    const newSelectedIds = newNodes
      .filter((n) => n.type !== 'annotation')
      .map((n) => n.id);
    let finalNodes =
      newSelectedIds.length > 0
        ? selectOnly(orderedNodes, newSelectedIds)
        : orderedNodes;

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
      preprocessNodes: [
        // Only include new nodes that need preprocessing.
        ...newNodes.filter((n) => needsPreprocessing(n.type ?? '')),
        // Include parent frames that need label re-resolution.
        ...preprocessNodes,
      ],
    };
  },
};

export default createNodes;
