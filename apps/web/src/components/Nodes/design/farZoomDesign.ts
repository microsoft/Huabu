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
  descriptionMinLines?: number;
}

export const FAR_TITLE_TYPOGRAPHY = {
  labelFont: 12,
  labelLine: 16,
  labelWeight: NODE_TYPOGRAPHY.cardTitle.weight,
} as const;

/** Screen-pixel metrics shared by all far-zoom labels and preview cards. */
export const FAR_ZOOM_DESIGN = {
  ...FAR_TITLE_TYPOGRAPHY,
  labelInset: 6,
  labelInsetInline: 6,
  descriptionFont: 10,
  descriptionLine: 16,
  descriptionGap: 2,
  descriptionMinLines: 2,
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

/** Use complete description lines after the full title, once the minimum fits. */
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
  const lines = Math.max(
    0,
    Math.floor(
      (height - displayedTitleHeight - config.descriptionGap) /
        config.descriptionLine,
    ),
  );
  return lines >= (config.descriptionMinLines ?? 1) ? lines : 0;
}
