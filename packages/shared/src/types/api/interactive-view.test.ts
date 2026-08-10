// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  createInteractiveViewRequestSchema,
  interactiveViewActionRequestSchema,
  validateInteractiveViewStateSchema,
} from './interactive-view.js';

describe('createInteractiveViewRequestSchema', () => {
  const request = {
    rendererArtifact: 'upload/view.html',
    ownerThreadId: 'thread-owner',
    state: {
      schema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: false as const,
      },
      value: {},
    },
    position: { x: 0, y: 0 },
  };

  it('accepts only one safe HTML renderer filename', () => {
    expect(createInteractiveViewRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      createInteractiveViewRequestSchema.safeParse({
        ...request,
        rendererArtifact: 'upload/../view.html',
      }).success,
    ).toBe(false);
    expect(
      createInteractiveViewRequestSchema.safeParse({
        ...request,
        rendererArtifact: 'upload/view name.html',
      }).success,
    ).toBe(false);
  });
});

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
