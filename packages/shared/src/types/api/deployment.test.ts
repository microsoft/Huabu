// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  canaryRedeployConfigUpdateSchema,
  canaryRedeployRequestSchema,
  canaryRedeployStatusResponseSchema,
} from './deployment.js';

describe('Canary deployment contracts', () => {
  it('accepts a nested branch and an explicit default reset', () => {
    expect(
      canaryRedeployConfigUpdateSchema.parse({ branch: 'x/alpha' }),
    ).toEqual({ branch: 'x/alpha' });
    expect(canaryRedeployConfigUpdateSchema.parse({ branch: null })).toEqual({
      branch: null,
    });
  });

  it('requires a bounded expected branch for redeployment', () => {
    expect(
      canaryRedeployRequestSchema.parse({ expectedBranch: 'x/alpha' }),
    ).toEqual({ expectedBranch: 'x/alpha' });
    expect(canaryRedeployRequestSchema.safeParse({}).success).toBe(false);
    expect(
      canaryRedeployRequestSchema.safeParse({
        expectedBranch: 'x'.repeat(256),
      }).success,
    ).toBe(false);
  });

  it('keeps current and historical branch identities in status', () => {
    expect(
      canaryRedeployStatusResponseSchema.parse({
        available: true,
        reason: 'available',
        branch: 'x/alpha',
        configuredBranch: 'x/alpha',
        runningSha: null,
        remoteSha: null,
        updateAvailable: null,
        checkedAt: null,
        redeploy: {
          state: 'succeeded',
          branch: 'alpha',
          startedAt: 1,
          completedAt: 2,
          exitCode: 0,
        },
      }),
    ).toMatchObject({
      branch: 'x/alpha',
      redeploy: { branch: 'alpha' },
    });
  });
});
