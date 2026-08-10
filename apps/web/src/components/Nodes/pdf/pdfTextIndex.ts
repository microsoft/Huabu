// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
    if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
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
    const haystack = page.text.toLowerCase();
    let from = 0;
    let pageOccurrenceIndex = 0;
    while (from < haystack.length) {
      const start = haystack.indexOf(needle, from);
      if (start === -1) break;
      matches.push({
        pageIndex: page.pageIndex,
        pageOccurrenceIndex,
        start,
        end: start + needle.length,
      });
      pageOccurrenceIndex += 1;
      from = start + Math.max(1, needle.length);
    }
  }
  return matches;
}
