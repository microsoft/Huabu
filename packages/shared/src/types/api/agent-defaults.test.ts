// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { agentDefaultsSchema } from './agent-defaults.js';

describe('Agent defaults contract', () => {
  it('trims model overrides and allows inheritance', () => {
    expect(
      agentDefaultsSchema.parse({
        profileId: 'external',
        functionalModel: '  fast  ',
      }),
    ).toEqual({ profileId: 'external', functionalModel: 'fast' });
    expect(
      agentDefaultsSchema.parse({ profileId: null, functionalModel: ' \t ' }),
    ).toEqual({ profileId: null, functionalModel: '' });
    expect(agentDefaultsSchema.parse({ profileId: null }).functionalModel).toBe(
      '',
    );
  });

  it.each([
    null,
    {},
    { profileId: 'huabu' },
    { profileId: ' huabu ' },
    { profileId: '' },
    { profileId: 1 },
    { profileId: 'external', functionalModel: null },
    { profileId: 'external', functionalModel: 123 },
    { profileId: 'external', functionalModel: 'a'.repeat(501) },
    { profileId: 'external', permissions: 'auto-approve' },
  ])('rejects invalid configuration %j', (value) => {
    expect(agentDefaultsSchema.safeParse(value).success).toBe(false);
  });
});
