// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { chatEnvelopeSchema, inkRecognitionSchema } from './chat-envelope.js';

describe('Ink query geometry', () => {
  const schema =
    chatEnvelopeSchema.shape.focus.shape.selection.shape.inkGeometry;
  const geometry = [
    {
      nodeId: 'ink',
      strokeIds: ['stroke'],
      bounds: { x: -100, y: 20, width: 0, height: 50 },
    },
  ];
  it('preserves partial-stroke coordinates and accepts legacy envelopes without geometry', () => {
    expect(schema.parse(geometry)).toEqual(geometry);
    expect(schema.parse(undefined)).toBeUndefined();
  });
  it.each([
    { x: Infinity, y: 0, width: 10, height: 20 },
    { x: 0, y: NaN, width: 10, height: 20 },
    { x: 0, y: 0, width: -1, height: 20 },
  ])('rejects invalid spatial evidence %j', (bounds) => {
    expect(schema.safeParse([{ ...geometry[0], bounds }]).success).toBe(false);
  });
});

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
