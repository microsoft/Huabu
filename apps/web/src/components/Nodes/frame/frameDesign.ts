// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveAccent } from '@huabu/shared';
import {
  FRAME_DEFAULT_ACCENT,
  FRAME_LAYOUT_CONFIG,
  frameResponsiveMetricsForSize,
  frameResponsiveTierForSize,
} from '@huabu/shared/canvas-engine';

import { getAccentTokens } from '../design/accentTokens';

import type { CSSProperties } from 'react';

const visualTiers = {
  compact: { titleFontSize: 24, borderRadius: 16 },
  regular: { titleFontSize: 36, borderRadius: 24 },
  large: { titleFontSize: 52, borderRadius: 32 },
} as const;

/** Tune Frame appearance here; geometry stays owned by the shared engine. */
export const FRAME_DESIGN_CONFIG = {
  appearance: {
    defaultAccent: FRAME_DEFAULT_ACCENT,
    borderWidth: 0,
    borderStyle: 'solid',
    borderColor: (accent: string | null) =>
      accent ? getAccentTokens(accent).divider : 'var(--edge-default)',
    backgroundColor: (accent: string | null) =>
      accent ? getAccentTokens(accent).bg : 'var(--bg-surface)',
  },
  query: FRAME_LAYOUT_CONFIG.query,
  tiers: FRAME_LAYOUT_CONFIG.tiers.map((tier) => ({
    ...tier,
    ...visualTiers[tier.id],
  })),
  header: {
    fallbackInsetX: 16,
    fallbackInsetY: 64,
    minFontSize: 12,
    minWidth: 48,
    lineHeight: 1.2,
    verticalPadding: 8,
    edgeInset: 8,
    gapRatio: 0.4,
    minGap: 4,
    markerSizeRatio: 0.42,
  },
  instructionBadge: {
    fontRatio: 0.42,
    minFontSize: 12,
    maxFontSize: 20,
    heightRatio: 1.8,
    paddingInlineRatio: 0.65,
  },
} as const;

export function frameVisualMetricsForSize(width: number, height: number) {
  return {
    ...frameResponsiveMetricsForSize(width, height),
    ...visualTiers[frameResponsiveTierForSize(width, height)],
  };
}

export type FrameVisualMetrics = ReturnType<typeof frameVisualMetricsForSize>;

export function frameSurfaceStyle(accent: string | null): CSSProperties {
  const appearance = FRAME_DESIGN_CONFIG.appearance;
  const resolvedAccent = accent || resolveAccent(appearance.defaultAccent);
  return {
    borderWidth: appearance.borderWidth,
    borderStyle: appearance.borderStyle,
    borderColor: appearance.borderColor(resolvedAccent),
    backgroundColor: appearance.backgroundColor(resolvedAccent),
  };
}
