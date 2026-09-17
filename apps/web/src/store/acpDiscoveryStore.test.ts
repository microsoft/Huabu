// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/api/acp', () => ({
  listAcpAgentClis: api.list,
  refreshAcpAgentClis: api.refresh,
}));

import { useAcpDiscoveryStore } from './acpDiscoveryStore';

const machine = {
  agentletId: 'machine-a',
  hostname: 'Workstation',
  platform: 'linux',
  connected: true,
  discovery: 'ready' as const,
  agents: [],
};

beforeEach(() => {
  api.list.mockReset();
  api.refresh.mockReset();
  useAcpDiscoveryStore.setState({
    machines: [],
    loaded: false,
    loading: false,
    error: null,
  });
});

describe('acpDiscoveryStore', () => {
  it('loads the cached projection and explicitly refreshes one machine', async () => {
    api.list.mockResolvedValue({ machines: [machine] });
    api.refresh.mockResolvedValue({
      machines: [{ ...machine, refreshedAt: 2 }],
    });

    await useAcpDiscoveryStore.getState().init();
    expect(useAcpDiscoveryStore.getState().machines).toEqual([machine]);

    await useAcpDiscoveryStore.getState().refresh('machine-a');
    expect(api.refresh).toHaveBeenCalledWith({ agentletId: 'machine-a' });
    expect(useAcpDiscoveryStore.getState().machines[0]?.refreshedAt).toBe(2);
  });
});
