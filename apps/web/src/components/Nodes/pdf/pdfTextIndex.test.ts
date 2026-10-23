// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  findPdfTextMatches,
  textFromPdfItems,
  findPdfSourceMatch,
} from './pdfTextIndex';

describe('PDF text index', () => {
  it('does not double explicit whitespace items between text-layer words', () => {
    const text = textFromPdfItems([
      { str: 'Paragraph' },
      { str: ' ' },
      { str: 'needle' },
      { str: ' ' },
      { str: 'phrase' },
    ]);
    expect(text).toBe('Paragraph needle phrase');
    expect(
      findPdfTextMatches([{ pageIndex: 0, text }], 'needle phrase'),
    ).toEqual([{ pageIndex: 0, pageOccurrenceIndex: 0, start: 10, end: 23 }]);
  });
  it('maps a visible source address independently of hidden Markdown occurrences', () => {
    const source = '[needle](https://example.test/needle)\n\nParagraph needle';
    const pages = [{ pageIndex: 0, text: 'needle\nParagraph needle' }];
    expect(
      findPdfSourceMatch(pages, 'needle', source, source.indexOf('needle', 10)),
    ).toBeNull();
    expect(
      findPdfSourceMatch(pages, 'needle', source, source.lastIndexOf('needle')),
    ).toBe(1);
    expect(
      findPdfSourceMatch(
        [{ pageIndex: 0, text: 'Unrelated needle' }],
        'needle',
        source,
        source.lastIndexOf('needle'),
      ),
    ).toBeNull();
  });
  it('preserves word and line boundaries from PDF text items', () => {
    expect(
      textFromPdfItems([
        { str: 'first' },
        { str: 'line', hasEOL: true },
        { str: 'second' },
      ]),
    ).toBe('first line\nsecond');
  });

  it('returns matches in page order with page-local ordinals', () => {
    expect(
      findPdfTextMatches(
        [
          { pageIndex: 2, text: 'Needle' },
          { pageIndex: 0, text: 'needle and NEEDLE' },
        ],
        'needle',
      ),
    ).toEqual([
      { pageIndex: 0, pageOccurrenceIndex: 0, start: 0, end: 6 },
      { pageIndex: 0, pageOccurrenceIndex: 1, start: 11, end: 17 },
      { pageIndex: 2, pageOccurrenceIndex: 0, start: 0, end: 6 },
    ]);
  });

  it('does not produce matches for an empty query', () => {
    expect(findPdfTextMatches([{ pageIndex: 0, text: 'text' }], '  ')).toEqual(
      [],
    );
  });
});
