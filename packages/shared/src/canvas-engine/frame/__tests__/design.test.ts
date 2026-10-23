// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  FRAME_LAYOUT_CONFIG,
  FRAME_DEFAULT_ACCENT,
  frameAccentToken,
  frameResponsiveMetricsForContentSize,
  frameResponsiveMetricsForSize,
} from '../design.js';

describe('Frame design config', () => {
  it('keeps width tiers for appearance, separate from fixed density', () => {
    expect(FRAME_LAYOUT_CONFIG.tiers).toMatchObject([
      { id: 'compact', maxWidth: 900 },
      { id: 'regular', maxWidth: 1800 },
      { id: 'large', maxWidth: Number.POSITIVE_INFINITY },
    ]);
  });

  it('normalizes missing legacy accents to the canonical white default', () => {
    expect(FRAME_DEFAULT_ACCENT).toBe('white');
    expect(frameAccentToken(null)).toBe('white');
    expect(frameAccentToken(undefined)).toBe('white');
    expect(frameAccentToken('purple')).toBe('purple');
  });

  it.each([
    [
      600,
      1800,
      {
        headerInset: 64,
        contentSpacing: 20,
      },
    ],
    [
      1380,
      876,
      {
        headerInset: 64,
        contentSpacing: 20,
      },
    ],
    [
      2400,
      1800,
      {
        headerInset: 64,
        contentSpacing: 20,
      },
    ],
  ])(
    'uses fixed density for a %spx by %spx Frame',
    (width, height, expected) => {
      expect(frameResponsiveMetricsForSize(width, height)).toEqual(expected);
    },
  );

  it('uses fixed density when dimensions are unavailable', () => {
    expect(frameResponsiveMetricsForSize(0, 0)).toEqual({
      headerInset: 64,
      contentSpacing: 20,
    });
  });

  it('uses the same density for a content-driven Hug Frame', () => {
    expect(frameResponsiveMetricsForContentSize(1000, 650)).toEqual({
      headerInset: 64,
      contentSpacing: 20,
    });
  });

  it.each([600, 899, 900, 1799, 1800, 5000])(
    'keeps metrics independent of height at width %s',
    (width) => {
      for (const height of [40, 600, 1800, 10000]) {
        expect(frameResponsiveMetricsForSize(width, height)).toEqual(
          frameResponsiveMetricsForSize(width, 900),
        );
      }
    },
  );

  it.each([
    [899, 64, 20],
    [900, 64, 20],
    [1799, 64, 20],
    [1800, 64, 20],
  ])(
    'keeps density stable across width %s',
    (width, headerInset, contentSpacing) => {
      expect(frameResponsiveMetricsForSize(width, 600)).toEqual({
        headerInset,
        contentSpacing,
      });
    },
  );
});
