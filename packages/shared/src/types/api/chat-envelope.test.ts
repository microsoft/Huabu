// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { inkRecognitionSchema } from './chat-envelope.js';

function recognition(lines: Array<{ text: string; confidence?: number }>) {
  return {
    provider: 'azure-vision',
    apiVersion: '2024-02-01',
    originNodeIds: ['ink-1'],
    lines,
  };
}

describe('inkRecognitionSchema', () => {
  it('normalizes bounded recognition while preserving line order', () => {
    expect(
      inkRecognitionSchema.parse(
        recognition([
          { text: ' 第一行 ', confidence: 0 },
          { text: '第二行', confidence: 1 },
        ]),
      ),
    ).toEqual(
      recognition([
        { text: '第一行', confidence: 0 },
        { text: '第二行', confidence: 1 },
      ]),
    );
  });

  it.each([
    recognition([]),
    recognition([{ text: ' ' }]),
    recognition([{ text: 'a'.repeat(2001) }]),
    recognition([{ text: 'a', confidence: -0.01 }]),
    recognition([{ text: 'a', confidence: 1.01 }]),
    recognition(Array.from({ length: 101 }, () => ({ text: 'a' }))),
    recognition(Array.from({ length: 7 }, () => ({ text: 'a'.repeat(2000) }))),
    {
      ...recognition([{ text: 'a' }]),
      originNodeIds: Array.from({ length: 101 }, (_, index) => `ink-${index}`),
    },
  ])('rejects recognition outside the durable input budgets', (value) => {
    expect(inkRecognitionSchema.safeParse(value).success).toBe(false);
  });
});
