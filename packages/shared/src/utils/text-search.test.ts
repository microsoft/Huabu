// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { literalTextMatches } from './text-search.js';

describe('literalTextMatches', () => {
  it.each([
    [
      'Needle NEEDLE',
      'needle',
      [
        { start: 0, end: 6 },
        { start: 7, end: 13 },
      ],
    ],
    [
      'aaaa',
      'aa',
      [
        { start: 0, end: 2 },
        { start: 2, end: 4 },
      ],
    ],
    ['\u0130 needle', 'needle', [{ start: 2, end: 8 }]],
    ['\u0130 needle', 'i\u0307', [{ start: 0, end: 1 }]],
    ['\u0130', 'i', []],
    ['\u0130', '\u0307', []],
    ['\u0130\u0130i', 'i\u0307i', [{ start: 1, end: 3 }]],
    [
      '\u0130\u0130i \u0130\u0130i',
      'i\u0307i',
      [
        { start: 1, end: 3 },
        { start: 5, end: 7 },
      ],
    ],
    ['ΟΣ', 'ς', [{ start: 1, end: 2 }]],
    ['\u0130 ΟΣ', 'ς', [{ start: 3, end: 4 }]],
    ['ΟΣ!', 'ς', [{ start: 1, end: 2 }]],
    ['\ud83d\ude00 needle', 'needle', [{ start: 3, end: 9 }]],
    ['text', '', []],
  ] as const)('keeps source offsets for %j / %j', (text, query, expected) => {
    expect([...literalTextMatches(text, query)]).toEqual(expected);
  });
});
