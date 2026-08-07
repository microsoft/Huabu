// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `APPLY_MEASURED_HEIGHT` — write a completed content measurement onto an
 * auto-height node.
 *
 * This is the *derived* half of the height model; `SET_NODE_GEOMETRY` is
 * the authored half. The split is by authorship rather than by value:
 * both end up writing a number into `style.height`, but only one of them
 * represents a user intent. Consequences encoded here:
 *
 *  - `snapshot: 'no'` — a measurement is not an action, so it never
 *    creates an undo entry.
 *  - The hint and the geometry it implies are written in a single step, so
 *    a node can never carry a height whose provenance disagrees with it.
 *  - Unchanged nodes keep their original object reference, and a no-op
 *    batch returns the original array. This command runs far more often
 *    than any authored one (the prewarm queue commits in bulk), and every
 *    downstream `React.memo` / xyflow reconciliation depends on identity.
 *
 * Frame refitting is *not* done here: the handler only declares
 * `affectedFrameIds` and lets the executor run one end-of-batch
 * `fitFrames` pass, so a bulk commit produces a single refit rather than
 * one per node.
 */

import { noop, type CommandDefinition } from './types.js';
import { intrinsicToLayoutHeight } from '../height/compute.js';
import { autoHeightKey } from '../height/freshness.js';
import { resolveHeightMode } from '../height/policy.js';

import type { CanvasCommand } from '../../index.js';
import type { AutoHeightHint } from '../../types/canvas/node.js';
import type { Node } from '@xyflow/react';

type Cmd = Extract<CanvasCommand, { type: 'APPLY_MEASURED_HEIGHT' }>;

const applyMeasuredHeight: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'no',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (cmd.items.length === 0) return noop(state, 'no-op');

    const updates = new Map(
      cmd.items.map((item) => [item.nodeId as string, item]),
    );
    const affectedFrameIds = new Set<string>();
    const affectedPortalIds = new Set<string>();

    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      const update = updates.get(node.id);
      if (!update) return node;

      // A measurement that lands after the user pinned the node, or on a
      // type that never auto-sizes, describes a state that no longer
      // exists. Dropping it is correct, not an error.
      if (resolveHeightMode(node) !== 'auto') return node;
      // Content may change while an offscreen or queued measurement is in
      // flight. Never stamp that old result with authority over the live
      // node: the next measurement will carry its current key.
      if (update.measuredFor !== autoHeightKey(node)) return node;
      if (
        !Number.isFinite(update.intrinsicHeight) ||
        update.intrinsicHeight <= 0
      ) {
        return node;
      }

      const hint: AutoHeightHint = {
        intrinsicHeight: update.intrinsicHeight,
        measuredFor: update.measuredFor,
        ...(update.provisional ? { provisional: true } : {}),
      };

      const style = (node.style ?? {}) as Record<string, unknown>;
      const width = typeof style.width === 'number' ? style.width : undefined;
      const height = intrinsicToLayoutHeight(
        update.intrinsicHeight,
        node.type,
        width,
      );

      const measured = node.measured as
        | { width?: number; height?: number }
        | undefined;
      if (
        style.height === height &&
        measured?.height === height &&
        isSameHint(node, hint)
      ) {
        return node;
      }

      changed = true;
      trackParent(node, state.nodes, affectedFrameIds, affectedPortalIds);

      return {
        ...node,
        data: { ...node.data, autoHeight: hint },
        style: { ...style, height },
        // `getNodeSize` resolves `measured` before `style`, and the
        // executor's `fitFrames` pass runs before ReactFlow's
        // ResizeObserver has reconciled the DOM. Without this mirror the
        // parent frame would fit to the previous height.
        measured: { ...(measured ?? {}), height },
      };
    });

    if (!changed) return noop(state, 'no-op');

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
    };
  },
};

function isSameHint(node: Node, hint: AutoHeightHint): boolean {
  const stored = (node.data as { autoHeight?: AutoHeightHint } | undefined)
    ?.autoHeight;
  return (
    stored?.intrinsicHeight === hint.intrinsicHeight &&
    stored?.measuredFor === hint.measuredFor &&
    Boolean(stored?.provisional) === Boolean(hint.provisional)
  );
}

function trackParent(
  node: Node,
  nodes: readonly Node[],
  frameIds: Set<string>,
  portalIds: Set<string>,
): void {
  if (!node.parentId) return;
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  if (parent?.type === 'canvasRef' || parent?.type === 'frameRef') {
    portalIds.add(parent.id);
  } else {
    frameIds.add(node.parentId);
  }
}

export default applyMeasuredHeight;
