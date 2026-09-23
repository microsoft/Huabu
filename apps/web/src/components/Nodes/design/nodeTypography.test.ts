// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { FAR_ZOOM_DESIGN } from './farZoomDesign';
import {
  NODE_TYPOGRAPHY,
  NODE_TYPOGRAPHY_STYLE,
  NODE_CARD_TYPOGRAPHY,
} from './nodeTypography';
import { previewCardMetricsForSize } from '../previewCard/previewCardDesign';

describe('shared node typography', () => {
  it('uses conventional reference sizes', () => {
    expect(NODE_TYPOGRAPHY.title.weight).toBe(600);
    expect(FAR_ZOOM_DESIGN.labelWeight).toBe(500);
    expect(NODE_TYPOGRAPHY.cardTitle.weight).toBe(500);
    expect(NODE_TYPOGRAPHY.title.size).toBe(28);
    expect(NODE_TYPOGRAPHY.cardTitle.size).toBeGreaterThan(
      NODE_TYPOGRAPHY.body.size,
    );
    expect(NODE_TYPOGRAPHY.body.size).toBeGreaterThan(
      NODE_TYPOGRAPHY.metadata.size,
    );
  });

  it('pins the adopted far-label screen-pixel metrics', () => {
    expect(FAR_ZOOM_DESIGN).toEqual({
      labelFont: 10,
      labelLine: 14,
      labelWeight: 500,
      labelInset: 6,
      labelInsetInline: 8,
      descriptionFont: 8,
      descriptionLine: 11,
      descriptionGap: 4,
    });
  });

  it.each([
    ['h2', 24],
    ['h3', 20],
    ['h4', 16],
    ['h5', 16],
    ['h6', 16],
  ] as const)(
    'publishes explicit %s typography for canvas Notes and their measurer',
    (level, size) => {
      const metric = NODE_TYPOGRAPHY[level];
      expect(metric.weight).toBe(500);
      expect(metric.size).toBe(size);
      expect(NODE_TYPOGRAPHY_STYLE[`--node-${level}-size`]).toBe(`${size}px`);
      expect(NODE_TYPOGRAPHY_STYLE[`--node-${level}-line`]).toBe(
        metric.lineHeight,
      );
      expect(NODE_TYPOGRAPHY_STYLE[`--node-${level}-weight`]).toBe(
        metric.weight,
      );
    },
  );

  it.each([100, 400, 406, 600, 1200])(
    'keeps PDF/Web typography fixed at width %s',
    (width) => {
      const metrics = NODE_CARD_TYPOGRAPHY;
      expect(metrics).toEqual({
        title: NODE_TYPOGRAPHY.cardTitle.size,
        titleLine:
          NODE_TYPOGRAPHY.cardTitle.size * NODE_TYPOGRAPHY.cardTitle.lineHeight,
        description: NODE_TYPOGRAPHY.body.size,
        descriptionLine:
          NODE_TYPOGRAPHY.body.size * NODE_TYPOGRAPHY.body.lineHeight,
        meta: NODE_TYPOGRAPHY.metadata.size,
        metaLine:
          NODE_TYPOGRAPHY.metadata.size * NODE_TYPOGRAPHY.metadata.lineHeight,
      });
      for (const height of [150, 400, 600, 1200]) {
        expect(previewCardMetricsForSize(width, height)).toMatchObject(metrics);
      }
    },
  );
});
