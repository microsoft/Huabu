// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { PdfHighlight } from '@huabu/shared';

/** Normalized rectangle: all values 0–1, relative to the page. */
export type Rect = { x: number; y: number; width: number; height: number };

const TOL = 0.005;
const MIN_DIM = 0.002;

/**
 * Filter out zero-dimension rects, then merge rects that sit on the
 * same horizontal line (overlapping y-ranges) into single bounding rects.
 *
 * pdf.js text-layer spans often produce near-duplicate clientRects for the
 * same line of text — this collapses them so only one highlight rect per
 * visual line is stored.
 */
export function mergeLineRects(rects: Rect[]): Rect[] {
  // 1. Drop rects with negligible width or height.
  const valid = rects.filter((r) => r.width > MIN_DIM && r.height > MIN_DIM);
  if (valid.length === 0) return [];

  // 2. Sort top-to-bottom, left-to-right.
  valid.sort((a, b) => a.y - b.y || a.x - b.x);

  // 3. Greedily merge rects whose vertical ranges overlap significantly
  //    (more than 50% of the shorter rect's height).
  const merged: Rect[] = [{ ...valid[0] }];
  for (let i = 1; i < valid.length; i++) {
    const cur = valid[i];
    const last = merged[merged.length - 1];

    const overlapTop = Math.max(last.y, cur.y);
    const overlapBot = Math.min(last.y + last.height, cur.y + cur.height);
    const overlapH = overlapBot - overlapTop;
    const minH = Math.min(last.height, cur.height);

    if (overlapH > minH * 0.5) {
      // Same visual line — expand bounding box.
      const x1 = Math.min(last.x, cur.x);
      const y1 = Math.min(last.y, cur.y);
      const x2 = Math.max(last.x + last.width, cur.x + cur.width);
      const y2 = Math.max(last.y + last.height, cur.y + cur.height);
      last.x = x1;
      last.y = y1;
      last.width = x2 - x1;
      last.height = y2 - y1;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Check whether two rects overlap (with tolerance). */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width + TOL &&
    a.x + a.width > b.x - TOL &&
    a.y < b.y + b.height + TOL &&
    a.y + a.height > b.y - TOL
  );
}

/**
 * Subtract rect `b` from rect `a`.
 * Returns 0–4 remaining pieces of `a` that are NOT covered by `b`.
 */
export function subtractRect(a: Rect, b: Rect): Rect[] {
  if (!overlaps(a, b)) return [a];

  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);

  const pieces: Rect[] = [];
  // Top strip
  if (iy1 - a.y > MIN_DIM)
    pieces.push({ x: a.x, y: a.y, width: a.width, height: iy1 - a.y });
  // Bottom strip
  if (a.y + a.height - iy2 > MIN_DIM)
    pieces.push({
      x: a.x,
      y: iy2,
      width: a.width,
      height: a.y + a.height - iy2,
    });
  // Left strip (between intersection top & bottom)
  if (ix1 - a.x > MIN_DIM)
    pieces.push({ x: a.x, y: iy1, width: ix1 - a.x, height: iy2 - iy1 });
  // Right strip (between intersection top & bottom)
  if (a.x + a.width - ix2 > MIN_DIM)
    pieces.push({
      x: ix2,
      y: iy1,
      width: a.x + a.width - ix2,
      height: iy2 - iy1,
    });
  return pieces;
}

/**
 * Subtract a set of cutter rects from a single source rect.
 * Iteratively subtracts each cutter from all current fragments.
 */
export function subtractAll(source: Rect, cutters: Rect[]): Rect[] {
  let fragments: Rect[] = [source];
  for (const cutter of cutters) {
    fragments = fragments.flatMap((f) => subtractRect(f, cutter));
  }
  return fragments;
}

/**
 * Compute an updated highlights array after the user selects new rects.
 *
 * - If the selection is fully covered by existing highlights → subtract
 *   the selection from existing rects (toggle-off / shrink).
 * - Otherwise → add only the genuinely new fragments that aren't already
 *   covered by existing highlights.
 *
 * @param highlights Current persistent highlights.
 * @param selectionByPage Map of page index → normalized rects from the user's selection.
 * @returns The new highlights array.
 */
export function computeHighlightUpdate(
  highlights: PdfHighlight[],
  selectionByPage: Map<number, Rect[]>,
): PdfHighlight[] {
  // Determine whether every selection rect is already fully covered.
  let allCovered = true;
  for (const [pageIdx, newRects] of selectionByPage) {
    const existingRects = highlights
      .filter((h) => h.pageIndex === pageIdx)
      .flatMap((h) => h.rects);
    for (const nr of newRects) {
      if (subtractAll(nr, existingRects).length > 0) {
        allCovered = false;
        break;
      }
    }
    if (!allCovered) break;
  }

  if (allCovered) {
    // Toggle-off: subtract the selection rects from existing highlights.
    const pagesInSelection = new Set(selectionByPage.keys());
    return highlights.flatMap((hl) => {
      if (!pagesInSelection.has(hl.pageIndex)) return [hl];
      const selRects = selectionByPage.get(hl.pageIndex);
      if (!selRects) return [hl];

      const remaining = hl.rects.flatMap((er) => subtractAll(er, selRects));
      if (remaining.length === 0) return [];
      return [{ ...hl, rects: remaining }];
    });
  }

  // Add mode: subtract existing highlights from each new rect.
  const newHighlights: PdfHighlight[] = [];
  for (const [pageIndex, newRects] of selectionByPage) {
    const existingRects = highlights
      .filter((h) => h.pageIndex === pageIndex)
      .flatMap((h) => h.rects);

    const fragments = newRects.flatMap((nr) => subtractAll(nr, existingRects));

    if (fragments.length > 0) {
      newHighlights.push({
        id: crypto.randomUUID(),
        pageIndex,
        rects: fragments,
      });
    }
  }
  return [...highlights, ...newHighlights];
}
