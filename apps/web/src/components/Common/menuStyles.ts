// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** List chrome only; positioning, width, and scrolling remain caller-owned. */
export const MENU_SURFACE_CLASS = 'rounded-lg px-1 py-1.5';

export const MENU_ITEM_CLASS =
  'text-fg-muted flex min-h-8 w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 font-normal transition-colors enabled:hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-info-light disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.65]';

export const MENU_LABEL_CLASS =
  'min-w-0 flex-1 text-left [overflow-wrap:anywhere] whitespace-normal';

export const MENU_ICON_CLASS = 'shrink-0 text-inherit';

export const MENU_HINT_CLASS =
  'text-fg-subtle ml-3 shrink-0 text-xs font-normal';

export const MENU_CHECK_CLASS =
  'text-info ml-auto flex w-3.5 shrink-0 justify-center';

export const MENU_SECTION_LABEL_CLASS =
  'text-fg-subtle px-2 py-1 text-left text-xs leading-[18px] font-normal select-none';

export const MENU_SEPARATOR_CLASS = 'bg-edge-default my-1 h-px shrink-0';
