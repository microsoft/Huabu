// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { toSafeFilename } from './naming.js';

describe('toSafeFilename boundary cleanup', () => {
  it.each([
    [' ..report.md. ', 'report.md'],
    ['.env', 'env'],
    ['\u2003..cafe\u0301 report.md.\u00a0', 'caf\u00e9 report.md'],
    ['a .. b', 'a .. b'],
    [' ...\u2003 ', 'Untitled'],
    ['\tname\r\n', '_name__'],
  ])('preserves filename cleanup for %j', (input, expected) => {
    expect(toSafeFilename(input)).toBe(expected);
  });

  it.each([' ', '.'])(
    'handles a long internal %j run without quadratic backtracking',
    (character) => {
      const input = `a${character.repeat(100_000)}b`;
      const started = performance.now();
      const result = toSafeFilename(input);
      const elapsed = performance.now() - started;

      expect(result).toBe(input.slice(0, 120));
      // Linear cleanup takes milliseconds; allow a full second on slow CI.
      expect(elapsed).toBeLessThan(1_000);
    },
  );
});
