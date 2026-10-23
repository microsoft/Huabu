// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface FrameResponsiveMetrics {
  headerInset: number;
  contentSpacing: number;
}

export type FrameResponsiveTier = 'compact' | 'regular' | 'large';

interface FrameLayoutConfig {
  query: {
    fallbackWidth: number;
  };
  metrics: FrameResponsiveMetrics;
  nodeGap: number;
  trackGap: number;
  tiers: ReadonlyArray<{
    id: FrameResponsiveTier;
    maxWidth: number;
  }>;
}

/**
 * Frame geometry shared by browser gestures and server-side commands.
 */
export const FRAME_LAYOUT_CONFIG = {
  query: {
    fallbackWidth: 1200,
  },
  metrics: { headerInset: 64, contentSpacing: 20 },
  nodeGap: 16,
  trackGap: 24,
  tiers: [
    {
      id: 'compact',
      maxWidth: 900,
    },
    {
      id: 'regular',
      maxWidth: 1800,
    },
    {
      id: 'large',
      maxWidth: Number.POSITIVE_INFINITY,
    },
  ],
} as const satisfies FrameLayoutConfig;

// Persisted creation default, also used when rendering legacy missing accents.
export const FRAME_DEFAULT_ACCENT = 'white';

export function frameAccentToken(accent: string | null | undefined): string {
  return accent || FRAME_DEFAULT_ACCENT;
}

function frameLayoutTierForSize(frameWidth: number) {
  const { query, tiers } = FRAME_LAYOUT_CONFIG;
  const safeWidth =
    Number.isFinite(frameWidth) && frameWidth > 0
      ? frameWidth
      : query.fallbackWidth;
  const tier =
    tiers.find(({ maxWidth }) => safeWidth < maxWidth) ??
    tiers[tiers.length - 1];

  return tier;
}

export function frameResponsiveTierForSize(
  width: number,
  _height: number,
): FrameResponsiveTier {
  return frameLayoutTierForSize(width).id;
}

export function frameResponsiveMetricsForSize(
  _width: number,
  _height: number,
): FrameResponsiveMetrics {
  return { ...FRAME_LAYOUT_CONFIG.metrics };
}

/** Hug and Manual Frames use the same fixed content insets. */
export function frameResponsiveMetricsForContentSize(
  _contentWidth: number,
  _contentHeight: number,
  _minFrameWidth = 0,
  _minFrameHeight = 0,
): FrameResponsiveMetrics {
  return { ...FRAME_LAYOUT_CONFIG.metrics };
}

/** Resolve content-derived geometry without width-dependent density changes. */
export function resolveFrameResponsiveLayout<
  T extends { frameSize: { width: number; height: number } },
>(layout: (metrics: FrameResponsiveMetrics) => T): T {
  return layout({ ...FRAME_LAYOUT_CONFIG.metrics });
}
