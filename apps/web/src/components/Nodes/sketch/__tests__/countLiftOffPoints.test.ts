import { describe, expect, it } from 'vitest';

import { countLiftOffPoints } from '../SketchOverlay';

/** Build points at a fixed position carrying the given pressures. */
const pts = (pressures: number[]): number[][] =>
  pressures.map((p, i) => [500 + i, 600, p]);

describe('countLiftOffPoints', () => {
  it('trims the decaying tail of a real ThinkPad pen stroke', () => {
    // Captured from a stroke that rendered a visible hook: the tip dwelt
    // within 3px while pressure bled off over ~130ms.
    const tail = [0.308, 0.308, 0.3, 0.29, 0.279, 0.264, 0.219, 0.136];
    const stroke = pts([...Array<number>(51).fill(0.5), ...tail]);

    // Walks back over the six strictly-decreasing samples and stops at the
    // 0.308 plateau, which is not a decay step.
    expect(countLiftOffPoints(stroke)).toBe(6);
  });

  it('keeps a stroke drawn at steady pressure', () => {
    expect(countLiftOffPoints(pts([0.5, 0.5, 0.5, 0.5, 0.5]))).toBe(0);
  });

  it('ignores pressure that rises into the lift', () => {
    expect(countLiftOffPoints(pts([0.3, 0.4, 0.5, 0.6, 0.7]))).toBe(0);
  });

  it('ignores a shallow decay that never reaches the ratio', () => {
    // Monotonic, but 0.45 is above 0.5 * 0.7 — ordinary pressure ripple.
    expect(countLiftOffPoints(pts([0.5, 0.5, 0.5, 0.5, 0.48, 0.45]))).toBe(0);
  });

  it('caps the trim so a deliberate fade-out survives', () => {
    const fade = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
    expect(countLiftOffPoints(pts(fade))).toBe(6);
  });

  it('leaves at least MIN_STROKE_POINTS behind', () => {
    // Every sample decays, but trimming all of them would erase the stroke.
    expect(countLiftOffPoints(pts([0.5, 0.4, 0.3, 0.1]))).toBe(1);
  });

  it('returns 0 when the device reports no pressure', () => {
    expect(countLiftOffPoints(pts([0, 0, 0, 0, 0]))).toBe(0);
  });

  it('returns 0 for a stroke too short to trim', () => {
    expect(countLiftOffPoints(pts([0.5, 0.3, 0.1]))).toBe(0);
  });
});
