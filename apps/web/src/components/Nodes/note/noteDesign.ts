// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAccentTokens } from '../design/accentTokens';
import { NODE_BORDER_WIDTH } from '../design/nodeBoundary';
import { NODE_CONTENT_SPACING } from '../design/nodeSpacing';

import type { CSSProperties } from 'react';

export { nodeBoundaryForAccent as noteBoundaryForAccent } from '../design/nodeBoundary';

export const NOTE_SURFACE_DESIGN_CONFIG = {
  borderWidth: NODE_BORDER_WIDTH,
  accentSurfaceMix: 50,
  contentPaddingBlock: NODE_CONTENT_SPACING.padding,
  contentPaddingInline: NODE_CONTENT_SPACING.padding,
  truncationFadeHeight: 12,
} as const;

export const NOTE_SURFACE_BACKGROUND =
  'var(--note-surface-background, var(--bg-note-surface))';
export const NOTE_TRUNCATION_FADE = `linear-gradient(to top, ${NOTE_SURFACE_BACKGROUND}, transparent)`;

/** Keep the shell and its inherited truncation fade on the same opaque tint. */
export function noteSurfaceStyle(accent: string | null): CSSProperties {
  return {
    '--note-surface-background': accent
      ? `color-mix(in srgb, ${getAccentTokens(accent).bg} ${NOTE_SURFACE_DESIGN_CONFIG.accentSurfaceMix}%, var(--bg-note-surface))`
      : 'var(--bg-note-surface)',
    backgroundColor: NOTE_SURFACE_BACKGROUND,
  } as CSSProperties;
}
