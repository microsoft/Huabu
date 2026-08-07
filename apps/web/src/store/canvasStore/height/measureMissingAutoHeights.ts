// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * On-demand height measurement for a fixed → auto toggle.
 *
 * A pinned note has no usable measurement of its own. It renders inside
 * a box the user chose, so nothing it reports there is a trustworthy
 * intrinsic content height — and a wrong hint would be *self-confirming*,
 * because materializing it produces exactly the number the next
 * measurement is compared against, so the error would never be
 * corrected.
 *
 * Measuring offscreen sidesteps that entirely: the content is laid out
 * at the type's reference width with nothing constraining it. It also
 * works for a note zoomed out far enough never to have hydrated, which
 * is precisely the case where the collapse-then-expand was most visible.
 */

import {
  autoHeightKey,
  getHeightPolicy,
  readAutoHeightHint,
} from '@huabu/shared/canvas-engine';

import { measureNoteHeightOffscreen } from '@/components/Nodes/shared/height/measure/offscreenMeasurer';

import type {
  CanvasNodeId,
  CanvasNodeMeasuredHeightUpdate,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

/** Give up rather than leave the toggle hanging on a slow measurement. */
const TOGGLE_MEASURE_BUDGET_MS = 1200;

interface StoreSlice {
  nodes: Node[];
  canvasId: string;
}

/**
 * Measure any of `nodeIds` whose stored hint would not survive the
 * toggle. Returns items ready for `APPLY_MEASURED_HEIGHT`; notes that are
 * already measured contribute nothing and cost nothing.
 */
export async function measureMissingAutoHeights(
  nodeIds: string[],
  getState: () => StoreSlice,
): Promise<CanvasNodeMeasuredHeightUpdate[]> {
  if (nodeIds.length === 0) return [];

  const targets = collectTargets(nodeIds, getState().nodes);
  if (targets.length === 0) return [];

  const canvasId = getState().canvasId;
  const deadline = Date.now() + TOGGLE_MEASURE_BUDGET_MS;
  const measured: CanvasNodeMeasuredHeightUpdate[] = [];

  for (const target of targets) {
    if (Date.now() >= deadline) break;
    try {
      const result = await measureNoteHeightOffscreen({
        markdown: target.markdown,
        canvasId,
      });
      if (result.height <= 0) continue;
      measured.push({
        nodeId: target.nodeId as CanvasNodeId,
        intrinsicHeight: result.height,
        measuredFor: target.measuredFor,
        ...(result.provisional ? { provisional: true } : {}),
      });
    } catch {
      // The toggle still applies; the node falls back to its policy
      // minimum and the in-place measurer corrects it once mounted.
    }
  }

  return measured;
}

interface Target {
  nodeId: string;
  markdown: string;
  measuredFor: string;
}

function collectTargets(nodeIds: string[], nodes: Node[]): Target[] {
  const wanted = new Set(nodeIds);
  const targets: Target[] = [];

  for (const node of nodes) {
    if (!wanted.has(node.id)) continue;
    if (getHeightPolicy(node.type).kind !== 'toggleable') continue;
    if (readAutoHeightHint(node).freshness === 'current') continue;

    const content = (node.data as { content?: unknown } | undefined)?.content;
    if (typeof content !== 'string') continue;

    targets.push({
      nodeId: node.id,
      markdown: content,
      measuredFor: autoHeightKey(node),
    });
  }

  return targets;
}
