// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveAccent } from '@huabu/shared';
import { frameResponsiveMetricsForSize } from '@huabu/shared/canvas-engine';

import {
  FRAME_DESIGN_CONFIG,
  frameSurfaceStyle,
  frameVisualMetricsForSize,
} from './frameDesign';
import { getFrameHeaderMetrics } from './frameHeaderMetrics';
import { getAccentTokens } from '../design/accentTokens';

describe('Frame visual design', () => {
  it.each([600, 900, 1800])('uses one visual tier for width %s', (width) => {
    expect(frameVisualMetricsForSize(width, 100)).toEqual(
      frameVisualMetricsForSize(width, 5000),
    );
  });
  it.each([
    [600, 500, 64],
    [1380, 876, 96],
    [2400, 1800, 152],
  ])(
    'centers the title in the expanded inset for %s × %s',
    (width, height, inset) => {
      const metrics = frameVisualMetricsForSize(width, height);
      const header = getFrameHeaderMetrics(
        metrics.contentSpacing,
        width,
        metrics.titleFontSize,
        metrics.headerInset,
      );
      expect(metrics.headerInset).toBe(inset);
      expect(
        Math.abs(header.top - (inset - header.top - header.height)),
      ).toBeLessThanOrEqual(1);
    },
  );
  it('keeps border and background policy in the frontend design entry', () => {
    const accent = 'var(--fg-default)';
    const tokens = getAccentTokens(accent);
    expect(frameSurfaceStyle(accent)).toEqual({
      borderWidth: FRAME_DESIGN_CONFIG.appearance.borderWidth,
      borderStyle: FRAME_DESIGN_CONFIG.appearance.borderStyle,
      borderColor: tokens.divider,
      backgroundColor: tokens.bg,
    });
    expect(FRAME_DESIGN_CONFIG.appearance.borderColor(null)).toBe(
      'var(--edge-default)',
    );
    expect(FRAME_DESIGN_CONFIG.appearance.backgroundColor(null)).toBe(
      'var(--bg-surface)',
    );
  });

  it('preserves the default accent for missing and empty legacy colors', () => {
    const expected = frameSurfaceStyle(
      resolveAccent(FRAME_DESIGN_CONFIG.appearance.defaultAccent),
    );
    expect(frameSurfaceStyle(null)).toEqual(expected);
    expect(frameSurfaceStyle('')).toEqual(expected);
  });

  it.each([
    [600, 1800, 24, 16],
    [1380, 876, 36, 24],
    [2400, 1800, 52, 32],
    [0, 0, 36, 24],
    [5000, 600, 52, 32],
  ])(
    'adds appearance without changing layout for %s × %s',
    (width, height, titleFontSize, borderRadius) => {
      const layout = frameResponsiveMetricsForSize(width, height);
      expect(layout).not.toHaveProperty('titleFontSize');
      expect(layout).not.toHaveProperty('borderRadius');
      expect(frameVisualMetricsForSize(width, height)).toEqual({
        ...layout,
        titleFontSize,
        borderRadius,
      });
    },
  );
});
