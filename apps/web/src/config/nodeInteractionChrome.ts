// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Shared screen-space stroke for individual and group selection outlines. */
export const NODE_SELECTION_CHROME = {
  width: 1.5,
  color: 'var(--color-info)',
  dashArray: '4 3',
} as const;

/** Shared idle paint and screen-space dimensions for node interaction controls. */
export const NODE_CONTROL_CHROME = {
  size: { mouse: 8, touch: 14 },
  hitSize: { mouse: 20, touch: 28 },
  style: {
    backgroundColor: 'var(--color-info-light)',
    border: 0,
    opacity: 1,
    boxSizing: 'border-box',
  },
} as const;

/** Outlined resize controls contrast with solid connection dots. */
export const NODE_RESIZE_GRIP_STYLE = {
  ...NODE_CONTROL_CHROME.style,
  backgroundColor: 'var(--color-surface)',
  // Inset spread preserves fractional CSS-pixel width without border snapping.
  boxShadow: `inset 0 0 0 ${NODE_SELECTION_CHROME.width}px ${NODE_SELECTION_CHROME.color}`,
} as const;

/** Screen-space connection geometry shared by ports and the selected-node toolbar. */
export const NODE_CONNECTION_CHROME = {
  outwardOffset: 16,
  dotSize: NODE_CONTROL_CHROME.size,
  hitSize: NODE_CONTROL_CHROME.hitSize,
  hotSize: { mouse: 20, touch: 22 },
  toolbarGap: 8,
} as const;

export function nodeToolbarOffset(isNotMouse: boolean): number {
  const pointer = isNotMouse ? 'touch' : 'mouse';
  const { outwardOffset, hitSize, dotSize, hotSize, toolbarGap } =
    NODE_CONNECTION_CHROME;
  // Extra hit space extends outward from the idle dot, not around its center.
  return (
    outwardOffset +
    Math.max(hitSize[pointer] - dotSize[pointer] / 2, hotSize[pointer] / 2) +
    toolbarGap
  );
}
