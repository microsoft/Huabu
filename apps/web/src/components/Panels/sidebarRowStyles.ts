// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The look of a row in the canvas sidebar, shared by the Layers tree, canvas
 * search results and the Files tree so the tabs read as one surface. Action
 * buttons reveal on hover of an ancestor carrying `group/sidebar-row`.
 */

export const SIDEBAR_ROW_INSET_CLASS = 'px-2 py-px';
export const SIDEBAR_ROW_SURFACE_CLASS =
  'rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-info';
export const SIDEBAR_ROW_ICON_CLASS = 'text-fg-subtle';
export const SIDEBAR_ROW_SELECTED_FOREGROUND_CLASS = 'text-info-fg';
export const SIDEBAR_ROW_ACTION_CLASS =
  'text-fg-subtle enabled:hover:text-fg-default opacity-0 transition-opacity group-hover/sidebar-row:opacity-100 group-focus-within/sidebar-row:opacity-100';

export function sidebarRowBackground({
  selected = false,
  highlighted = false,
  dragActive = false,
}: {
  selected?: boolean;
  highlighted?: boolean;
  dragActive?: boolean;
}): string {
  if (selected) return 'bg-info-bg enabled:hover:bg-info-bg hover:bg-info-bg';
  if (highlighted) return 'bg-hover ring-1 ring-inset ring-info';
  return dragActive ? '' : 'hover:bg-hover enabled:hover:bg-hover';
}
