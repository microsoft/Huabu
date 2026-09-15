// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { agentChangeReviewConfigSchema } from './agent-change-review.js';

describe('agentChangeReviewConfigSchema', () => {
  it('accepts the complete global preference', () => {
    expect(
      agentChangeReviewConfigSchema.parse({
        autoAcceptSpaceChanges: true,
      }),
    ).toEqual({ autoAcceptSpaceChanges: true });
  });

  it('rejects missing, non-boolean, and unknown fields', () => {
    expect(agentChangeReviewConfigSchema.safeParse({}).success).toBe(false);
    expect(
      agentChangeReviewConfigSchema.safeParse({
        autoAcceptSpaceChanges: 'yes',
      }).success,
    ).toBe(false);
    expect(
      agentChangeReviewConfigSchema.safeParse({
        autoAcceptSpaceChanges: false,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
