// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const LAYER_ROW_INSET_CLASS = 'px-2 py-px';
export const LAYER_ROW_SURFACE_CLASS =
  'rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-info';
export const LAYER_ROW_ICON_CLASS = 'text-fg-subtle';
export const LAYER_ROW_SELECTED_FOREGROUND_CLASS = 'text-info';
export const LAYER_ROW_ACTION_CLASS =
  'text-fg-subtle enabled:hover:text-fg-default opacity-0 transition-opacity group-hover/layer-row:opacity-100 group-focus-within/layer-row:opacity-100';

export function layerRowBackground({
  selected = false,
  highlighted = false,
  dragActive = false,
}: {
  selected?: boolean;
  highlighted?: boolean;
  dragActive?: boolean;
}): string {
  if (selected) return 'bg-info-bg enabled:hover:bg-info-bg hover:bg-info-bg';
  if (highlighted) return 'bg-info-bg/50';
  return dragActive ? '' : 'hover:bg-hover enabled:hover:bg-hover';
}
