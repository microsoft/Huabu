// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `APPLY_MEASURED_SIZE` — record the box a renderer measured for a node
 * whose size only a renderer knows (`content` height policy: `text`,
 * `question`, `spacePreview`).
 *
 * Those nodes carry no authored height, so the headless engine can lay a
 * Frame out around them only from what a page reported. The report is
 * written to `data.measuredSize` (persisted, and the proof other pages use
 * to see the size is already reported) and mirrored to `measured`, which
 * `getNodeSize` reads first.
 *
 * Like `APPLY_MEASURED_HEIGHT` it is derived, not authored: `snapshot:
 * 'no'`, unchanged nodes keep their reference, and Frames are not fitted
 * here — the handler declares `affectedFrameIds` for the executor's
 * end-of-batch pass.
 *
 * An item is ignored, not rejected, when its node is gone, is not a
 * renderer-sized type, or when `measuredFor` no longer matches the node:
 * the content or authored width changed after the measurement was taken.
 */

import { noop, type CommandDefinition } from './types.js';
import { measuredSizeKey, readMeasuredSizeHint } from '../height/freshness.js';
import { getHeightPolicy } from '../height/policy.js';

import type { CanvasCommand } from '../../index.js';
import type { MeasuredSizeHint } from '../../types/canvas/node.js';

type Cmd = Extract<CanvasCommand, { type: 'APPLY_MEASURED_SIZE' }>;

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

const applyMeasuredSize: CommandDefinition<Cmd> = {
  meta: {
    snapshot: 'no',
    requiresEdgeReroute: true,
  },

  handler(cmd, state) {
    if (state.source === 'agent') return noop(state, 'invalid-scope');
    if (!Array.isArray(cmd.items) || cmd.items.length === 0)
      return noop(state, 'no-op');

    const updates = new Map(
      cmd.items.map((item) => [item.nodeId as string, item]),
    );
    const affectedFrameIds = new Set<string>();

    let changed = false;
    const nextNodes = state.nodes.map((node) => {
      const update = updates.get(node.id);
      if (!update) return node;
      if (getHeightPolicy(node.type).kind !== 'content') return node;
      if (!isDimension(update.width) || !isDimension(update.height))
        return node;
      if (update.measuredFor !== measuredSizeKey(node)) return node;

      const hint: MeasuredSizeHint = {
        width: update.width,
        height: update.height,
        measuredFor: update.measuredFor,
      };
      const stored = readMeasuredSizeHint(node);
      const measured = node.measured as
        | { width?: number; height?: number }
        | undefined;
      if (
        stored?.width === hint.width &&
        stored.height === hint.height &&
        stored.measuredFor === hint.measuredFor &&
        measured?.width === hint.width &&
        measured?.height === hint.height
      )
        return node;

      changed = true;
      if (node.parentId) affectedFrameIds.add(node.parentId);
      return {
        ...node,
        data: { ...node.data, measuredSize: hint },
        measured: {
          ...(measured ?? {}),
          width: hint.width,
          height: hint.height,
        },
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
    };
  },
};

export default applyMeasuredSize;
