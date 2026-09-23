// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProfiles = vi.hoisted(() => vi.fn());
const defaultsApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/acp', () => ({ listAcpProfiles: listProfiles }));
vi.mock('@/api/agentDefaults', () => ({
  getAgentDefaults: defaultsApi.get,
  updateAgentDefaults: defaultsApi.update,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: defaultsApi.toast }));

import {
  getDefaultAgentBinding,
  loadDefaultAgentBinding,
  useAcpProfilesStore,
} from './acpProfilesStore';

import type { AgentDefaults, AgentDefaultsResponse } from '@huabu/shared';

const profile = {
  id: 'profile-default',
  alias: 'Default Agent',
  agentletId: 'machine',
  workingDirPath: '/workspace',
  launch: { kind: 'acp-command' as const, command: 'agent' },
};
const snapshot = {
  profiles: [profile],
  selectableProfileIds: [],
  agentlet: null,
  agentDefaults: { profileId: profile.id, functionalModel: 'utility-only' },
};

beforeEach(() => {
  listProfiles.mockReset().mockResolvedValue(snapshot);
  defaultsApi.get.mockReset();
  defaultsApi.toast.mockReset();
  defaultsApi.update.mockReset().mockImplementation(
    async (defaults: AgentDefaults): Promise<AgentDefaultsResponse> => ({
      defaults,
      selectionState: 'available',
      modelCapability: 'unknown',
    }),
  );
  useAcpProfilesStore.setState({
    loaded: false,
    error: null,
    profiles: [],
    agentDefaults: null,
  });
});

describe('default Agent snapshot', () => {
  it('awaits shared initialization and selects the configured identity even while offline', async () => {
    const [first, second] = await Promise.all([
      loadDefaultAgentBinding(),
      loadDefaultAgentBinding(),
    ]);
    expect(first).toEqual({
      kind: 'external',
      profileId: profile.id,
      alias: profile.alias,
    });
    expect(second).toEqual(first);
    expect(listProfiles).toHaveBeenCalledOnce();
    expect(useAcpProfilesStore.getState().agentDefaults).toEqual(
      snapshot.agentDefaults,
    );
    expect(first).not.toHaveProperty('functionalModel');
  });

  it('keeps a deleted default ID rather than selecting the remaining Profile', async () => {
    listProfiles.mockResolvedValueOnce({
      ...snapshot,
      agentDefaults: { profileId: 'deleted', functionalModel: '' },
    });
    expect(await loadDefaultAgentBinding()).toEqual({
      kind: 'external',
      profileId: 'deleted',
      alias: 'deleted',
    });
  });

  it.each([undefined, { profileId: null, functionalModel: '' }])(
    'rejects unsupported or unconfigured defaults: %o',
    async (agentDefaults) => {
      listProfiles.mockResolvedValueOnce({ ...snapshot, agentDefaults });
      await expect(loadDefaultAgentBinding()).rejects.toThrow();
      expect(useAcpProfilesStore.getState().agentDefaults).toEqual(
        agentDefaults ?? null,
      );
    },
  );

  it('does not use a previous snapshot after a failed refresh', async () => {
    await loadDefaultAgentBinding();
    listProfiles.mockRejectedValueOnce(new Error('offline'));
    await expect(loadDefaultAgentBinding()).rejects.toThrow();
    expect(() => getDefaultAgentBinding()).toThrow();
    expect(useAcpProfilesStore.getState().profiles).toEqual([profile]);
  });

  it('serializes saves and publishes the last confirmed default for new chats', async () => {
    await loadDefaultAgentBinding();
    let finish!: (response: AgentDefaultsResponse) => void;
    defaultsApi.update.mockImplementationOnce(
      () =>
        new Promise<AgentDefaultsResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const state = useAcpProfilesStore.getState();
    const first = state.saveDefaults({
      profileId: 'first',
      functionalModel: '',
    });
    const second = state.saveDefaults({
      profileId: 'last',
      functionalModel: 'fast',
    });
    await Promise.resolve();
    expect(defaultsApi.update).toHaveBeenCalledTimes(1);
    finish({
      defaults: { profileId: 'first', functionalModel: '' },
      selectionState: 'available',
      modelCapability: 'unknown',
    });
    await Promise.all([first, second]);
    expect(
      defaultsApi.update.mock.calls.map(([config]) => config.profileId),
    ).toEqual(['first', 'last']);
    expect(getDefaultAgentBinding()).toMatchObject({
      kind: 'external',
      profileId: 'last',
    });
  });

  it('reports failed saves without blocking subsequent edits', async () => {
    defaultsApi.update.mockRejectedValueOnce(new Error('read-only'));
    const state = useAcpProfilesStore.getState();
    const first = state.saveDefaults({
      profileId: 'first',
      functionalModel: '',
    });
    const second = state.saveDefaults({
      profileId: 'last',
      functionalModel: '',
    });
    await expect(first).rejects.toThrow('read-only');
    await second;
    expect(defaultsApi.toast).toHaveBeenCalledWith('read-only', {
      tone: 'danger',
    });
    expect(useAcpProfilesStore.getState().agentDefaults?.profileId).toBe(
      'last',
    );
  });

  it('does not let an older catalogue refresh overwrite a saved default', async () => {
    let finish!: (value: typeof snapshot) => void;
    listProfiles.mockImplementationOnce(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          finish = resolve;
        }),
    );
    const refreshing = useAcpProfilesStore.getState().refresh();
    await Promise.resolve();
    await useAcpProfilesStore.getState().saveDefaults({
      profileId: 'new-default',
      functionalModel: '',
    });
    finish(snapshot);
    await refreshing;
    expect(getDefaultAgentBinding()).toMatchObject({
      kind: 'external',
      profileId: 'new-default',
    });
  });

  it('waits for closing Settings saves before loading defaults again', async () => {
    let finish!: (response: AgentDefaultsResponse) => void;
    defaultsApi.update.mockImplementationOnce(
      () =>
        new Promise<AgentDefaultsResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const state = useAcpProfilesStore.getState();
    const saving = state.saveDefaults({
      profileId: 'new-default',
      functionalModel: '',
    });
    const loading = state.loadDefaults();
    await Promise.resolve();
    expect(defaultsApi.get).not.toHaveBeenCalled();
    const response: AgentDefaultsResponse = {
      defaults: { profileId: 'new-default', functionalModel: '' },
      selectionState: 'available',
      modelCapability: 'unknown',
    };
    defaultsApi.get.mockResolvedValue(response);
    finish(response);
    await saving;
    expect(await loading).toEqual(response);
  });
});
