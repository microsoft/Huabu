// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { NODE_TYPOGRAPHY } from './nodeTypography';

export interface FarZoomDesign {
  labelFont: number;
  labelLine: number;
  labelWeight: number;
  labelInset: number;
  /** Override only horizontal spacing; vertical title-priority fit is unchanged. */
  labelInsetInline?: number;
  descriptionFont: number;
  descriptionLine: number;
  descriptionGap: number;
}

/** Screen-pixel metrics for far-zoom text; visibility policy belongs to callers. */
export const FAR_ZOOM_DESIGN = {
  labelFont: 10,
  labelLine: 14,
  labelWeight: NODE_TYPOGRAPHY.cardTitle.weight,
  labelInset: 6,
  labelInsetInline: 8,
  descriptionFont: 8,
  descriptionLine: 11,
  descriptionGap: 4,
} as const satisfies FarZoomDesign;

export function farLabelContentBox(
  width: number,
  height: number,
  insetInline: number,
  insetBlock: number,
  lineHeight: number,
) {
  const verticalInset = Math.min(
    insetBlock,
    Math.max(0, (height - lineHeight) / 2),
  );
  const availableHeight = Math.max(0, height - 2 * verticalInset);
  return {
    availableWidth: Math.max(0, width - 2 * insetInline),
    availableHeight,
    verticalInset,
    lines: Math.floor(availableHeight / lineHeight),
  };
}

/** Use every complete description line that fits after the displayed title. */
export function farDescriptionLines(
  width: number,
  height: number,
  titleHeight: number,
  titleLines: number,
  config: FarZoomDesign = FAR_ZOOM_DESIGN,
) {
  if (
    width <= 0 ||
    titleHeight <= 0 ||
    titleLines <= 0 ||
    titleHeight > titleLines * config.labelLine
  )
    return 0;
  const displayedTitleHeight = Math.min(
    titleHeight,
    titleLines * config.labelLine,
  );
  return Math.max(
    0,
    Math.floor(
      (height - displayedTitleHeight - config.descriptionGap) /
        config.descriptionLine,
    ),
  );
}
