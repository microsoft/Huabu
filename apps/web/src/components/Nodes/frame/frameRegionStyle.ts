// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { frameSurfaceStyle } from './frameDesign';
import { noteSurfaceStyle, NOTE_SURFACE_BACKGROUND } from '../note/noteDesign';

import type { CSSProperties } from 'react';

export const FRAME_REGION_STYLE = {
  backgroundOpacity: 1,
  edgeOpacity: 0.4,
} as const;

/** Keep child surfaces and outlines intact beneath the separate region veil. */
export function frameRegionSurfaceStyle(
  accent: string | null,
  borderColor: string,
  isFrame = false,
): CSSProperties {
  const base = isFrame ? frameSurfaceStyle(accent) : noteSurfaceStyle(accent);
  const background = isFrame ? base.backgroundColor : NOTE_SURFACE_BACKGROUND;
  return {
    ...base,
    backgroundColor: `color-mix(in srgb, ${background} ${FRAME_REGION_STYLE.backgroundOpacity * 100}%, transparent)`,
    borderColor: isFrame ? base.borderColor : borderColor,
  };
}
