// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { nodeMetricsForSize } from './nodeDesign';
import { previewCardMetricsForSize } from '../previewCard/previewCardDesign';

describe('shared node geometry', () => {
  it.each([
    [400, 400, 'S', 12],
    [479, 479, 'S', 12],
    [480, 480, 'M', 18],
    [799, 799, 'M', 18],
    [800, 800, 'L', 24],
    [4000, 200, 'S', 12],
    [200, 4000, 'S', 12],
    [1000, 360, 'M', 18],
  ] as const)(
    'shares %s × %s geometry with cards',
    (width, height, tier, radius) => {
      const metrics = nodeMetricsForSize(width, height);
      expect(metrics).toMatchObject({ tier, radius });
      expect(previewCardMetricsForSize(width, height)).toMatchObject(metrics);
      expect(nodeMetricsForSize(height, width)).toEqual(metrics);
    },
  );
});
