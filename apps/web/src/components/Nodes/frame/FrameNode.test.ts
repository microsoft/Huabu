// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { shouldPreserveFrameAspectRatio } from './frameResizePolicy';

describe('shouldPreserveFrameAspectRatio', () => {
  it('locks a Hug Frame that directly contains media', () => {
    expect(
      shouldPreserveFrameAspectRatio({
        sizing: 'hug',
        hasMediaChild: true,
      }),
    ).toBe(true);
    expect(
      shouldPreserveFrameAspectRatio({
        sizing: undefined,
        hasMediaChild: true,
      }),
    ).toBe(true);
  });

  it('keeps non-media Hug Frames free-axis resizable', () => {
    expect(
      shouldPreserveFrameAspectRatio({
        sizing: 'hug',
        hasMediaChild: false,
      }),
    ).toBe(false);
  });

  it('keeps Manual Frames free-axis resizable when they contain media', () => {
    expect(
      shouldPreserveFrameAspectRatio({
        sizing: 'manual',
        hasMediaChild: true,
      }),
    ).toBe(false);
  });
});
