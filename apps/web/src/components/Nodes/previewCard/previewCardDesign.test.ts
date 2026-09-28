// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { previewCardMetricsForSize } from './previewCardDesign';
import { NODE_BORDER_WIDTH } from '../design/nodeBoundary';
import { nodeContentSpacingForWidth } from '../design/nodeSpacing';

describe('preview card geometry', () => {
  it.each([
    [400, 214],
    [1000, 360],
    [1800, 650],
  ])('uses shared horizontal padding at %s x %s', (width, height) => {
    const metrics = previewCardMetricsForSize(width, height);
    const { padding } = nodeContentSpacingForWidth(width);
    expect(metrics.horizontal).toBe(true);
    expect(metrics.padding).toBe(padding);
    expect(metrics.imageWidth).toBeCloseTo(
      Math.min(
        (width - 6 - 2 * padding) * 0.36,
        ((height - 6 - 2 * padding) * 4) / 3,
      ),
    );
  });
  it.each([
    [479, 479, 'S', 12],
    [480, 480, 'M', 18],
    [799, 799, 'M', 18],
    [800, 800, 'L', 24],
    [4000, 200, 'S', 12],
    [200, 4000, 'S', 12],
  ] as const)(
    'resolves %s x %s to %s with radius %s',
    (width, height, tier, radius) => {
      expect(previewCardMetricsForSize(width, height)).toMatchObject({
        tier,
        radius,
      });
    },
  );

  it.each([
    [380, 380, false],
    [640, 220, true],
    [640, 480, false],
    [1000, 360, true],
    [1000, 900, false],
    [1800, 650, true],
    [960, 480, true],
    [960, 300, true],
    [312, 200, true],
    [313, 200, true],
    [518, 200, true],
    [400, 214, true],
    [400, 300, false],
    [400, 150, true],
  ] as const)(
    'uses geometry-fit orientation at %s x %s',
    (width, height, horizontal) => {
      expect(previewCardMetricsForSize(width, height).horizontal).toBe(
        horizontal,
      );
    },
  );

  it('accounts for both 3px borders before calculating available image height', () => {
    expect(NODE_BORDER_WIDTH).toBe(3);
    expect(previewCardMetricsForSize(400, 400)).toMatchObject({
      innerWidth: 362.48,
      innerHeight: 362.48,
    });
    expect(previewCardMetricsForSize(6, 6)).toMatchObject({
      innerWidth: 0,
      innerHeight: 0,
      horizontal: false,
    });
  });
});
