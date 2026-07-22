import { describe, expect, it } from 'vitest';

import { wheelDeltaToZoomFactor } from './useCanvasGestures';

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
