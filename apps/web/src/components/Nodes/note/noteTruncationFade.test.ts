// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { NOTE_SURFACE_BACKGROUND, NOTE_TRUNCATION_FADE } from './noteDesign';

describe('Note truncation fade', () => {
  it('fades into the inherited Note tint with a neutral theme fallback', () => {
    expect(NOTE_SURFACE_BACKGROUND).toBe(
      'var(--note-surface-background, var(--bg-note-surface))',
    );
    expect(NOTE_TRUNCATION_FADE).toBe(
      `linear-gradient(to top, ${NOTE_SURFACE_BACKGROUND}, transparent)`,
    );
  });
});
