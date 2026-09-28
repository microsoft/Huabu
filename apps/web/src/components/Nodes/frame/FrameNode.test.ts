// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  getFrameAccentMarkerColor,
  getFrameHeaderMetrics,
} from './frameHeaderMetrics';
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

describe('getFrameHeaderMetrics', () => {
  it('centers the title inside the responsive header region', () => {
    expect(getFrameHeaderMetrics(40, 1380, 52, 152)).toEqual({
      left: 40,
      top: 45,
      height: 62,
      fontSize: 52,
      maxWidth: 1332,
    });
  });

  it('uses compact fallback metrics for an empty frame', () => {
    expect(getFrameHeaderMetrics(null, 400, 32, 64)).toEqual({
      left: 16,
      top: 13,
      height: 38,
      fontSize: 32,
      maxWidth: 376,
    });
  });

  describe('getFrameAccentMarkerColor', () => {
    it.each(['white', '#fff', '#ffffff', ' #FFFFFF ', 'WHITE'])(
      'uses a softer neutral foreground for white accent %s',
      (accent) => {
        expect(getFrameAccentMarkerColor(accent)).toBe('var(--fg-muted)');
      },
    );

    it.each(['#388388', '#E9C46A', '#A8A29E', 'var(--info)', 'red'])(
      'preserves the original accent %s without foreground mixing',
      (accent) => {
        expect(getFrameAccentMarkerColor(accent)).toBe(accent);
      },
    );

    it('uses the neutral marker color when the Frame has no accent', () => {
      expect(getFrameAccentMarkerColor(null)).toBe('var(--fg-muted)');
    });
  });

  it('preserves title size when a Manual Frame is narrow', () => {
    expect(getFrameHeaderMetrics(200, 80, 52, 152)).toEqual({
      left: 32,
      top: 45,
      height: 62,
      fontSize: 52,
      maxWidth: 48,
    });
  });

  it('changes vertical position only with the responsive tier', () => {
    expect(getFrameHeaderMetrics(28, 1380, 36, 96)).toEqual({
      left: 28,
      top: 27,
      height: 43,
      fontSize: 36,
      maxWidth: 1344,
    });
  });
});
