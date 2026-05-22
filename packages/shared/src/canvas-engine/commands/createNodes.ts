import { noop, type CommandDefinition } from './types.js';
import { createId, type CanvasCommand } from '../../index.js';
import { placeNode } from '../autoLayout/index.js';
import { normalizeTreeOrder, type NestableNode } from '../frame/index.js';
import { deduplicateLabel, generateNextLabel } from '../utils/labels.js';
import { getNodeDefaultSize } from '../utils/nodeSizes.js';
import { selectOnly } from '../utils/selection.js';

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
  },

  handler(cmd, state) {
    if (cmd.nodes.length === 0) return noop(state);

    const existingLabels = state.nodes.map(
      (n) => n.data?.label as string | undefined,
    );
    const newNodes: Node[] = [];
    // Parent frames whose group label may need re-resolution because a
    // new child was added. The server decides whether to actually run.
    const affectedParentFrames: Node[] = [];

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
          !affectedParentFrames.some((p) => p.id === parentFrame.id)
        ) {
          affectedParentFrames.push(parentFrame);
        }
      }

      newNodes.push(node);
    }

    // ---------------------------------------------------------------
    // 4. Normalize tree order and select new nodes.
    //
    // Sketch nodes are intentionally excluded from
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
      .filter((n) => n.type !== 'sketch')
      .map((n) => n.id);
    let finalNodes =
      newSelectedIds.length > 0
        ? selectOnly(orderedNodes, newSelectedIds)
        : orderedNodes;

    // ---------------------------------------------------------------
    // 5. Resolve position. Honour the caller's contract:
    //    - `position` provided → use it verbatim. The caller (drag-drop,
    //      paste, toolbar placement, sketch overlay, group-into-frame,
    //      undo/redo restore, …) has already chosen where the node
    //      belongs and the canvas must not move it.
    //    - `position` omitted → no anchor available; run force-directed
    //      `placeNode` to find a non-overlapping slot. This runs
    //      independently of `autoLayoutEnabled` since otherwise the
    //      node would land at (0,0) on top of existing content.
    // ---------------------------------------------------------------
    for (const [i, n] of newNodes.entries()) {
      if (cmd.nodes[i].position) continue;
      const placed = placeNode(finalNodes, state.edges, n.id);
      if (placed) finalNodes = placed;
    }

    // ---------------------------------------------------------------
    // 6. Declare affected parent frames; the executor performs a single
    //    `fitFrames` pass at end of batch.
    // ---------------------------------------------------------------
    const affectedFrameIds = new Set<string>();
    for (const n of newNodes) {
      if (n.parentId) affectedFrameIds.add(n.parentId);
    }

    return {
      applied: true,
      nodes: finalNodes,
      edges: state.edges,
      // All newly-created nodes + any parent frames whose group label
      // may need to be regenerated. The server's preprocessing
      // dispatcher filters by node profile, so the engine doesn't.
      mutatedNodes: [...newNodes, ...affectedParentFrames],
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
    };
  },
};

export default createNodes;
