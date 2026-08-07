// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  BADGE_MAX_SIZE,
  BADGE_MIN_SIZE,
  MARK_MAX,
  MARK_MIN,
  TAKEOVER_END_WIDTH,
  TAKEOVER_HYSTERESIS,
  TAKEOVER_START_WIDTH,
  badgeSizeForNode,
  collapseProgress,
  collapsedMarkSize,
  lerp,
  resolveQuestionStage,
} from './nodeTakeover';

describe('question node takeover geometry', () => {
  it('smoothly maps the takeover width band from readable to collapsed', () => {
    expect(collapseProgress(TAKEOVER_START_WIDTH + 1)).toBe(0);
    expect(collapseProgress(TAKEOVER_START_WIDTH)).toBe(0);
    expect(
      collapseProgress((TAKEOVER_START_WIDTH + TAKEOVER_END_WIDTH) / 2),
    ).toBe(0.5);
    expect(collapseProgress(TAKEOVER_END_WIDTH)).toBe(1);
    expect(collapseProgress(TAKEOVER_END_WIDTH - 1)).toBe(1);

    const widths = [64, 56, 48, 40, 32, 24];
    const progress = widths.map(collapseProgress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('clamps readable badge size to its configured bounds', () => {
    expect(badgeSizeForNode(0, 0)).toBe(BADGE_MIN_SIZE);
    expect(badgeSizeForNode(100, 100)).toBe(BADGE_MIN_SIZE);
    expect(badgeSizeForNode(200, 300)).toBeCloseTo(56);
    expect(badgeSizeForNode(1_000, 1_000)).toBe(BADGE_MAX_SIZE);
  });

  it('keeps collapsed mark size finite and within its configured bounds', () => {
    expect(collapsedMarkSize(-10, 20)).toBe(MARK_MIN);
    expect(collapsedMarkSize(0, 0)).toBe(MARK_MIN);
    expect(collapsedMarkSize(30, 30)).toBe(MARK_MAX);
    expect(collapsedMarkSize(1_000, 1_000)).toBe(MARK_MAX);

    const middle = collapsedMarkSize(16, 20);
    expect(Number.isFinite(middle)).toBe(true);
    expect(middle).toBeGreaterThan(MARK_MIN);
    expect(middle).toBeLessThan(MARK_MAX);
  });

  it('retains the previous body stage inside the hysteresis band', () => {
    const collapseBoundary = TAKEOVER_START_WIDTH - TAKEOVER_HYSTERESIS;
    const expandBoundary = TAKEOVER_START_WIDTH + TAKEOVER_HYSTERESIS;

    expect(resolveQuestionStage('readable', collapseBoundary)).toBe('readable');
    expect(resolveQuestionStage('readable', collapseBoundary - 0.01)).toBe(
      'collapsed',
    );
    expect(resolveQuestionStage('collapsed', expandBoundary - 0.01)).toBe(
      'collapsed',
    );
    expect(resolveQuestionStage('collapsed', expandBoundary)).toBe('readable');
  });

  it('interpolates mark geometry at the exact progress endpoints', () => {
    expect(lerp(30, 6, 0)).toBe(30);
    expect(lerp(30, 6, 0.5)).toBe(18);
    expect(lerp(30, 6, 1)).toBe(6);
  });
});
