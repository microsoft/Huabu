// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  interactiveViewActionRequestSchema,
  validateInteractiveViewStateSchema,
} from './interactive-view.js';

describe('validateInteractiveViewStateSchema', () => {
  it('rejects inconsistent bounds and undeclared required properties', () => {
    expect(
      validateInteractiveViewStateSchema({
        type: 'string',
        minLength: 4,
        maxLength: 2,
      }),
    ).toContain('minLength');
    expect(
      validateInteractiveViewStateSchema({
        type: 'number',
        minimum: 10,
        maximum: 1,
      }),
    ).toContain('minimum');
    expect(
      validateInteractiveViewStateSchema({
        type: 'array',
        items: { type: 'boolean' },
        minItems: 3,
        maxItems: 1,
      }),
    ).toContain('minItems');
    expect(
      validateInteractiveViewStateSchema({
        type: 'object',
        properties: {},
        required: ['missing'],
        additionalProperties: false,
      }),
    ).toContain('undeclared property');
    expect(
      validateInteractiveViewStateSchema({
        type: 'object',
        properties: { githubToken: { type: 'string' } },
        additionalProperties: false,
      }),
    ).toContain('prohibited secret field');
  });

  describe('interactiveViewActionRequestSchema', () => {
    it('rejects oversized and deeply nested iframe input', () => {
      expect(
        interactiveViewActionRequestSchema.safeParse({
          input: 'x'.repeat(65_537),
        }).success,
      ).toBe(false);

      let input: unknown = true;
      for (let depth = 0; depth < 34; depth += 1) input = [input];
      expect(
        interactiveViewActionRequestSchema.safeParse({ input }).success,
      ).toBe(false);
    });
  });

  it('accepts nested schemas with consistent constraints', () => {
    expect(
      validateInteractiveViewStateSchema({
        type: 'object',
        properties: {
          labels: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 20 },
            minItems: 0,
            maxItems: 10,
          },
        },
        required: ['labels'],
        additionalProperties: false,
      }),
    ).toBeNull();
  });
});
