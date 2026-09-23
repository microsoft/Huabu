// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  NODE_CONTENT_SPACING,
  nodeContentSpacingForWidth,
} from './nodeSpacing';
import { NOTE_SURFACE_DESIGN_CONFIG } from '../note/noteDesign';
import { previewCardMetricsForSize } from '../previewCard/previewCardDesign';

describe('shared content spacing', () => {
  it('separates safe insets from internal gaps', () => {
    expect(NODE_CONTENT_SPACING).toEqual({
      padding: 16,
      imageTextGap: 12,
      descriptionGap: 8,
    });
    expect(NOTE_SURFACE_DESIGN_CONFIG.contentPaddingBlock).toBe(16);
    expect(NOTE_SURFACE_DESIGN_CONFIG.contentPaddingInline).toBe(16);
  });
  it.each([200, 400, 406, 600, 1000])(
    'preserves PDF/Web width scaling at %s, independently of height',
    (width) => {
      const scale = (width - 6) / 400;
      const spacing = nodeContentSpacingForWidth(width);
      expect(spacing.padding).toBeCloseTo(16 * scale);
      expect(spacing.imageTextGap).toBeCloseTo(12 * scale);
      expect(spacing.descriptionGap).toBeCloseTo(8 * scale);
      for (const height of [214, 400, 800])
        expect(previewCardMetricsForSize(width, height)).toMatchObject(spacing);
    },
  );
});
