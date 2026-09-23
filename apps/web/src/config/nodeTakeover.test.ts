// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  QUESTION_TAKEOVER_SIZE,
  QUESTION_TAKEOVER_AVATAR_RATIO,
  questionTakeoverContentScale,
  resolveQuestionStage,
} from './nodeTakeover';

describe('question authored takeover policy', () => {
  it('enters strictly below 5/24 zoom and restores at 5.5/24', () => {
    expect(resolveQuestionStage('readable', 0.24)).toBe('readable');
    expect(resolveQuestionStage('readable', 5 / 24)).toBe('readable');
    expect(resolveQuestionStage('readable', 5 / 24 - 0.000001)).toBe(
      'collapsed',
    );
    expect(resolveQuestionStage('collapsed', 5.5 / 24 - 0.000001)).toBe(
      'collapsed',
    );
    expect(resolveQuestionStage('collapsed', 5.5 / 24)).toBe('readable');
  });
  it('retains either previous stage inside the band', () => {
    for (const zoom of [5 / 24, 0.22, 0.229]) {
      expect(resolveQuestionStage('readable', zoom)).toBe('readable');
      expect(resolveQuestionStage('collapsed', zoom)).toBe('collapsed');
    }
  });
  it.each([12, 24, 48])(
    'uses screen-font hysteresis for a %ipx title',
    (fontSize) => {
      const enterZoom = 5 / fontSize;
      const exitZoom = 5.5 / fontSize;
      expect(resolveQuestionStage('readable', enterZoom, fontSize)).toBe(
        'readable',
      );
      expect(
        resolveQuestionStage('readable', enterZoom - 0.000001, fontSize),
      ).toBe('collapsed');
      expect(
        resolveQuestionStage('collapsed', exitZoom - 0.000001, fontSize),
      ).toBe('collapsed');
      expect(resolveQuestionStage('collapsed', exitZoom, fontSize)).toBe(
        'readable',
      );
      const middle = (enterZoom + exitZoom) / 2;
      expect(resolveQuestionStage('readable', middle, fontSize)).toBe(
        'readable',
      );
      expect(resolveQuestionStage('collapsed', middle, fontSize)).toBe(
        'collapsed',
      );
    },
  );
  it('uses authored font scale, never card width or screen-size floors', () => {
    expect(QUESTION_TAKEOVER_SIZE).toBe(128);
    expect(QUESTION_TAKEOVER_SIZE * QUESTION_TAKEOVER_AVATAR_RATIO).toBe(84.48);
    for (const font of [2.8, 14, 28, 56, 280])
      expect(questionTakeoverContentScale(font)).toBeCloseTo(font / 28);
    for (const invalid of [undefined, null, 0, -1, NaN, Infinity, '56'])
      expect(questionTakeoverContentScale(invalid)).toBe(1);
  });
});
