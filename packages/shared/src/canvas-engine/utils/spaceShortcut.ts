// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Node } from '@xyflow/react';

export const SPACE_SHORTCUT_SIZE = {
  minWidth: 240,
  defaultWidth: 400,
  defaultHeight: 120,
  autoMaxHeight: 152,
} as const;

export function spaceShortcutScale(data: Record<string, unknown>): number {
  const style = data.style;
  const font =
    style && typeof style === 'object' && 'fontSize' in style
      ? style.fontSize
      : undefined;
  return typeof font === 'number' && Number.isFinite(font) && font > 0
    ? font / 24
    : 1;
}

export function clampSpaceShortcutWidth(width: number, scale = 1): number {
  return Math.max(SPACE_SHORTCUT_SIZE.minWidth * scale, width);
}

/** Preserve legacy positions and widths, but release the old preview height. */
export function normalizeSpaceShortcut(node: Node): Node {
  if (node.type !== 'spacePreview') return node;
  const scale = spaceShortcutScale(node.data);
  const width =
    typeof node.style?.width === 'number' && Number.isFinite(node.style.width)
      ? clampSpaceShortcutWidth(node.style.width, scale)
      : SPACE_SHORTCUT_SIZE.defaultWidth * scale;
  const widthMode = 'fixed';
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
