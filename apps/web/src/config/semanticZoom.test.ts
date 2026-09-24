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
  const enter = SEMANTIC_ZOOM_CONFIG.minimalZoom.enter;
  const exit = SEMANTIC_ZOOM_CONFIG.minimalZoom.exit;
  const belowEnter = enter - 0.0001;
  const belowExit = exit - 0.0001;

  it.each([
    [80, 80],
    [400, 80],
    [400, 320],
    [2000, 1600],
  ])('uses Note-only 25/28 percent hysteresis at %sx%s', (width, height) => {
    expect(SEMANTIC_ZOOM_CONFIG.minimalZoomByType.note).toEqual({
      enter: 0.25,
      exit: 0.28,
    });
    let mode: NodePresentationMode = 'overview';
    for (const [zoom, expected] of [
      [0.28, 'overview'],
      [0.26, 'overview'],
      [0.25, 'overview'],
      [0.2499, 'minimal'],
      [0.25, 'minimal'],
      [0.2799, 'minimal'],
      [0.28, 'overview'],
      [0.26, 'overview'],
    ] as const) {
      mode = resolveNodePresentation(
        zoom,
        width * zoom,
        height * zoom,
        mode,
        false,
        'note',
      );
      expect(mode).toBe(expected);
    }
  });

  it('uses the configured 20% entry and 24% exit band', () => {
    expect(SEMANTIC_ZOOM_CONFIG.minimalZoom).toEqual({
      enter: 0.2,
      exit: 0.24,
    });
  });

  it.each([
    [80, 80],
    [400, 80],
    [400, 320],
    [2000, 1600],
  ])('uses identical zoom hysteresis at %sx%s', (width, height) => {
    let mode: NodePresentationMode = 'overview';
    for (const [zoom, expected] of [
      [exit, 'overview'],
      [enter, 'overview'],
      [belowEnter, 'minimal'],
      [enter, 'minimal'],
      [belowExit, 'minimal'],
      [exit, 'overview'],
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
      resolveNodePresentation(
        (enter + exit) / 2,
        width,
        height,
        'overview',
        false,
      ),
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
    expect(resolveNodePresentation(belowEnter, 1000, 800, 'reading')).toBe(
      'minimal',
    );
    expect(resolveNodePresentation(exit, 1000, 800, 'minimal')).toBe('reading');
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
      expect(
        resolveNodePresentation(belowEnter, 800, 79, previous, false),
      ).toBe('minimal');
    }
    expect(resolveNodePresentation(belowExit, 110, 800, 'minimal', false)).toBe(
      'minimal',
    );
    expect(
      resolveNodePresentation(belowExit, 110, 800, 'overview', false),
    ).toBe('overview');
  });
});

describe('far-label inner screen-space fit', () => {
  it('subtracts only the shared insets, not another border', () => {
    expect(resolveFarLabelLayout(100, 80)).toEqual({
      availableWidth: 88,
      availableHeight: 68,
      horizontalInset: 6,
      verticalInset: 6,
      lines: 4,
      labelRetained: true,
    });
  });

  it.each([
    [-10, -10, 0, 0, 0, false],
    [12, 12, 12, 12, 0, false],
    [200, 12.9, 188, 12.9, 0, false],
    [200, 15.9, 188, 15.9, 0, false],
    [200, 16, 188, 16, 1, true],
    [200, 20, 188, 16, 1, true],
    [200, 27.9, 188, 16, 1, true],
    [50, 28, 38, 16, 1, true],
    [11.9, 100, 11.9, 88, 5, false],
    [12, 100, 12, 88, 5, true],
    [23.9, 100, 12, 88, 5, true],
    [24, 100, 12, 88, 5, true],
    [35.9, 100, 23.9, 88, 5, true],
    [100, 37.9, 88, 25.9, 1, true],
    [100, 44, 88, 32, 2, true],
    [100, 59.9, 88, 47.9, 2, true],
    [100, 60, 88, 48, 3, true],
    [100, 500, 88, 488, 30, true],
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
    'lets CSS retain any label with one line and one glyph of width regardless of history (%s)',
    (previous) => {
      expect(resolveFarLabelLayout(11.9, 100, previous).labelRetained).toBe(
        false,
      );
      for (const width of [12, 20.9, 21, 30, 35, 35.9])
        expect(resolveFarLabelLayout(width, 100, previous).labelRetained).toBe(
          true,
        );
      expect(resolveFarLabelLayout(50, 41, previous).labelRetained).toBe(true);
      expect(resolveFarLabelLayout(100, 15.9, previous).labelRetained).toBe(
        false,
      );
    },
  );
  it.each([0.1, 0.095])(
    'shrinks padding to retain 12px labels at zoom %s',
    (zoom) => {
      const width = (240 - 6) * zoom;
      const layout = resolveFarLabelLayout(width, (180 - 6) * zoom);
      expect(layout.labelRetained).toBe(true);
      expect(layout.availableWidth).toBeGreaterThanOrEqual(12);
      expect(layout.horizontalInset).toBeLessThanOrEqual(6);
      expect(layout.availableWidth + layout.horizontalInset * 2).toBeCloseTo(
        width,
      );
    },
  );
  it.each([
    [0.1, true],
    [0.095, true],
    [0.09, false],
    [0.085, false],
    [0.08, false],
  ])(
    'fits a 240x180 Note at zoom %s only when a complete 16px line fits',
    (zoom, retained) => {
      const layout = resolveFarLabelLayout((240 - 6) * zoom, (180 - 6) * zoom);
      expect(layout.labelRetained).toBe(retained);
      expect(layout.availableWidth).toBeGreaterThanOrEqual(12);
      expect(layout.lines).toBe(retained ? 1 : 0);
    },
  );
  it.each([
    [16, 0],
    [20, 2],
    [24, 4],
    [28, 6],
    [40, 6],
  ])(
    'reduces vertical insets at height %s to %s without changing horizontal insets',
    (height, inset) => {
      const layout = resolveFarLabelLayout(80, height);
      expect(layout.verticalInset).toBe(inset);
      expect(layout.availableWidth).toBe(68);
      expect(layout.labelRetained).toBe(true);
      expect(layout.availableHeight + inset * 2).toBe(height);
    },
  );
});
