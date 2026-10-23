// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { literalTextMatches } from '@huabu/shared';
import { markdownSearchTarget } from '@huabu/shared/canvas-engine';

export type PdfTextItem = {
  str?: string;
  hasEOL?: boolean;
};

export type PdfPageText = {
  pageIndex: number;
  text: string;
};

export type PdfTextMatch = {
  pageIndex: number;
  pageOccurrenceIndex: number;
  start: number;
  end: number;
};

export function textFromPdfItems(items: readonly PdfTextItem[]): string {
  let text = '';
  for (const item of items) {
    const value = item.str ?? '';
    if (!value) continue;
    if (text && !/\s$/.test(text) && !/^\s/.test(value)) text += ' ';
    text += value;
    if (item.hasEOL) text += '\n';
  }
  return text;
}

export function findPdfTextMatches(
  pages: Iterable<PdfPageText>,
  query: string,
): PdfTextMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: PdfTextMatch[] = [];
  const sortedPages = [...pages].sort((a, b) => a.pageIndex - b.pageIndex);
  for (const page of sortedPages) {
    let pageOccurrenceIndex = 0;
    for (const { start, end } of literalTextMatches(page.text, needle)) {
      matches.push({
        pageIndex: page.pageIndex,
        pageOccurrenceIndex,
        start,
        end,
      });
      pageOccurrenceIndex += 1;
    }
  }
  return matches;
}

export function findPdfSourceMatch(
  pages: Iterable<PdfPageText>,
  query: string,
  markdown: string,
  sourceOffset: number,
  sourceLength = query.length,
): number | null {
  const target = markdownSearchTarget(markdown, sourceOffset, sourceLength);
  if (!target) return null;
  const compact = (text: string): string => text.replace(/\s/g, '');
  const sorted = [...pages].sort((a, b) => a.pageIndex - b.pageIndex);
  if (
    compact(target.text) !== compact(sorted.map((page) => page.text).join(''))
  )
    return null;
  const offset = compact(target.text.slice(0, target.start)).length;
  const pageOffsets = new Map<number, number>();
  let length = 0;
  for (const page of sorted) {
    pageOffsets.set(page.pageIndex, length);
    length += compact(page.text).length;
  }
  const index = findPdfTextMatches(sorted, query).findIndex((match) => {
    const page = sorted.find((entry) => entry.pageIndex === match.pageIndex);
    return (
      page &&
      (pageOffsets.get(page.pageIndex) ?? 0) +
        compact(page.text.slice(0, match.start)).length ===
        offset
    );
  });
  return index < 0 ? null : index;
}
