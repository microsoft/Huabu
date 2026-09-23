// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Canvas-space size tiers shared by ordinary node shells and content cards. */
export const NODE_SIZE_TIERS = [
  { tier: 'S', limit: 480, radius: 12 },
  { tier: 'M', limit: 800, radius: 18 },
  { tier: 'L', limit: Infinity, radius: 24 },
] as const;

export function nodeMetricsForSize(width: number, height: number) {
  const short = Math.min(width, height);
  const effectiveSize = Math.sqrt(
    short * Math.min(Math.max(width, height), short * 2),
  );
  const metrics =
    NODE_SIZE_TIERS.find((entry) => effectiveSize < entry.limit) ??
    NODE_SIZE_TIERS[2];
  return { ...metrics, effectiveSize };
}
