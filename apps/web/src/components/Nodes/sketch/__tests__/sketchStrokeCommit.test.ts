// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { pointsToPath } from '../sketchPath';
import { shouldCommitSketchStroke } from '../sketchStrokeCommit';

describe('short sketch strokes', () => {
  it('commits one-point and two-point marks below the drag threshold', () => {
    expect(shouldCommitSketchStroke('pending', 1)).toBe(true);
    expect(shouldCommitSketchStroke('pending', 2)).toBe(true);
  });

  it('keeps ordinary locked strokes and rejects an invalid session', () => {
    expect(shouldCommitSketchStroke('locked', 3)).toBe(true);
    expect(shouldCommitSketchStroke(null, 1)).toBe(false);
    expect(shouldCommitSketchStroke('pending', 0)).toBe(false);
  });

  it('renders visible geometry for one-point and two-point marks', () => {
    expect(pointsToPath([[10, 10, 0.5]])).not.toBe('');
    expect(
      pointsToPath([
        [10, 10, 0.5],
        [11, 10, 0.5],
      ]),
    ).not.toBe('');
  });
});
