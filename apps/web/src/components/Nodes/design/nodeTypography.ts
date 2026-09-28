// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Fixed canvas-unit typography shared by Notes and PDF/Web cards. */
export const NODE_TYPOGRAPHY = {
  title: { size: 28, lineHeight: 1.3, weight: 600 },
  h2: { size: 24, lineHeight: 1.3, weight: 500 },
  h3: { size: 20, lineHeight: 1.35, weight: 500 },
  h4: { size: 16, lineHeight: 1.4, weight: 500 },
  h5: { size: 16, lineHeight: 1.4, weight: 500 },
  h6: { size: 16, lineHeight: 1.4, weight: 500 },
  cardTitle: { size: 28, lineHeight: 1.3, weight: 500 },
  body: { size: 18, lineHeight: 1.4 },
  metadata: { size: 16, lineHeight: 1.4 },
} as const;

/** Resizing cards changes text fit, never their font sizes or line heights. */
export const NODE_CARD_TYPOGRAPHY = {
  title: NODE_TYPOGRAPHY.cardTitle.size,
  titleLine:
    NODE_TYPOGRAPHY.cardTitle.size * NODE_TYPOGRAPHY.cardTitle.lineHeight,
  description: NODE_TYPOGRAPHY.body.size,
  descriptionLine: NODE_TYPOGRAPHY.body.size * NODE_TYPOGRAPHY.body.lineHeight,
  meta: NODE_TYPOGRAPHY.metadata.size,
  metaLine: NODE_TYPOGRAPHY.metadata.size * NODE_TYPOGRAPHY.metadata.lineHeight,
} as const;

/** Unscaled variables for canvas Notes and their offscreen measurer only. */
export const NODE_TYPOGRAPHY_STYLE = {
  '--node-title-size': `${NODE_TYPOGRAPHY.title.size}px`,
  '--node-title-line': NODE_TYPOGRAPHY.title.lineHeight,
  '--node-title-weight': NODE_TYPOGRAPHY.title.weight,
  '--node-h2-size': `${NODE_TYPOGRAPHY.h2.size}px`,
  '--node-h2-line': NODE_TYPOGRAPHY.h2.lineHeight,
  '--node-h2-weight': NODE_TYPOGRAPHY.h2.weight,
  '--node-h3-size': `${NODE_TYPOGRAPHY.h3.size}px`,
  '--node-h3-line': NODE_TYPOGRAPHY.h3.lineHeight,
  '--node-h3-weight': NODE_TYPOGRAPHY.h3.weight,
  '--node-h4-size': `${NODE_TYPOGRAPHY.h4.size}px`,
  '--node-h4-line': NODE_TYPOGRAPHY.h4.lineHeight,
  '--node-h4-weight': NODE_TYPOGRAPHY.h4.weight,
  '--node-h5-size': `${NODE_TYPOGRAPHY.h5.size}px`,
  '--node-h5-line': NODE_TYPOGRAPHY.h5.lineHeight,
  '--node-h5-weight': NODE_TYPOGRAPHY.h5.weight,
  '--node-h6-size': `${NODE_TYPOGRAPHY.h6.size}px`,
  '--node-h6-line': NODE_TYPOGRAPHY.h6.lineHeight,
  '--node-h6-weight': NODE_TYPOGRAPHY.h6.weight,
  '--node-body-size': `${NODE_TYPOGRAPHY.body.size}px`,
  '--node-body-line': NODE_TYPOGRAPHY.body.lineHeight,
} as const;
