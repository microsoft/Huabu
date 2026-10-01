// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  agentDefaultsSchema,
  conversationAgentPreferenceSchema,
} from './agent-defaults.js';

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

  describe('conversation Agent preference contract', () => {
    it('accepts an explicit Profile or a never-selected state', () => {
      expect(
        conversationAgentPreferenceSchema.parse({ profileId: ' profile-a ' }),
      ).toEqual({ profileId: 'profile-a' });
      expect(
        conversationAgentPreferenceSchema.parse({ profileId: null }),
      ).toEqual({ profileId: null });
    });

    it.each([
      {},
      { profileId: '' },
      { profileId: 1 },
      { profileId: null, functionalModel: '' },
    ])('rejects invalid preference %j', (value) => {
      expect(conversationAgentPreferenceSchema.safeParse(value).success).toBe(
        false,
      );
    });
  });

  it.each(['huabu', ' huabu '])(
    'accepts the explicit Built-In selection %j',
    (profileId) => {
      expect(agentDefaultsSchema.parse({ profileId })).toEqual({
        profileId: 'huabu',
        functionalModel: '',
      });
      expect(
        agentDefaultsSchema.parse({
          profileId,
          functionalModel: ' saved-model ',
        }),
      ).toEqual({ profileId: 'huabu', functionalModel: 'saved-model' });
    },
  );

  it.each([
    null,
    {},
    { profileId: '' },
    { profileId: ' \t ' },
    { profileId: 1 },
    { profileId: 'external', functionalModel: null },
    { profileId: 'external', functionalModel: 123 },
    { profileId: 'external', functionalModel: 'a'.repeat(501) },
    { profileId: 'external', permissions: 'auto-approve' },
  ])('rejects invalid configuration %j', (value) => {
    expect(agentDefaultsSchema.safeParse(value).success).toBe(false);
  });
});
