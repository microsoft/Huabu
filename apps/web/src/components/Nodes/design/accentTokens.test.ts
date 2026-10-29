// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { ACCENT_PALETTE, isAccentToken, resolveAccent } from '@huabu/shared';

import { resolveAccentCss, resolveColorPresetCss } from '@/utils/accentColor';

import { getAccentTokens } from './accentTokens';
import { nodeAccentToken } from './nodeAccentPolicy';
import { nodeBoundaryForAccent } from './nodeBoundary';
import { frameRegionSurfaceStyle } from '../frame/frameRegionStyle';
import { noteSurfaceStyle } from '../note/noteDesign';

describe('calibrated accents', () => {
  it.each(ACCENT_PALETTE)(
    'uses preset roles for $token without mixing',
    (entry) => {
      const tokens = getAccentTokens(entry.token);
      expect(tokens).toEqual({
        fg: `var(--accent-${entry.token}-fg)`,
        textFg: `var(--accent-${entry.token}-text-fg)`,
        bg: `var(--accent-${entry.token}-bg)`,
        softBg: `var(--accent-${entry.token}-soft-bg)`,
        divider: `var(--accent-${entry.token}-divider)`,
        highlightBg: `var(--accent-${entry.token}-highlight-bg)`,
        border: `light-dark(${entry.value}, ${entry.darkValue})`,
      });
      expect(resolveAccent(entry.token)).toBe(entry.value);
      expect(resolveAccent(entry.token, 'dark')).toBe(entry.darkValue);
      expect(noteSurfaceStyle(entry.token)).toHaveProperty(
        '--note-surface-background',
        tokens.softBg,
      );
      expect(
        frameRegionSurfaceStyle(entry.token, tokens.border).borderColor,
      ).toBe(tokens.border);
    },
  );

  it('preserves node policy and the neutral White boundary', () => {
    expect(nodeAccentToken('note', null)).toBe('white');
    expect(nodeAccentToken('image', null)).toBeNull();
    expect(nodeAccentToken('note', 'blue')).toBe('blue');
    expect(nodeBoundaryForAccent('white').borderColor).toBe(
      'var(--edge-default)',
    );
    expect(nodeBoundaryForAccent('blue').borderColor).toBe(
      resolveAccentCss('blue'),
    );
  });

  it.each(['#688FB8', '#008080', 'crimson', 'var(--custom-accent)'])(
    'does not reinterpret a literal %s as a preset',
    (color) => {
      expect(resolveAccent(color, 'dark')).toBe(color);
      expect(resolveAccentCss(color)).toBe(color);
      expect(getAccentTokens(color).border).toBe(color);
      expect(getAccentTokens(color).fg).toContain('color-mix(');
      expect(getAccentTokens(color).textFg).toBe(getAccentTokens(color).fg);
      expect(getAccentTokens(color).softBg).not.toContain('var(--fg-default)');
    },
  );

  it('does not accept inherited object keys as preset tokens', () => {
    expect(isAccentToken('constructor')).toBe(false);
    expect(isAccentToken('toString')).toBe(false);
    expect(resolveAccentCss(null)).toBeNull();
  });

  it('themes raw swatches without overriding highlight or custom swatches', () => {
    const blue = ACCENT_PALETTE.find((entry) => entry.token === 'blue');
    if (!blue) throw new Error('Missing blue preset');
    expect(resolveColorPresetCss(blue)).toBe(resolveAccentCss('blue'));
    for (const value of [
      getAccentTokens('blue').highlightBg,
      '#008080',
      'transparent',
    ]) {
      expect(resolveColorPresetCss({ ...blue, value })).toBe(value);
    }
  });
});
