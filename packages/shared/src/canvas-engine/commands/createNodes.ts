// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { createId, type CanvasCommand } from '../../index.js';
import { materializeAutoHeight } from '../height/materialize.js';
import { getHeightPolicy } from '../height/policy.js';
import { deduplicateLabel, generateNextLabel } from '../utils/labels.js';
import {
  getNodeCreationStyle,
  getNodeDefaultSize,
} from '../utils/nodeSizes.js';
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
    // Nodes whose input opted out of create-time selection
    // (`selectOnCreate: false`, e.g. sketch draw). Collected during the
    // build loop and excluded from the auto-selection set below.
    const noSelectOnCreateIds = new Set<string>();
    // Nodes whose input opted IN to create-time selection
    // (`selectOnCreate: true`, e.g. paste / duplicate), overriding the
    // default `question` exclusion below.
    const forceSelectOnCreateIds = new Set<string>();
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
      const explicitSize = input.size;
      const size = explicitSize ?? getNodeDefaultSize(nodeType);
      const geometryStyle = getNodeCreationStyle(nodeType, size, {
        heightIsExplicit: typeof explicitSize?.height === 'number',
      });

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

      // A toggleable-height type records its owner explicitly at birth.
      // Without it the node carries a materialized number and no
      // ownership, and `resolveHeightMode`'s legacy fallback would read
      // that number as a pinned height on the next load.
      const isToggleableHeight =
        getHeightPolicy(nodeType).kind === 'toggleable';
      const heightMode = isToggleableHeight
        ? typeof geometryStyle.height === 'number'
          ? 'fixed'
          : 'auto'
        : undefined;

      const rawNode: Node = {
        id: nodeId,
        type: nodeType,
        position: input.position ?? { x: 0, y: 0 },
        data: {
          ...inputData,
          ...(Object.keys(styleWithAccent).length > 0
            ? { style: styleWithAccent }
            : {}),
          ...(heightMode ? { heightMode } : {}),
          label,
          type: nodeType,
        },
        style: geometryStyle,
      };

      // Materialize immediately so the node has a real footprint before
      // anything has rendered it. The end-of-batch `fitFrames` pass and
      // the grid solver run in this same batch, and a height of 0 would
      // fit the parent frame to nothing and then jump when the node
      // mounts.
      //
      // Only toggleable types: `text` / `question` size themselves
      // through a separate mechanism that still expresses auto as the
      // absence of a height, and pinning a nominal default over content
      // they measure themselves would be a regression.
      const node: Node = isToggleableHeight
        ? materializeAutoHeight(rawNode)
        : rawNode;

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

      if (input.selectOnCreate === false) noSelectOnCreateIds.add(nodeId);
      else if (input.selectOnCreate === true)
        forceSelectOnCreateIds.add(nodeId);
      newNodes.push(node);
    }

    // ---------------------------------------------------------------
    // 4. Concatenate the new nodes.
    //
    // Create-time selection is decided per node by `selectOnCreate`
    // layered over a default (these express DIFFERENT intents — do not
    // collapse them):
    //   - `selectOnCreate === false` — hard opt-out (e.g. sketch freehand
    //     draw): never selected, regardless of type.
    //   - `selectOnCreate === true` — hard opt-in (e.g. paste / duplicate):
    //     always selected, overriding the `question` default below.
    //   - otherwise (default) — non-`question` nodes select; `question`
    //     nodes do NOT. Questions are usually born from the compose /
    //     preprocess flow, which focuses the chat input instead of the
    //     canvas, so by default they must not steal focus; an explicit
    //     `selectOnCreate: true` (paste / duplicate) is the escape hatch.
    // Agent/system creates (`source !== 'ui'`) never auto-select at all.
    //
    // Tree order (parents before children, frame-child zIndex) is repaired
    // by the executor's single end-of-batch `normalizeTreeOrder` pass, so
    // this handler no longer normalizes itself.
    // ---------------------------------------------------------------
    const orderedNodes = [...state.nodes, ...newNodes];
    const selectableCreatedNodeIds =
      state.source === 'ui'
        ? newNodes
            .filter((n) => {
              if (noSelectOnCreateIds.has(n.id)) return false;
              if (forceSelectOnCreateIds.has(n.id)) return true;
              return n.type !== 'question';
            })
            .map((n) => n.id)
        : [];
    const finalNodes =
      selectableCreatedNodeIds.length > 0
        ? selectOnly(orderedNodes, selectableCreatedNodeIds)
        : orderedNodes;

    // ---------------------------------------------------------------
    // 5. Position is honoured verbatim — every caller (UI gestures and
    //    agents alike) commits to a slot. There is no fallback layout
    //    pass; the schema marks `position` required, so the type system
    //    guarantees an explicit value is always present here.
    // ---------------------------------------------------------------

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
