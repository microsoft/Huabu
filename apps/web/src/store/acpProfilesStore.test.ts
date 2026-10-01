// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProfiles = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  getDefaults: vi.fn(),
  updateDefaults: vi.fn(),
  getConversation: vi.fn(),
  updateConversation: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/acp', () => ({ listAcpProfiles: listProfiles }));
vi.mock('@/api/agentDefaults', () => ({
  getAgentDefaults: api.getDefaults,
  updateAgentDefaults: api.updateDefaults,
  getConversationAgentPreference: api.getConversation,
  updateConversationAgentPreference: api.updateConversation,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: api.toast }));

import {
  getDefaultAgentBinding,
  loadDefaultAgentBinding,
  rememberConversationAgentBinding,
  useAcpProfilesStore,
} from './acpProfilesStore';

import type {
  AgentDefaults,
  AgentDefaultsResponse,
  ConversationAgentPreferenceResponse,
} from '@huabu/shared';

const profile = {
  id: 'profile-default',
  alias: 'Default Agent',
  agentletId: 'machine',
  workingDirPath: '/workspace',
  launch: { kind: 'acp-command' as const, command: 'agent' },
};
const snapshot = {
  profiles: [profile],
  selectableProfileIds: [profile.id],
  agentlet: null,
  agentDefaults: { profileId: 'huabu', functionalModel: 'utility-only' },
};

function conversation(
  profileId: string | null,
  selectionState:
    | 'unconfigured'
    | 'deleted'
    | 'offline'
    | 'available' = profileId ? 'available' : 'unconfigured',
): ConversationAgentPreferenceResponse {
  return {
    preference: { profileId },
    effectiveProfileId: profileId,
    selectionState,
  };
}

beforeEach(() => {
  listProfiles.mockReset().mockResolvedValue(snapshot);
  api.getDefaults.mockReset().mockResolvedValue({
    defaults: snapshot.agentDefaults,
    selectionState: 'available',
    modelCapability: 'supported',
  });
  api.updateDefaults.mockReset().mockImplementation(
    async (defaults: AgentDefaults): Promise<AgentDefaultsResponse> => ({
      defaults,
      selectionState: 'available',
      modelCapability: 'unknown',
    }),
  );
  api.getConversation.mockReset().mockResolvedValue(conversation(profile.id));
  api.updateConversation
    .mockReset()
    .mockImplementation(async ({ profileId }: { profileId: string | null }) =>
      conversation(profileId),
    );
  api.toast.mockReset();
  useAcpProfilesStore.setState({
    loaded: false,
    error: null,
    profiles: [profile],
    agentDefaults: null,
    defaultsError: null,
    conversationAgent: null,
    conversationAgentError: null,
  });
});

describe('conversation Agent snapshot', () => {
  it('deduplicates canonical preference loading and resolves the effective Profile', async () => {
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
    expect(api.getConversation).toHaveBeenCalledOnce();
    expect(api.getDefaults).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'offline'] as const)(
    'rejects a %s recently used Profile instead of silently falling back',
    async (selectionState) => {
      api.getConversation.mockResolvedValueOnce(
        conversation('stale-profile', selectionState),
      );
      await expect(loadDefaultAgentBinding()).rejects.toThrow();
      expect(() => getDefaultAgentBinding()).toThrow();
    },
  );

  it('accepts the server-projected first Profile when no preference exists', async () => {
    api.getConversation.mockResolvedValueOnce({
      preference: { profileId: null },
      effectiveProfileId: profile.id,
      selectionState: 'available',
    });
    await expect(loadDefaultAgentBinding()).resolves.toMatchObject({
      kind: 'external',
      profileId: profile.id,
    });
  });

  it('supports Built-In Pi as an explicit conversational choice', async () => {
    api.getConversation.mockResolvedValueOnce(conversation('huabu'));
    await expect(loadDefaultAgentBinding()).resolves.toEqual({
      kind: 'internal',
    });
  });

  it('remembers explicit conversational use independently of Utility Agent settings', async () => {
    await rememberConversationAgentBinding({
      kind: 'external',
      profileId: profile.id,
      alias: profile.alias,
    });
    expect(api.updateConversation).toHaveBeenCalledWith({
      profileId: profile.id,
    });
    expect(getDefaultAgentBinding()).toMatchObject({
      profileId: profile.id,
    });
    expect(useAcpProfilesStore.getState().agentDefaults).toBeNull();
  });

  it('does not let Utility Agent changes reroute new conversations', async () => {
    await loadDefaultAgentBinding();
    await useAcpProfilesStore.getState().saveDefaults({
      profileId: 'huabu',
      functionalModel: '',
    });
    expect(getDefaultAgentBinding()).toMatchObject({
      kind: 'external',
      profileId: profile.id,
    });
  });

  it('serializes conversational choices so the last explicit selection wins', async () => {
    let finish!: (response: ConversationAgentPreferenceResponse) => void;
    api.updateConversation.mockImplementationOnce(
      () =>
        new Promise<ConversationAgentPreferenceResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const first = useAcpProfilesStore
      .getState()
      .rememberConversationAgent('first');
    const second = useAcpProfilesStore
      .getState()
      .rememberConversationAgent('second');
    await Promise.resolve();
    expect(api.updateConversation).toHaveBeenCalledTimes(1);
    finish(conversation('first'));
    await Promise.all([first, second]);
    expect(
      api.updateConversation.mock.calls.map(([value]) => value.profileId),
    ).toEqual(['first', 'second']);
    expect(getDefaultAgentBinding()).toMatchObject({ profileId: 'second' });
  });
});

describe('Utility Agent settings', () => {
  it('serializes saves and publishes the last confirmed settings', async () => {
    let finish!: (response: AgentDefaultsResponse) => void;
    api.updateDefaults.mockImplementationOnce(
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
    expect(api.updateDefaults).toHaveBeenCalledTimes(1);
    finish({
      defaults: { profileId: 'first', functionalModel: '' },
      selectionState: 'available',
      modelCapability: 'unknown',
    });
    await Promise.all([first, second]);
    expect(
      api.updateDefaults.mock.calls.map(([config]) => config.profileId),
    ).toEqual(['first', 'last']);
    expect(useAcpProfilesStore.getState().agentDefaults).toEqual({
      profileId: 'last',
      functionalModel: 'fast',
    });
  });

  it('reports failed saves without blocking subsequent edits', async () => {
    api.updateDefaults.mockRejectedValueOnce(new Error('read-only'));
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
    expect(api.toast).toHaveBeenCalledWith('read-only', { tone: 'danger' });
    expect(useAcpProfilesStore.getState().agentDefaults?.profileId).toBe(
      'last',
    );
  });

  it('does not let an older catalogue refresh overwrite a saved setting', async () => {
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
      profileId: 'new-utility',
      functionalModel: '',
    });
    finish(snapshot);
    await refreshing;
    expect(useAcpProfilesStore.getState().agentDefaults?.profileId).toBe(
      'new-utility',
    );
  });
});
