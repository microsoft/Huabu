// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FRAME_DESIGN_CONFIG } from './frameDesign';
import { isWhiteAccent } from '../design/accentTokens';

export interface FrameHeaderMetrics {
  left: number;
  top: number;
  height: number;
  fontSize: number;
  maxWidth: number;
}

export function getFrameAccentMarkerColor(accent: string | null): string {
  return !accent || isWhiteAccent(accent) ? 'var(--fg-muted)' : accent;
}

/**
 * Positions the title row within the current responsive header region without
 * changing its responsive font size or following child movement.
 */
export function getFrameHeaderMetrics(
  contentInsetX: number | null,
  frameWidth: number,
  desiredFontSize: number,
  responsiveHeaderInset: number,
): FrameHeaderMetrics {
  const config = FRAME_DESIGN_CONFIG.header;
  const desiredLeft =
    contentInsetX !== null && Number.isFinite(contentInsetX)
      ? Math.max(0, contentInsetX)
      : config.fallbackInsetX;
  const fontSize = Math.round(Math.max(config.minFontSize, desiredFontSize));
  const height = Math.round(fontSize * config.lineHeight);
  const left = Math.min(
    Math.max(config.edgeInset, desiredLeft),
    Math.max(config.edgeInset, frameWidth - config.minWidth),
  );

  return {
    left,
    top: Math.round(
      Math.max(config.verticalPadding, (responsiveHeaderInset - height) / 2),
    ),
    height,
    fontSize,
    maxWidth: Math.max(config.minWidth, frameWidth - left - config.edgeInset),
  };
}
