// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { noop, type CommandDefinition } from './types.js';
import { getFrameSizing } from '../frame/sizing.js';
import { materializeAutoHeight } from '../height/materialize.js';
import { getHeightPolicy } from '../height/policy.js';
import { isAlwaysAutoHeightNodeType } from '../utils/nodeSizes.js';

import type { CanvasCommand } from '../../index.js';
import type { HeightMode } from '../../types/canvas/node.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'SET_NODE_GEOMETRY' }>;

/**
 * Record who owns the node's height, but only for types where that is a
 * real choice. Always-content and always-manual types derive their mode
 * from the policy table, so writing the field would add a second, silently
 * divergent source for the same fact.
 */
function withHeightMode(node: Node, mode: HeightMode): Node['data'] {
  const data = node.data ?? {};
  if (getHeightPolicy(node.type).kind !== 'toggleable') return data;
  if ((data as { heightMode?: unknown }).heightMode === mode) return data;
  return { ...data, heightMode: mode };
}

const setNodeGeometry: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'caller',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.items.length === 0) return noop(state);

    const updateMap = new Map(
      cmd.items.map((item) => [item.nodeId as string, item]),
    );
    const affectedFrameIds = new Set<string>();
    const affectedPortalIds = new Set<string>();
    // Parent frames whose child just had its explicit height cleared
    // (revert to content-driven sizing). The new content height is
    // unknown until the inline editor reflows + RF re-measures, so we
    // ask the executor's post-effect to refit after the next render
    // cycle.
    const deferredFitFrameIds = new Set<string>();

    // Frames the caller is actively resizing in this batch. We must
    // not add them to `affectedFrameIds` via a child's `parentId`,
    // otherwise the executor's end-of-batch `fitFrames` would snap a
    // free-mode frame back to its children's bounding box — undoing
    // the user's drag during a cascade-scale gesture. Structured
    // frames are still added through the explicit `type === 'frame'
    // && layoutMode === column|row` branch below so the grid solver
    // can re-flow.
    const resizedFrameIds = new Set<string>();
    for (const item of cmd.items) {
      const node = state.nodes.find((n) => n.id === item.nodeId);
      if (node && node.type === 'frame') {
        resizedFrameIds.add(node.id);
      }
    }

    const nextNodes = state.nodes.map((n) => {
      const update = updateMap.get(n.id);
      if (!update) return n;

      let updated = n;
      if (update.position) {
        updated = { ...updated, position: update.position };
      }
      if (update.size) {
        const nextStyle = {
          ...updated.style,
          width: update.size.width,
        };

        // A height is authored only when it arrives as a number on a type
        // the user is allowed to pin. `'auto'` is the explicit spelling of
        // renderer ownership; an omitted height means the same thing, and
        // is kept as a synonym because that is what callers have always
        // meant by it.
        const wantsAutoHeight =
          isAlwaysAutoHeightNodeType(updated.type ?? '') ||
          typeof update.size.height !== 'number';
        // Only `toggleable` types (today: `note`) carry a materialized
        // auto height. `text` / `question` are content-driven through a
        // separate mechanism and still express "auto" as the absence of a
        // top-level height; unifying them is a later step, and writing a
        // number here would pin a nominal default over content they size
        // themselves.
        const materializes =
          wantsAutoHeight &&
          getHeightPolicy(updated.type).kind === 'toggleable';

        // Mirror the explicitly-set dimensions into `measured` so the
        // executor's end-of-batch `fitFrames` pass sees the new size.
        // Without this the parent frame would fit to the *previous* size
        // (one step behind) because `getNodeSize` prefers `measured` over
        // `style`, and ReactFlow's ResizeObserver hasn't reconciled the
        // DOM yet at this point. The RO will re-write the same number on
        // the next frame, so there's no jitter.
        const prevMeasured = (updated.measured ?? {}) as {
          width?: number;
          height?: number;
        };
        const nextMeasured: { width?: number; height?: number } = {
          ...prevMeasured,
          width: update.size.width,
        };
        if (wantsAutoHeight) {
          // A content-driven type has no number to offer until it renders;
          // leaving `measured.height` alone avoids briefly collapsing it.
          // For materializing types the height is filled in below.
          delete nextStyle.height;
        } else {
          nextStyle.height = update.size.height as number;
          nextMeasured.height = update.size.height as number;
        }

        updated = {
          ...updated,
          data: withHeightMode(updated, wantsAutoHeight ? 'auto' : 'fixed'),
          style: nextStyle,
          measured: nextMeasured,
        };

        // Handing the height back to the renderer no longer leaves it
        // undefined: the stored measurement hint is materialized into a
        // concrete number right here, so every geometry consumer sees a
        // usable footprint even for a node that has never rendered. When
        // no hint exists yet the policy minimum stands in until a
        // measurement arrives.
        //
        // This also covers a width-only change on an auto note: its
        // content is transform-scaled by `width / refWidth`, so the
        // layout height follows the new width.
        if (materializes) {
          updated = materializeAutoHeight(updated);
        }

        // Track the parent for a *deferred* refit only for types whose
        // height is genuinely unknown until the next render (`text`,
        // `question`). A materializing type already carries a concrete
        // height at this point, so its parent fits synchronously through
        // `affectedFrameIds` below — there is no intermediate frame in
        // which the note and its frame disagree.
        //
        // The parent must also opt into hug sizing; for `sizing: 'manual'`
        // parents there is no refit at all, since the user pinned that
        // size deliberately.
        if (
          wantsAutoHeight &&
          !materializes &&
          updated.parentId &&
          !resizedFrameIds.has(updated.parentId) &&
          getFrameSizing(state.nodes.find((n) => n.id === updated.parentId)) ===
            'hug'
        ) {
          deferredFitFrameIds.add(updated.parentId);
        }
      }
      if (updated.parentId && !resizedFrameIds.has(updated.parentId)) {
        const parent = state.nodes.find((node) => node.id === updated.parentId);
        if (parent?.type === 'canvasRef' || parent?.type === 'frameRef') {
          affectedPortalIds.add(parent.id);
        } else {
          affectedFrameIds.add(updated.parentId);
        }
      }
      // Structured (`column` / `row` / `grid`) frames that were themselves
      // resized must be passed through the end-of-batch grid solver
      // so it re-flows children against the new (manually-pinned)
      // container size. Free-mode frames are deliberately excluded —
      // adding them would cause `fitFrames` to immediately snap the
      // frame back to its children's bounding box, undoing the user's
      // drag.
      const layoutMode = (updated.data as { layoutMode?: string } | undefined)
        ?.layoutMode;
      if (
        updated.type === 'frame' &&
        (layoutMode === 'column' ||
          layoutMode === 'row' ||
          layoutMode === 'grid')
      ) {
        affectedFrameIds.add(updated.id);
      }
      return updated;
    });

    return {
      applied: true,
      nodes: nextNodes,
      edges: state.edges,
      ...(affectedFrameIds.size > 0
        ? { affectedFrameIds: Array.from(affectedFrameIds) }
        : {}),
      ...(affectedPortalIds.size > 0
        ? { affectedPortalIds: Array.from(affectedPortalIds) }
        : {}),
      ...(deferredFitFrameIds.size > 0
        ? { deferredFitFrameIds: Array.from(deferredFitFrameIds) }
        : {}),
    };
  },
};

export default setNodeGeometry;
