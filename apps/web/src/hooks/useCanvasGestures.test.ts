// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  clampZoom,
  shouldOwnSingleTouchNavigation,
  shouldSuppressTouchEnd,
  wheelDeltaToZoomFactor,
  zoomAroundPoint,
} from './useCanvasGestures';

describe('wheelDeltaToZoomFactor', () => {
  it('preserves sensitivity for small trackpad deltas', () => {
    expect(wheelDeltaToZoomFactor(1)).toBeCloseTo(Math.pow(2, -0.02));
    expect(wheelDeltaToZoomFactor(-1)).toBeCloseTo(Math.pow(2, 0.02));
  });

  it('caps large mouse-wheel deltas in both directions', () => {
    expect(wheelDeltaToZoomFactor(100)).toBeCloseTo(Math.pow(2, -0.2));
    expect(wheelDeltaToZoomFactor(-100)).toBeCloseTo(Math.pow(2, 0.2));
  });

  it('does not change zoom for a zero delta', () => {
    expect(wheelDeltaToZoomFactor(0)).toBe(1);
  });
});

function targetInside(className: string): Element {
  const root = document.createElement('div');
  root.className = className;
  const target = document.createElement('div');
  root.append(target);
  return target;
}

const fingerOptions = {
  inputMode: 'finger' as const,
  explicitToolActive: false,
};

describe('shouldOwnSingleTouchNavigation', () => {
  it('owns empty canvas children without requiring the pane class', () => {
    expect(
      shouldOwnSingleTouchNavigation(
        targetInside('react-flow__background'),
        fingerOptions,
      ),
    ).toBe(true);
  });

  it('does not steal finger interaction from nodes or panels', () => {
    expect(
      shouldOwnSingleTouchNavigation(
        targetInside('react-flow__node'),
        fingerOptions,
      ),
    ).toBe(false);
    expect(
      shouldOwnSingleTouchNavigation(
        targetInside('react-flow__panel'),
        fingerOptions,
      ),
    ).toBe(false);
  });

  it('owns touch over nodes in pen interaction mode', () => {
    expect(
      shouldOwnSingleTouchNavigation(targetInside('react-flow__node'), {
        ...fingerOptions,
        inputMode: 'pen',
      }),
    ).toBe(true);
  });

  it('rejects touchscreen navigation in mouse mode', () => {
    expect(
      shouldOwnSingleTouchNavigation(targetInside('react-flow__background'), {
        ...fingerOptions,
        inputMode: 'mouse',
      }),
    ).toBe(false);
  });
});

describe('shouldSuppressTouchEnd', () => {
  it('suppresses the full pointer lifecycle for owned pan and pinch touches', () => {
    expect(shouldSuppressTouchEnd(1, 1, false, new Set())).toBe(true);
    expect(shouldSuppressTouchEnd(2, null, true, new Set([2, 3]))).toBe(true);
    expect(shouldSuppressTouchEnd(3, null, true, new Set([2, 3]))).toBe(true);
  });

  it('keeps a pinch touch suppressed while the gesture drops to one finger', () => {
    expect(shouldSuppressTouchEnd(3, null, true, new Set([2, 3]))).toBe(true);
  });

  it('does not suppress an unowned touch such as application chrome', () => {
    expect(shouldSuppressTouchEnd(4, null, false, new Set())).toBe(false);
  });
});

describe('touch viewport geometry', () => {
  it('keeps the initial midpoint anchor stationary while zooming', () => {
    expect(
      zoomAroundPoint({ x: 10, y: 20, zoom: 1 }, { x: 110, y: 120 }, 2),
    ).toEqual({ x: -90, y: -80, zoom: 2 });
  });

  it('adds midpoint translation as pan during pinch', () => {
    expect(
      zoomAroundPoint({ x: 10, y: 20, zoom: 1 }, { x: 110, y: 120 }, 2, {
        x: 15,
        y: -5,
      }),
    ).toEqual({ x: -75, y: -85, zoom: 2 });
  });

  it('clamps touch zoom to the shared canvas range', () => {
    expect(clampZoom(0.01)).toBe(0.05);
    expect(clampZoom(0.05)).toBe(0.05);
    expect(clampZoom(6)).toBe(5);
    expect(clampZoom(2)).toBe(2);
  });
});
