// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  profiles: [] as Array<{
    id: string;
    alias: string;
    agentletId: string;
    visible?: boolean;
  }>,
  connectedIds: [] as string[],
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({
    getProfile: async (profileId: string) =>
      host.profiles.find((profile) => profile.id === profileId),
    listProfiles: async () => host.profiles,
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
  it('does not offer or invoke a hidden connected Profile as an ordinary Agent', async () => {
    host.profiles = [
      { id: 'proxy', alias: 'Proxy', agentletId: 'device', visible: false },
    ];
    host.connectedIds = ['device'];
    expect(await listAvailableAgentProfiles()).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
    ]);
    await expect(requireAvailableAgentProfile('proxy')).rejects.toThrow(
      expect.objectContaining({ code: 'profile_not_selectable' }),
    );
  });
  it('prepends Huabu and projects available Profile identities', async () => {
    const selectable = [
      { id: 'profile-a', alias: 'Researcher', customData: { icon: 'search' } },
      { id: 'profile-b', alias: 'Builder' },
    ];

    expect(
      await listAvailableAgentProfiles({
        listSelectableProfiles: async () => selectable,
      }),
    ).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
      { id: 'profile-a', alias: 'Researcher', default: true },
      { id: 'profile-b', alias: 'Builder' },
    ]);
  });

  it('keeps the Huabu Profile available while the registry is unavailable', async () => {
    expect(await listAvailableAgentProfiles(null)).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
    ]);
  });

  it('projects only Profiles on currently connected Agentlets by default', async () => {
    host.profiles = [
      { id: 'online', alias: 'Online', agentletId: 'device-a' },
      { id: 'offline', alias: 'Offline', agentletId: 'device-b' },
    ];
    host.connectedIds = ['device-a'];

    expect(await listAvailableAgentProfiles()).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
      { id: 'online', alias: 'Online', default: true },
    ]);
  });

  it('projects a hostname-era Profile when exactly one device reports that hostname', async () => {
    host.profiles = [
      { id: 'legacy', alias: 'Legacy', agentletId: 'device-a-host' },
    ];
    host.connectedIds = ['device-a'];

    expect(await listAvailableAgentProfiles()).toEqual([
      { id: 'huabu', alias: 'Built-In Pi' },
      { id: 'legacy', alias: 'Legacy', default: true },
    ]);
  });

  it('accepts the Huabu Profile without an external registry', async () => {
    await expect(
      requireAvailableAgentProfile('huabu', null),
    ).resolves.toBeUndefined();
  });
});
