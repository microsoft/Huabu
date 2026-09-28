// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getDescendantIds } from '@huabu/shared/canvas-engine';

import type { NestableNode } from '@huabu/shared/canvas-engine';
import type { CSSProperties } from 'react';

/** Presentation-only elevation over assignNodeZIndices; never reorder source nodes. */
export function selectionZOrder(
  nodes: NestableNode[],
  baseZ: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  let selected: NestableNode | undefined;
  for (const node of nodes) {
    if (!node.selected) continue;
    if (selected) return baseZ;
    selected = node;
  }
  if (!selected) return baseZ;

  // Use the same normalized forest as the canonical container helpers.
  // A Frame's descendants must stay above its raised background. Selecting
  // a child raises only that subtree, never its ancestors or sibling branches.
  const elevatedIds = new Set([
    selected.id,
    ...getDescendantIds(nodes, selected.id),
  ]);
  let offset = 0;
  for (const z of baseZ.values()) offset = Math.max(offset, z + 1);
  const result = new Map(baseZ);
  for (const id of elevatedIds) {
    result.set(id, (baseZ.get(id) ?? 0) + offset);
  }
  return result;
}

const stylesWithoutZIndex = new WeakMap<CSSProperties, CSSProperties>();

/** React Flow spreads style AFTER internals.z; leave the root prop authoritative. */
export function withoutNodeStyleZIndex(
  style: CSSProperties | undefined,
): CSSProperties | undefined {
  if (!style || !('zIndex' in style)) return style;
  const cached = stylesWithoutZIndex.get(style);
  if (cached) return cached;
  const { zIndex: _zIndex, ...rest } = style;
  stylesWithoutZIndex.set(style, rest);
  return rest;
}
