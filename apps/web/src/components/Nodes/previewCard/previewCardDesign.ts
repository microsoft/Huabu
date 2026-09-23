// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_BORDER_WIDTH } from '../design/nodeBoundary';
import { NODE_SIZE_TIERS, nodeMetricsForSize } from '../design/nodeDesign';
import { nodeContentSpacingForWidth } from '../design/nodeSpacing';
import { NODE_CARD_TYPOGRAPHY } from '../design/nodeTypography';

export const PREVIEW_CARD_TIERS = [
  {
    ...NODE_SIZE_TIERS[0],
    gap: 8,
    badgePadding: 4,
    mark: 16,
  },
  {
    ...NODE_SIZE_TIERS[1],
    gap: 12,
    badgePadding: 6,
    mark: 20,
  },
  {
    ...NODE_SIZE_TIERS[2],
    gap: 16,
    badgePadding: 8,
    mark: 26,
  },
] as const;

export function previewCardMetricsForSize(width: number, height: number) {
  const { tier: sizeTier, effectiveSize } = nodeMetricsForSize(width, height);
  const geometry =
    PREVIEW_CARD_TIERS.find((entry) => entry.tier === sizeTier) ??
    PREVIEW_CARD_TIERS[2];
  const tier = {
    ...geometry,
    ...NODE_CARD_TYPOGRAPHY,
    ...nodeContentSpacingForWidth(width),
  };
  const innerWidth = Math.max(
    0,
    width - 2 * NODE_BORDER_WIDTH - 2 * tier.padding,
  );
  const innerHeight = Math.max(
    0,
    height - 2 * NODE_BORDER_WIDTH - 2 * tier.padding,
  );
  const imageWidth = Math.min(innerWidth * 0.36, (innerHeight * 4) / 3);
  const textHeight = tier.metaLine + tier.gap + 2 * tier.titleLine;
  const preferredTextHeight =
    textHeight + tier.descriptionGap + 2 * tier.descriptionLine;
  const textWidth = innerWidth - imageWidth - tier.imageTextGap;
  const crampedVerticalCover =
    innerHeight - preferredTextHeight < (width - 2 * NODE_BORDER_WIDTH) / 4;
  return {
    ...tier,
    effectiveSize,
    innerWidth,
    innerHeight,
    imageWidth,
    horizontal:
      innerHeight > 0 &&
      width / height >= 1.5 &&
      textWidth >= tier.title * 6 &&
      innerHeight >= textHeight &&
      ((width / height >= 2 && (innerWidth * 0.27) / innerHeight >= 0.8) ||
        crampedVerticalCover),
  };
}
