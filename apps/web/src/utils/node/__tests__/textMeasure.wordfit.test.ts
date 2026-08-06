// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { computeFontSizeForHeight, type FontOpts } from '../textMeasure';

const opts: FontOpts = {
  fontFamily: 'sans-serif',
  fontWeight: 'normal',
  fontStyle: 'normal',
  lineHeight: 1.5,
};

describe('computeFontSizeForHeight word-fit guard', () => {
  it('keeps "Microsoft" on a single line in a narrow tall box', () => {
    // Narrow box (60px content width) but tall (1000px content height).
    // Without the word-fit guard, the height-only binary search would
    // pick a huge fontSize (because vertical space allows it), and pretext
    // would break "Microsoft" into multiple lines. With the guard the
    // returned fontSize must be small enough that the widest token
    // ("Microsoft", 9 chars) fits in 60-4=56 px of safeWidth at the
    // stub canvas's `chars * size * 0.6` width metric:
    //   9 * size * 0.6 <= 56  =>  size <= 10.37
    const fontSize = computeFontSizeForHeight(
      'Microsoft hello',
      60,
      1000,
      opts,
    );
    expect(fontSize).toBeLessThanOrEqual(10.5);
  });

  it('uses the height-driven size when no Latin word forces a smaller cap', () => {
    // Pure CJK paragraph — no unbreakable tokens. Height drives the
    // result; the guard is a no-op.
    const fontSize = computeFontSizeForHeight('你好世界', 200, 100, opts);
    expect(fontSize).toBeGreaterThan(15);
  });
});
