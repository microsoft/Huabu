// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Selection bounding-box helpers.
 *
 * Shared between the multi-select toolbar (anchor positioning) and the
 * multi-select resizer (outline + handles). Previously each surface
 * reimplemented the bounds math with slightly different size fallbacks,
 * which made it easy for the two to disagree on what "the selection
 * box" meant.
 */

import { getNodeSize } from './nodeSizes.js';
import { getAbsolutePosition, type NestableNode } from '../frame/index.js';

import type { Node } from '@xyflow/react';

/**
 * Default fallback size (px) used when a selected node has no measured
 * dimension and no `style` width/height yet (e.g. brand-new node still
 * being mounted). Matches the historical defaults in both call sites.
 */
const DEFAULT_FALLBACK_WIDTH = 200;
const DEFAULT_FALLBACK_HEIGHT = 100;

export interface SelectionBounds {
  /** Top-left corner in absolute flow coordinates. */
  minX: number;
  minY: number;
  /** Bottom-right corner in absolute flow coordinates. */
  maxX: number;
  maxY: number;
  /** Convenience: maxX - minX. */
  width: number;
  /** Convenience: maxY - minY. */
  height: number;
}

/**
 * Compute the axis-aligned bounding box of `selectedNodes` in absolute
 * (flow) coordinates. `allNodes` is required so nested-frame children
 * can be resolved via `getAbsolutePosition`.
 *
 * Returns `null` when `selectedNodes` is empty.
 */
export function getSelectionBounds(
  selectedNodes: readonly Node[],
  allNodes: readonly Node[],
): SelectionBounds | null {
  if (selectedNodes.length === 0) return null;

  const nestable = allNodes as NestableNode[];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of selectedNodes) {
    const abs = getAbsolutePosition(nestable, node.id) ?? node.position;
    const { width, height } = getNodeSize(node);
    const w = width > 0 ? width : DEFAULT_FALLBACK_WIDTH;
    const h = height > 0 ? height : DEFAULT_FALLBACK_HEIGHT;

    if (abs.x < minX) minX = abs.x;
    if (abs.y < minY) minY = abs.y;
    if (abs.x + w > maxX) maxX = abs.x + w;
    if (abs.y + h > maxY) maxY = abs.y + h;
  }

  if (!Number.isFinite(minX)) return null;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
