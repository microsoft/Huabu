// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  allocateCardLines,
  cardTextHeight,
  tagRowsNeeded,
  visibleTagCount,
} from './previewCardBudget';

/** 20px lines and rows, no gaps: `available / 20` is the line count. */
function allocate(
  lines: number,
  needs: {
    title?: number;
    tags?: number;
    texts?: number[];
    summary?: number;
  },
) {
  return allocateCardLines({
    available: lines * 20,
    titleLine: 20,
    textLine: 20,
    tagRow: 20,
    tagRowGap: 0,
    tagGap: 0,
    textGap: 0,
    textInnerGap: 0,
    summaryGap: 0,
    titleNeed: needs.title ?? 1,
    tagRowsNeed: needs.tags ?? 0,
    textNeeds: needs.texts ?? [],
    summaryNeed: needs.summary ?? 0,
  });
}

describe('allocateCardLines', () => {
  it('gives each block its share and the excerpt the rest when everything is long', () => {
    expect(allocate(8, { title: 4, tags: 3, texts: [5], summary: 9 })).toEqual({
      titleLines: 2,
      tagRows: 1,
      textLines: [2],
      summaryLines: 3,
    });
  });

  it('hands lines the excerpt does not need back to truncated blocks, title first', () => {
    // No excerpt: nothing above stays clipped while space remains below.
    expect(allocate(8, { title: 3, tags: 2, texts: [5] })).toEqual({
      titleLines: 3,
      tagRows: 2,
      textLines: [3],
      summaryLines: 0,
    });
    // A short excerpt takes only what it needs before the hand-back.
    expect(allocate(8, { title: 3, tags: 1, texts: [2], summary: 1 })).toEqual({
      titleLines: 3,
      tagRows: 1,
      textLines: [2],
      summaryLines: 1,
    });
  });

  it('leaves space unused only once every block is shown in full', () => {
    expect(allocate(12, { title: 1, tags: 1, texts: [1], summary: 2 })).toEqual(
      { titleLines: 1, tagRows: 1, textLines: [1], summaryLines: 2 },
    );
  });

  it('shares the text lines in property order', () => {
    // Two long properties: one line each rather than two for the first.
    expect(
      allocate(8, { title: 2, tags: 1, texts: [5, 3], summary: 9 }),
    ).toEqual({
      titleLines: 2,
      tagRows: 1,
      textLines: [1, 1],
      summaryLines: 3,
    });
    expect(
      allocate(6, { title: 2, tags: 1, texts: [1, 4, 2], summary: 5 }),
    ).toEqual({
      titleLines: 2,
      tagRows: 1,
      textLines: [1, 1, 0],
      summaryLines: 1,
    });
    // Without an excerpt the later properties get the spare lines in order.
    expect(allocate(7, { title: 2, tags: 1, texts: [1, 4, 2] })).toEqual({
      titleLines: 2,
      tagRows: 1,
      textLines: [1, 3, 0],
      summaryLines: 0,
    });
  });

  it('drops the excerpt, then text, then tags as the card shrinks, keeping a title line', () => {
    const needs = { title: 3, tags: 2, texts: [3], summary: 4 };
    expect(allocate(5, needs).summaryLines).toBe(0);
    expect(allocate(4, needs)).toEqual({
      titleLines: 2,
      tagRows: 1,
      textLines: [1],
      summaryLines: 0,
    });
    expect(allocate(3, needs)).toEqual({
      titleLines: 2,
      tagRows: 1,
      textLines: [0],
      summaryLines: 0,
    });
    expect(allocate(2, needs).tagRows).toBe(0);
    expect(allocate(0, needs).titleLines).toBe(1);
  });

  it('charges the gap above a block only when that block appears', () => {
    const budget = allocateCardLines({
      available: 20 + 8 + 20 + 10 + 20,
      titleLine: 20,
      textLine: 20,
      tagRow: 20,
      tagRowGap: 4,
      tagGap: 8,
      textGap: 6,
      textInnerGap: 2,
      summaryGap: 10,
      titleNeed: 1,
      tagRowsNeed: 1,
      textNeeds: [],
      summaryNeed: 3,
    });
    expect(budget).toEqual({
      titleLines: 1,
      tagRows: 1,
      textLines: [],
      summaryLines: 1,
    });
  });
});

describe('untitled cards', () => {
  it('spend no line on a missing title', () => {
    expect(allocate(3, { title: 0, tags: 1, texts: [2] })).toEqual({
      titleLines: 0,
      tagRows: 1,
      textLines: [2],
      summaryLines: 0,
    });
  });
});

describe('text group spacing', () => {
  it('charges the group gap once and the inner gap between properties', () => {
    const input = {
      available: 20 + (6 + 20) + (2 + 20),
      titleLine: 20,
      textLine: 20,
      tagRow: 20,
      tagRowGap: 0,
      tagGap: 0,
      textGap: 6,
      textInnerGap: 2,
      summaryGap: 0,
      titleNeed: 1,
      tagRowsNeed: 0,
      textNeeds: [1, 1],
      summaryNeed: 0,
    };
    expect(allocateCardLines(input).textLines).toEqual([1, 1]);
    // One pixel short of the second property's inner gap.
    expect(
      allocateCardLines({ ...input, available: input.available - 1 }).textLines,
    ).toEqual([1, 0]);
  });
});

describe('text group that cannot open', () => {
  it('does not let a later property in at the inner gap', () => {
    const input = {
      // A title line and one text line, but not the gap that opens the group.
      available: 20 + 20 + 5,
      titleLine: 20,
      textLine: 20,
      tagRow: 20,
      tagRowGap: 0,
      tagGap: 0,
      textGap: 6,
      textInnerGap: 0,
      summaryGap: 0,
      titleNeed: 1,
      tagRowsNeed: 0,
      textNeeds: [1, 1],
      summaryNeed: 0,
    };
    const budget = allocateCardLines(input);
    expect(budget.textLines).toEqual([0, 0]);
    expect(cardTextHeight(input, budget)).toBeLessThanOrEqual(input.available);
  });
});

describe('many text properties', () => {
  it('allocates thousands of them without work that grows with their square', () => {
    const started = performance.now();
    const budget = allocate(6, {
      title: 1,
      texts: Array.from({ length: 20000 }, () => 3),
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(budget.textLines.slice(0, 3)).toEqual([3, 2, 0]);
    expect(budget.textLines.reduce((sum, lines) => sum + lines, 0)).toBe(5);
  });
});

describe('cardTextHeight', () => {
  const sizes = {
    titleLine: 30,
    textLine: 20,
    tagRow: 20,
    tagRowGap: 4,
    tagGap: 8,
    textGap: 6,
    textInnerGap: 2,
    summaryGap: 10,
  };

  it('adds each shown block with its gap and skips hidden ones', () => {
    expect(
      cardTextHeight(sizes, {
        titleLines: 2,
        tagRows: 2,
        textLines: [1, 0, 2],
        summaryLines: 3,
      }),
    ).toBe(60 + (8 + 40 + 4) + (6 + 20) + (2 + 40) + (10 + 60));
    expect(
      cardTextHeight(sizes, {
        titleLines: 1,
        tagRows: 0,
        textLines: [],
        summaryLines: 0,
      }),
    ).toBe(30);
  });

  it('never exceeds what the allocation was given', () => {
    for (const available of [0, 45, 90, 137, 260, 999]) {
      const input = {
        ...sizes,
        available,
        titleNeed: 3,
        tagRowsNeed: 2,
        textNeeds: [3, 2],
        summaryNeed: 6,
      };
      expect(
        cardTextHeight(sizes, allocateCardLines(input)),
      ).toBeLessThanOrEqual(Math.max(available, sizes.titleLine));
    }
  });
});

describe('tag fitting', () => {
  it('wraps tags greedily and counts the rows', () => {
    expect(tagRowsNeeded([], 100, 4)).toBe(0);
    expect(tagRowsNeeded([40, 40], 100, 4)).toBe(1);
    expect(tagRowsNeeded([40, 40, 40], 100, 4)).toBe(2);
    // An oversized tag fills one row instead of overflowing forever.
    expect(tagRowsNeeded([300, 40], 100, 4)).toBe(2);
  });

  it('keeps the leading tags that fit beside the +N marker', () => {
    const widths = [40, 40, 40, 40];
    expect(visibleTagCount(widths, 200, 4, 1, 20)).toBe(4);
    // Three tags fit alone, but not with the marker they would require.
    expect(visibleTagCount(widths, 130, 4, 1, 20)).toBe(2);
    expect(visibleTagCount(widths, 130, 4, 2, 20)).toBe(4);
    expect(visibleTagCount(widths, 30, 4, 1, 20)).toBe(0);
    expect(visibleTagCount(widths, 130, 4, 0, 20)).toBe(0);
  });

  it('agrees with trying every prefix, across widths, rows and marker sizes', () => {
    const bruteForce = (
      widths: number[],
      rowWidth: number,
      gap: number,
      rows: number,
      moreWidth: number,
    ) => {
      for (let count = widths.length; count > 0; count -= 1) {
        const shown = widths.slice(0, count);
        if (count < widths.length) shown.push(moreWidth);
        if (tagRowsNeeded(shown, rowWidth, gap) <= rows) return count;
      }
      return 0;
    };
    // A small deterministic generator keeps the cases reproducible.
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let round = 0; round < 400; round += 1) {
      const widths = Array.from({ length: next(9) }, () => 10 + next(140));
      const args = [
        widths,
        60 + next(200),
        next(9),
        1 + next(3),
        10 + next(50),
      ] as const;
      expect(visibleTagCount(...args), JSON.stringify(args)).toBe(
        bruteForce(...args),
      );
    }
  });

  it('fits thousands of tags without rescanning them', () => {
    const widths = Array.from({ length: 20000 }, () => 40);
    const started = performance.now();
    expect(visibleTagCount(widths, 130, 4, 1, 20)).toBe(2);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('shows every tag before the card has been measured', () => {
    expect(visibleTagCount([40, 40], 0, 4, 1, 20)).toBe(2);
  });
});
