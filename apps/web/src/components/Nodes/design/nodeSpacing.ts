// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { nodeCardContentScale } from './nodeContentScale';

/** Reference-width distances measured from the inside of the node boundary. */
export const NODE_CONTENT_SPACING = {
  padding: 16,
  imageTextGap: 12,
  descriptionGap: 8,
} as const;

/** PDF/Web card spacing scales with width; Notes use the constants directly. */
export function nodeContentSpacingForWidth(width: number) {
  const scale = nodeCardContentScale(width);
  return {
    padding: NODE_CONTENT_SPACING.padding * scale,
    imageTextGap: NODE_CONTENT_SPACING.imageTextGap * scale,
    descriptionGap: NODE_CONTENT_SPACING.descriptionGap * scale,
  };
}
