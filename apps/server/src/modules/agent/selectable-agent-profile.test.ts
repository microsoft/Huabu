// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  profiles: [] as Array<{ id: string; alias: string; agentletId: string }>,
  connectedIds: [] as string[],
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({
    getProfile: (profileId: string) =>
      host.profiles.find((profile) => profile.id === profileId),
    listProfiles: () => host.profiles,
  }),
  resolveConnectedAgentletId: (target: string) => {
    if (host.connectedIds.includes(target)) return target;
    const matches = host.connectedIds.filter(
      (agentletId) => `${agentletId}-host` === target,
    );
    return matches.length === 1 ? matches[0] : undefined;
  },
}));

import {
  listAvailableAgentProfiles,
  requireAvailableAgentProfile,
} from './selectable-agent-profile.js';

afterEach(() => {
  host.profiles = [];
  host.connectedIds = [];
});

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
      listAvailableAgentProfiles({
        getProfile: (id: string) => profiles.get(id),
        listSelectableProfileIds: () => ['profile-a', 'profile-b'],
      }),
    ).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
      { id: 'profile-a', alias: 'Researcher', default: true },
      { id: 'profile-b', alias: 'Builder' },
    ]);
  });

  it('keeps the Huabu Profile available while the registry is unavailable', () => {
    expect(listAvailableAgentProfiles(null)).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
    ]);
  });

  it('projects only Profiles on currently connected Agentlets by default', () => {
    host.profiles = [
      { id: 'online', alias: 'Online', agentletId: 'device-a' },
      { id: 'offline', alias: 'Offline', agentletId: 'device-b' },
    ];
    host.connectedIds = ['device-a'];

    expect(listAvailableAgentProfiles()).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
      { id: 'online', alias: 'Online', default: true },
    ]);
  });

  it('projects a hostname-era Profile when exactly one device reports that hostname', () => {
    host.profiles = [
      { id: 'legacy', alias: 'Legacy', agentletId: 'device-a-host' },
    ];
    host.connectedIds = ['device-a'];

    expect(listAvailableAgentProfiles()).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
      { id: 'legacy', alias: 'Legacy', default: true },
    ]);
  });

  it('accepts the Huabu Profile without an external registry', () => {
    expect(() => requireAvailableAgentProfile('huabu', null)).not.toThrow();
  });
});
