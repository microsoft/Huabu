// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  resolveFarLabelLayout,
  resolveNodePresentation,
  SEMANTIC_ZOOM_CONFIG,
  type NodePresentationMode,
} from './semanticZoom';

describe('three-layer node presentation', () => {
  it.each([
    [80, 80],
    [400, 80],
    [400, 320],
    [2000, 1600],
  ])('uses identical zoom hysteresis at %sx%s', (width, height) => {
    let mode: NodePresentationMode = 'overview';
    for (const [zoom, expected] of [
      [0.3, 'overview'],
      [0.25, 'overview'],
      [0.2499, 'minimal'],
      [0.25, 'minimal'],
      [0.2999, 'minimal'],
      [0.3, 'overview'],
    ] as const) {
      mode = resolveNodePresentation(
        zoom,
        width * zoom,
        height * zoom,
        mode,
        false,
      );
      expect(mode).toBe(expected);
    }
    expect(
      resolveNodePresentation(0.27, width, height, 'overview', false),
    ).toBe('overview');
  });

  it.each([
    [559, 360, 'overview', 'overview'],
    [560, 359, 'overview', 'overview'],
    [560, 360, 'overview', 'reading'],
    [800, 200, 'overview', 'overview'],
    [200, 800, 'overview', 'overview'],
    [480, 300, 'reading', 'reading'],
    [479, 500, 'reading', 'overview'],
    [800, 299, 'reading', 'overview'],
    [99, 800, 'reading', 'overview'],
    [700, 500, 'minimal', 'reading'],
    [800, 79, 'overview', 'overview'],
    [800, 80, 'overview', 'overview'],
    [800, 95, 'minimal', 'overview'],
    [800, 96, 'minimal', 'overview'],
  ] as const)(
    'resolves %sx%s from %s to %s',
    (width, height, previous, expected) => {
      expect(resolveNodePresentation(1, width, height, previous)).toBe(
        expected,
      );
    },
  );

  it('does not flicker while resizing inside either hysteresis band', () => {
    let mode: NodePresentationMode = 'overview';
    for (const width of [560, 550, 500, 480, 520]) {
      mode = resolveNodePresentation(1, width, 400, mode);
      expect(mode).toBe('reading');
    }
    mode = resolveNodePresentation(1, 470, 400, mode);
    for (const width of [480, 500, 559]) {
      mode = resolveNodePresentation(1, width, 400, mode);
      expect(mode).toBe('overview');
    }
  });

  it('lets far zoom override even reader-sized geometry', () => {
    expect(resolveNodePresentation(0.24, 1000, 800, 'reading')).toBe('minimal');
    expect(resolveNodePresentation(0.3, 1000, 800, 'minimal')).toBe('reading');
  });

  it('opts Office into minimal without requiring a reading renderer', () => {
    expect(SEMANTIC_ZOOM_CONFIG.nodeLOD.office).toEqual({
      full: 'full',
      minimal: 'minimal',
    });
    for (const previous of ['minimal', 'overview', 'reading'] as const) {
      expect(resolveNodePresentation(1, 700, 500, previous, false)).toBe(
        'overview',
      );
      expect(resolveNodePresentation(0.24, 800, 79, previous, false)).toBe(
        'minimal',
      );
    }
    expect(resolveNodePresentation(0.27, 110, 800, 'minimal', false)).toBe(
      'minimal',
    );
    expect(resolveNodePresentation(0.27, 110, 800, 'overview', false)).toBe(
      'overview',
    );
  });
});

describe('far-label inner screen-space fit', () => {
  it('subtracts only the shared insets, not another border', () => {
    expect(resolveFarLabelLayout(100, 80)).toEqual({
      availableWidth: 84,
      availableHeight: 68,
      verticalInset: 6,
      lines: 4,
      labelRetained: true,
    });
  });

  it.each([
    [-10, -10, 0, 0, 0, false],
    [12, 12, 0, 12, 0, false],
    [200, 13.9, 184, 13.9, 0, false],
    [200, 14, 184, 14, 1, true],
    [200, 20, 184, 14, 1, true],
    [200, 25.9, 184, 14, 1, true],
    [50, 26, 34, 14, 1, true],
    [35.9, 100, 19.9, 88, 6, false],
    [100, 39.9, 84, 27.9, 1, true],
    [100, 40, 84, 28, 2, true],
    [100, 53.9, 84, 41.9, 2, true],
    [100, 54, 84, 42, 3, true],
    [100, 500, 84, 488, 34, true],
  ] as const)(
    'fits %sx%s inner bounds',
    (width, height, availableWidth, availableHeight, lines, labelRetained) => {
      const layout = resolveFarLabelLayout(width, height);
      expect(layout.availableWidth).toBeCloseTo(availableWidth);
      expect(layout.availableHeight).toBeCloseTo(availableHeight);
      expect(layout.lines).toBe(lines);
      expect(layout.labelRetained).toBe(labelRetained);
    },
  );

  it.each([undefined, false, true])(
    'never lets retention history (%s) override minimum fit',
    (previous) => {
      // The 20px text minimum must fit regardless of retention history.
      for (const width of [20, 30, 35, 35.9]) {
        expect(resolveFarLabelLayout(width, 100, previous).labelRetained).toBe(
          false,
        );
      }
      expect(resolveFarLabelLayout(50, 41, previous).labelRetained).toBe(true);
      expect(resolveFarLabelLayout(100, 13.9, previous).labelRetained).toBe(
        false,
      );
    },
  );
  it.each([
    [14, 0],
    [18, 2],
    [22, 4],
    [26, 6],
    [40, 6],
  ])(
    'reduces vertical insets at height %s to %s without changing horizontal insets',
    (height, inset) => {
      const layout = resolveFarLabelLayout(80, height);
      expect(layout.verticalInset).toBe(inset);
      expect(layout.availableWidth).toBe(64);
      expect(layout.labelRetained).toBe(true);
      expect(layout.availableHeight + inset * 2).toBe(height);
    },
  );
});
