// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Load-time height normalization.
 *
 * Pure functions only — no timers, no I/O, no store dependency. Imported
 * by `canvasStore.loadCanvas` and applied to the freshly-fetched node
 * list before it is committed to the store.
 *
 * ## Why this exists
 *
 * Height ownership used to be encoded as the *absence* of a top-level
 * `style.height`, which cannot distinguish "the renderer owns this" from
 * "nobody has measured it yet". `data.heightMode` says it outright. This
 * pass writes that field for nodes persisted before it existed, inferring
 * the owner exactly once from the legacy encoding.
 *
 * It then materializes each auto node's stored measurement hint into
 * `style.height`, so a node has a real footprint before it has ever
 * rendered. That is what stops layout, snapping, and frame fitting from
 * depending on whether a node happened to be mounted.
 *
 * ## What it deliberately does not do
 *
 * It never writes `data.autoHeight`. A hint may only claim a key that a
 * measurement actually produced it under, so a canvas whose notes have
 * never been measured normalizes to the policy minimum and is corrected
 * later by a real measurement. Carrying the legacy `data.measuredHeight`
 * forward would mean fabricating provenance for a number that may
 * describe content an agent has since rewritten.
 *
 * It also leaves `text` / `question` nodes alone. Those types size
 * themselves through a separate mechanism that still expresses "auto" as
 * the absence of a height; writing a nominal default over content they
 * measure themselves would be a regression, and folding them into this
 * model is a later step.
 */

import {
  getHeightPolicy,
  materializeAutoHeight,
  resolveHeightMode,
} from '@huabu/shared/canvas-engine';

import type { Node } from '@xyflow/react';

/**
 * Give every toggleable-height node an explicit owner and a numeric
 * layout height.
 *
 * Returns the same array reference when nothing changed, so a canvas
 * already normalized on a previous save costs one walk and no re-render.
 */
export function normalizeNodeHeights(nodes: Node[]): Node[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (getHeightPolicy(node.type).kind !== 'toggleable') return node;

    let updated = node;
    const data = (node.data ?? {}) as { heightMode?: unknown };
    if (data.heightMode !== 'auto' && data.heightMode !== 'fixed') {
      // `resolveHeightMode` owns the legacy inference; recording its
      // answer here is what retires that fallback for this node.
      updated = {
        ...updated,
        data: { ...updated.data, heightMode: resolveHeightMode(node) },
      };
    }

    updated = materializeAutoHeight(updated);
    if (updated !== node) changed = true;
    return updated;
  });

  return changed ? next : nodes;
}
