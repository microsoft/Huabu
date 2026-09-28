// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  NOTE_SURFACE_DESIGN_CONFIG,
  noteBoundaryForAccent,
  noteSurfaceStyle,
  NOTE_SURFACE_BACKGROUND,
} from './noteDesign';
import { getAccentTokens } from '../design/accentTokens';

describe('Note surface design', () => {
  it('halves the shared Frame tint while keeping the no-accent theme surface', () => {
    expect(NOTE_SURFACE_DESIGN_CONFIG.accentSurfaceMix).toBe(50);
    expect(noteSurfaceStyle(null)).toEqual({
      '--note-surface-background': 'var(--bg-note-surface)',
      backgroundColor: NOTE_SURFACE_BACKGROUND,
    });
    for (const accent of ['var(--accent-teal)', '#008080', 'white']) {
      expect(noteSurfaceStyle(accent)).toEqual({
        '--note-surface-background': `color-mix(in srgb, ${getAccentTokens(accent).bg} 50%, var(--bg-note-surface))`,
        backgroundColor: NOTE_SURFACE_BACKGROUND,
      });
    }
  });

  it('uses the Note accent with the Frame divider strategy', () => {
    expect(noteBoundaryForAccent(null)).toEqual({
      borderColor: 'var(--edge-default)',
      borderWidth: NOTE_SURFACE_DESIGN_CONFIG.borderWidth,
    });
    expect(noteBoundaryForAccent('#008080')).toEqual({
      borderColor: getAccentTokens('#008080').divider,
      borderWidth: NOTE_SURFACE_DESIGN_CONFIG.borderWidth,
    });
  });
});
