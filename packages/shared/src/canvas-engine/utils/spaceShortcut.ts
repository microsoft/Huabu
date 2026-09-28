// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Node } from '@xyflow/react';

export const SPACE_SHORTCUT_SIZE = {
  minWidth: 240,
  autoMaxWidth: 480,
  defaultWidth: 360,
  defaultHeight: 102,
  autoMaxHeight: 138,
} as const;

export function clampSpaceShortcutWidth(width: number): number {
  return Math.max(SPACE_SHORTCUT_SIZE.minWidth, width);
}

/** Preserve legacy positions and widths, but release the old preview height. */
export function normalizeSpaceShortcut(node: Node): Node {
  if (node.type !== 'spacePreview') return node;
  const width =
    typeof node.style?.width === 'number' && Number.isFinite(node.style.width)
      ? clampSpaceShortcutWidth(node.style.width)
      : SPACE_SHORTCUT_SIZE.defaultWidth;
  const widthMode = node.data.widthMode === 'auto' ? 'auto' : 'fixed';
  if (
    node.style?.width === width &&
    node.style.height === undefined &&
    node.data.widthMode === widthMode
  )
    return node;
  const { height: _height, ...style } = node.style ?? {};
  const { height: _measuredHeight, ...measured } = node.measured ?? {};
  return {
    ...node,
    data: { ...node.data, widthMode },
    style: { ...style, width },
    measured: { ...measured, width },
  };
}
