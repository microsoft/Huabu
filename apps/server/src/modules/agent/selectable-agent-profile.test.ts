// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  listAvailableAgentProfiles,
  requireAvailableAgentProfile,
} from './selectable-agent-profile.js';

describe('listAvailableAgentProfiles', () => {
  it('prepends Huabu and projects available Profile identities', () => {
    const profiles = new Map([
      [
        'profile-a',
        {
          id: 'profile-a',
          alias: 'Researcher',
          customData: { icon: 'search' },
        },
      ],
      ['profile-b', { id: 'profile-b', alias: 'Builder' }],
      ['profile-hidden', { id: 'profile-hidden', alias: 'Hidden' }],
    ]);

    expect(
      listAvailableAgentProfiles(
        {
          getProfile: (id: string) => profiles.get(id),
          listSelectableProfileIds: () => ['profile-a', 'profile-b'],
        },
        'profile-b',
      ),
    ).toEqual([
      { id: 'huabu', alias: 'Huabu' },
      { id: 'profile-a', alias: 'Researcher' },
      { id: 'profile-b', alias: 'Builder', default: true },
    ]);
  });

  it('keeps the Huabu Profile available while the registry is unavailable', () => {
    expect(listAvailableAgentProfiles(null, null)).toEqual([
      { id: 'huabu', alias: 'Huabu' },
    ]);
  });

  it('does not mark another Profile as default when the selected one is missing', () => {
    expect(
      listAvailableAgentProfiles(
        {
          getProfile: () => ({ id: 'other', alias: 'Other' }),
          listSelectableProfileIds: () => ['other'],
        },
        'deleted',
      ),
    ).toEqual([
      { id: 'huabu', alias: 'Huabu' },
      { id: 'other', alias: 'Other' },
    ]);
  });

  it('accepts the Huabu Profile without an external registry', () => {
    expect(() => requireAvailableAgentProfile('huabu', null)).not.toThrow();
  });
});
