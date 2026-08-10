// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  updateRetainedPdfPages,
  updateVisiblePdfPages,
} from './pdfPageRendering';

describe('updateVisiblePdfPages', () => {
  it('adds pages that enter the render window', () => {
    expect([
      ...updateVisiblePdfPages(new Set([0]), [
        { pageIndex: 1, isVisible: true },
      ]),
    ]).toEqual([0, 1]);
  });

  it('removes pages that leave the render window', () => {
    expect([
      ...updateVisiblePdfPages(new Set([0, 1]), [
        { pageIndex: 0, isVisible: false },
      ]),
    ]).toEqual([1]);
  });

  it('returns the existing set when visibility did not change', () => {
    const current = new Set([2]);
    expect(
      updateVisiblePdfPages(current, [{ pageIndex: 2, isVisible: true }]),
    ).toBe(current);
  });
});

describe('updateRetainedPdfPages', () => {
  it('keeps the most recently entered pages up to the limit', () => {
    expect([
      ...updateRetainedPdfPages(
        new Set([0, 1]),
        [
          { pageIndex: 2, isVisible: true },
          { pageIndex: 3, isVisible: true },
        ],
        3,
      ),
    ]).toEqual([1, 2, 3]);
  });

  it('does not evict a retained page merely because it left the viewport', () => {
    const current = new Set([4]);
    expect(
      updateRetainedPdfPages(current, [{ pageIndex: 4, isVisible: false }], 3),
    ).toBe(current);
  });
});
