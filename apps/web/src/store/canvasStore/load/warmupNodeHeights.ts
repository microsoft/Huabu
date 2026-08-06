// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Load-time height warmup.
 *
 * Normalization gives every auto note a numeric height, but a note that
 * has never been measured only gets its policy minimum. On a canvas
 * saved before the height model existed that is *every* note, so the
 * first open would paint a wall of collapsed cards and then expand them
 * one by one as they mount — precisely the behaviour this whole model
 * exists to remove, reintroduced as a one-time event.
 *
 * So measure them before the canvas is shown, not after. The load is
 * already displaying a loading state; spending a bounded slice of it on
 * measurement trades a moment of waiting for a canvas that is correct on
 * its first frame.
 *
 * Three properties keep the cost honest:
 *
 * - **Only never-measured notes.** A `stale` hint still carries a real
 *   number and paints plausibly; correcting it can wait for the prewarm
 *   queue. A `missing` one cannot.
 * - **Ordered by the restored viewport**, so if the budget runs out it is
 *   the far-away notes that miss it.
 * - **Hard budget.** Whatever is not measured falls through to the
 *   prewarm queue exactly as before. A slow canvas opens late-corrected,
 *   never late.
 *
 * A canvas whose notes are already measured pays one array walk.
 */

import {
  applySharedPostEffectsFromWriteResult,
  autoHeightKey,
  executeCanvasCommands,
  getHeightPolicy,
  readAutoHeightHint,
  resolveHeightMode,
} from '@huabu/shared/canvas-engine';

import { measureNoteHeightOffscreen } from '@/components/Nodes/shared/height/measure/offscreenMeasurer';

import type {
  CanvasNodeId,
  CanvasNodeMeasuredHeightUpdate,
} from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

/**
 * Wall-clock budget for the whole warmup. Sized to be unnoticeable next
 * to the canvas fetch it runs after, while still covering a screenful of
 * notes on a first open.
 */
const DEFAULT_BUDGET_MS = 900;

export interface WarmupOptions {
  canvasId: string;
  edges: Edge[];
  /** Canvas-space point the user will be looking at. */
  centre: { x: number; y: number };
  budgetMs?: number;
}

export interface WarmupResult {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Measure never-measured auto notes and fold the results into the node
 * array through the pure canvas executor. Preserves the input node and
 * edge array references when there was nothing to do.
 */
export async function warmupNodeHeights(
  nodes: Node[],
  options: WarmupOptions,
): Promise<WarmupResult> {
  const targets = collectUnmeasured(nodes, options.centre);
  if (targets.length === 0) return { nodes, edges: options.edges };

  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const measurements: CanvasNodeMeasuredHeightUpdate[] = [];

  for (const target of targets) {
    if (Date.now() >= deadline) break;
    try {
      const measured = await measureNoteHeightOffscreen({
        markdown: target.markdown,
        canvasId: options.canvasId,
      });
      if (measured.height <= 0) continue;
      measurements.push({
        nodeId: target.nodeId as CanvasNodeId,
        intrinsicHeight: measured.height,
        measuredFor: target.measuredFor,
        ...(measured.provisional ? { provisional: true } : {}),
      });
    } catch {
      // Leave the node at its policy minimum; the prewarm queue will
      // retry it once the canvas is interactive.
    }
  }

  if (measurements.length === 0) return { nodes, edges: options.edges };

  const { writeResult } = executeCanvasCommands(
    {
      source: 'system',
      commands: [{ type: 'APPLY_MEASURED_HEIGHT', items: measurements }],
    },
    { nodes, edges: options.edges, canvasId: options.canvasId },
  );
  const sharedOut = applySharedPostEffectsFromWriteResult(writeResult);
  return { nodes: writeResult.nodes, edges: sharedOut.edges };
}

export interface WarmupTarget {
  nodeId: string;
  markdown: string;
  measuredFor: string;
  distance: number;
}

/**
 * Never-measured auto notes, nearest to the restored viewport first.
 *
 * Pure, and the only part of the warmup worth testing: whether the
 * budget covered a given canvas is a runtime property, but *which* nodes
 * are eligible and in what order is a rule.
 */
export function collectUnmeasured(
  nodes: readonly Node[],
  centre: { x: number; y: number },
): WarmupTarget[] {
  const targets: WarmupTarget[] = [];

  for (const node of nodes) {
    if (getHeightPolicy(node.type).kind !== 'toggleable') continue;
    if (resolveHeightMode(node) !== 'auto') continue;
    if (readAutoHeightHint(node).freshness !== 'missing') continue;

    const content = (node.data as { content?: unknown } | undefined)?.content;
    if (typeof content !== 'string') continue;

    targets.push({
      nodeId: node.id,
      markdown: content,
      measuredFor: autoHeightKey(node),
      distance: Math.hypot(
        node.position.x - centre.x,
        node.position.y - centre.y,
      ),
    });
  }

  targets.sort((a, b) => a.distance - b.distance);
  return targets;
}
