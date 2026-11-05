// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mergeLineRects } from '@/handler/pdfHighlight/highlight';

import type { Rect } from '@/handler/pdfHighlight/highlight';
import type { PdfHighlight } from '@huabu/shared';

export interface PdfTextSelection {
  text: string;
  position: { x: number; y: number };
  rects: Map<number, Rect[]>;
  highlightId?: string;
}

export function readPdfSelection(
  root: HTMLElement,
  selection: Selection | null,
): PdfTextSelection | null {
  if (
    !selection?.rangeCount ||
    !selection.toString().trim() ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return null;
  const range = selection.getRangeAt(0);
  const pages = root.querySelectorAll<HTMLElement>('[data-pdf-page-index]');
  const rects = new Map<number, Rect[]>();
  let last: DOMRect | undefined;
  for (const rect of range.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    for (const page of pages) {
      const bounds = page.getBoundingClientRect();
      if (
        !bounds.width ||
        !bounds.height ||
        rect.top < bounds.top - 2 ||
        rect.bottom > bounds.bottom + 2 ||
        rect.left < bounds.left - 2 ||
        rect.right > bounds.right + 2
      )
        continue;
      const index = Number(page.dataset.pdfPageIndex);
      const values = rects.get(index) ?? [];
      values.push({
        x: (rect.left - bounds.left) / bounds.width,
        y: (rect.top - bounds.top) / bounds.height,
        width: rect.width / bounds.width,
        height: rect.height / bounds.height,
      });
      rects.set(index, values);
      last = rect;
      break;
    }
  }
  for (const [index, values] of rects) {
    const merged = mergeLineRects(values);
    if (merged.length) rects.set(index, merged);
    else rects.delete(index);
  }
  return last && rects.size
    ? {
        text: selection.toString().trim(),
        rects,
        position: { x: last.right, y: last.bottom },
      }
    : null;
}

/** Recover legacy annotations from rendered glyph geometry rather than inventing quotations. */
export function readPdfHighlightText(
  page: HTMLElement,
  highlight: PdfHighlight,
): string {
  const layer = page.querySelector('.textLayer');
  if (!layer) return '';
  const bounds = page.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return '';
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let text = '';
  let previous: { rect: DOMRect; node: Node } | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      const x = (rect.left + rect.width / 2 - bounds.left) / bounds.width;
      const y = (rect.top + rect.height / 2 - bounds.top) / bounds.height;
      if (
        rect.width > 0 &&
        highlight.rects.some(
          (r) =>
            x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
        )
      ) {
        const character = node.textContent?.[index] ?? '';
        if (
          previous &&
          previous.node !== node &&
          !/\s$/.test(text) &&
          !/^\s/.test(character)
        ) {
          const height = Math.min(previous.rect.height, rect.height);
          const overlap =
            Math.min(previous.rect.bottom, rect.bottom) -
            Math.max(previous.rect.top, rect.top);
          const gap = Math.max(
            rect.left - previous.rect.right,
            previous.rect.left - rect.right,
          );
          // DOM spans can split a word; only visual line breaks or word gaps add separators.
          if (overlap < height / 2) text += '\n';
          else if (gap > height * 0.2) text += ' ';
        }
        text += character;
        previous = { rect, node };
      }
    }
  }
  return text.trim();
}
