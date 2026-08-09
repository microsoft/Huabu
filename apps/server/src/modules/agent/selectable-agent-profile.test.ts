// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  listSelectableAgentProfiles,
  SelectableAgentProfileError,
} from './selectable-agent-profile.js';

describe('listSelectableAgentProfiles', () => {
  it('projects only selectable Profile identity fields in registry order', () => {
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
      listSelectableAgentProfiles({
        getProfile: (id) => profiles.get(id),
        listSelectableProfileIds: () => ['profile-a', 'profile-b'],
      }),
    ).toEqual([
      { id: 'profile-a', alias: 'Researcher' },
      { id: 'profile-b', alias: 'Builder' },
    ]);
  });

  it('fails explicitly while the registry is unavailable', () => {
    expect(() => listSelectableAgentProfiles(null)).toThrow(
      SelectableAgentProfileError,
    );
  });
});
