// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const DEFAULT_PDF_PAGE_ASPECT_RATIO = 612 / 792;
export const PDF_PAGE_RENDER_CACHE_SIZE = 6;

export type PdfPageVisibilityChange = {
  pageIndex: number;
  isVisible: boolean;
};

export function updateVisiblePdfPages(
  current: ReadonlySet<number>,
  changes: readonly PdfPageVisibilityChange[],
): ReadonlySet<number> {
  const next = new Set(current);
  for (const { pageIndex, isVisible } of changes) {
    if (isVisible) next.add(pageIndex);
    else next.delete(pageIndex);
  }

  if (
    next.size === current.size &&
    [...next].every((pageIndex) => current.has(pageIndex))
  ) {
    return current;
  }
  return next;
}

export function updateRetainedPdfPages(
  current: ReadonlySet<number>,
  changes: readonly PdfPageVisibilityChange[],
  limit = PDF_PAGE_RENDER_CACHE_SIZE,
): ReadonlySet<number> {
  const next = new Set(current);
  for (const { pageIndex, isVisible } of changes) {
    if (!isVisible) continue;
    next.delete(pageIndex);
    next.add(pageIndex);
  }

  while (next.size > limit) {
    const oldest = next.values().next().value as number | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }

  if (
    next.size === current.size &&
    [...next].every((pageIndex) => current.has(pageIndex))
  ) {
    return current;
  }
  return next;
}
