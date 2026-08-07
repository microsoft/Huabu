// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for spatial geometry primitives.
 *
 * Focus: `relativeDirection` — the regression that motivated the
 * edge-aware rewrite. The old center-to-center classifier broke down
 * when two rectangles had very different sizes; the cases below
 * codify the corrected behaviour.
 */

import { describe, it, expect } from 'vitest';

import { relativeDirection, type Rect } from '../geometry.js';

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

describe('relativeDirection', () => {
  describe('clean axial separation', () => {
    it('classifies a small node fully past the right edge of a tall frame as "right"', () => {
      // Regression: with center-to-center, A.center=(150,500),
      // B.center=(500,100) → |dy|=400 > |dx|=350 → "above" (wrong).
      // B is entirely beyond A's right edge and vertically overlaps A,
      // so the semantically correct answer is "right".
      const a = rect(0, 0, 300, 1000);
      const b = rect(400, 50, 200, 100);
      expect(relativeDirection(a, b)).toBe('right');
    });

    it('classifies a small node fully past the left edge of a tall frame as "left"', () => {
      const a = rect(500, 0, 300, 1000);
      const b = rect(100, 50, 200, 100);
      expect(relativeDirection(a, b)).toBe('left');
    });

    it('classifies a small node fully above a wide frame as "above"', () => {
      const a = rect(0, 500, 1000, 300);
      const b = rect(100, 100, 100, 200);
      expect(relativeDirection(a, b)).toBe('above');
    });

    it('classifies a small node fully below a wide frame as "below"', () => {
      const a = rect(0, 0, 1000, 300);
      const b = rect(100, 500, 100, 200);
      expect(relativeDirection(a, b)).toBe('below');
    });
  });

  describe('diagonal separation', () => {
    it('picks the axis with the larger gap for upper-right diagonal', () => {
      // gapRight = 50, gapAbove = 200 → vertical dominates → "above".
      const a = rect(0, 0, 100, 100);
      const b = rect(150, -200, 100, 100);
      expect(relativeDirection(a, b)).toBe('above');
    });

    it('picks horizontal when the horizontal gap dominates a diagonal', () => {
      // gapRight = 300, gapAbove = 50 → "right".
      const a = rect(0, 0, 100, 100);
      const b = rect(400, -50, 100, 100);
      expect(relativeDirection(a, b)).toBe('right');
    });
  });

  describe('overlapping rectangles', () => {
    it('falls back to center delta when rectangles intersect', () => {
      const a = rect(0, 0, 200, 200);
      const b = rect(100, 50, 100, 50);
      // A.center=(100,100), B.center=(150,75) → |dx|=50 > |dy|=25 → "right".
      expect(relativeDirection(a, b)).toBe('right');
    });
  });

  describe('edge alignment', () => {
    it('treats a node abutting the right edge with shared Y extent as "right"', () => {
      // gapRight = 0 (touching), overlapsY = true → "right".
      const a = rect(0, 0, 100, 100);
      const b = rect(100, 20, 100, 60);
      expect(relativeDirection(a, b)).toBe('right');
    });
  });
});
