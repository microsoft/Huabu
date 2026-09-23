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
  tiers: ReadonlyArray<
    FrameResponsiveMetrics & {
      id: FrameResponsiveTier;
      maxWidth: number;
    }
  >;
}

/**
 * Frame geometry shared by browser gestures and server-side commands.
 */
export const FRAME_LAYOUT_CONFIG = {
  query: {
    fallbackWidth: 1200,
  },
  tiers: [
    {
      id: 'compact',
      maxWidth: 900,
      headerInset: 64,
      contentSpacing: 20,
    },
    {
      id: 'regular',
      maxWidth: 1800,
      headerInset: 96,
      contentSpacing: 28,
    },
    {
      id: 'large',
      maxWidth: Number.POSITIVE_INFINITY,
      headerInset: 152,
      contentSpacing: 40,
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
  width: number,
  _height: number,
): FrameResponsiveMetrics {
  const tier = frameLayoutTierForSize(width);
  return {
    headerInset: tier.headerInset,
    contentSpacing: tier.contentSpacing,
  };
}

/**
 * Resolve the same container-query tier while a Hug Frame's final box is
 * still being computed from its content bounds.
 */
export function frameResponsiveMetricsForContentSize(
  contentWidth: number,
  contentHeight: number,
  minFrameWidth = 0,
  minFrameHeight = 0,
): FrameResponsiveMetrics {
  return resolveFrameResponsiveLayout((metrics) => ({
    metrics,
    frameSize: {
      width: Math.max(minFrameWidth, contentWidth + metrics.contentSpacing * 2),
      height: Math.max(
        minFrameHeight,
        contentHeight + metrics.headerInset + metrics.contentSpacing,
      ),
    },
  })).metrics;
}

/**
 * Find the smallest self-consistent tier for a content-derived box. Insets
 * increase monotonically, so checking each tier is bounded and independent
 * of previous geometry. The callback's dimensions must not decrease as the
 * insets grow.
 */
export function resolveFrameResponsiveLayout<
  T extends { frameSize: { width: number; height: number } },
>(layout: (metrics: FrameResponsiveMetrics) => T): T {
  let result: T | undefined;
  for (const metrics of FRAME_LAYOUT_CONFIG.tiers) {
    result = layout({
      headerInset: metrics.headerInset,
      contentSpacing: metrics.contentSpacing,
    });
    const actual = frameResponsiveMetricsForSize(
      result.frameSize.width,
      result.frameSize.height,
    );
    if (
      actual.headerInset === metrics.headerInset &&
      actual.contentSpacing === metrics.contentSpacing
    )
      return result;
  }
  if (!result) throw new Error('Frame design must define at least one tier');
  return result;
}
