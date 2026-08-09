// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { findPdfTextMatches, textFromPdfItems } from './pdfTextIndex';

describe('PDF text index', () => {
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
