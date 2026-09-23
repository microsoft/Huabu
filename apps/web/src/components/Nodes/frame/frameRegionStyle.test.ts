// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { frameSurfaceStyle } from './frameDesign';
import { frameRegionSurfaceStyle } from './frameRegionStyle';
import { noteSurfaceStyle } from '../note/noteDesign';

it('preserves fill opacity and attenuates only the border without dimming the shell', () => {
  for (const accent of [null, 'teal', 'purple']) {
    const style = frameRegionSurfaceStyle(accent, 'var(--edge-default)');
    expect(style.opacity).toBeUndefined();
    expect(style.backgroundColor).toContain('100%, transparent');
    expect(style.borderColor).toContain('40%, transparent');
    expect(style).toMatchObject({
      '--note-surface-background': (
        noteSurfaceStyle(accent) as Record<string, unknown>
      )['--note-surface-background'],
    });
    const frame = frameRegionSurfaceStyle(accent, 'transparent', true);
    expect(frame.backgroundColor).toContain(
      String(frameSurfaceStyle(accent).backgroundColor),
    );
    expect(frame.borderWidth).toBe(frameSurfaceStyle(accent).borderWidth);
  }
});
