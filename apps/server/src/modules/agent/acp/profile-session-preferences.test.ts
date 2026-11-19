// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AgentProfileRegistry,
  InMemoryAgentProfileRegistryStore,
} from '@agenetes/agent-profile';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getProfileSessionPreferences,
  rememberProfileConfigPreference,
  rememberProfileSessionPreference,
} from './profile-session-preferences.js';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  patchProfile: vi.fn(),
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({
    getProfile: mocks.getProfile,
    patchProfile: mocks.patchProfile,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ACP Profile session preferences', () => {
  it('reads only the supported string preferences', async () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
      customData: {
        sessionPreferences: {
          model: 'claude-opus',
          thoughtLevel: 'high',
          allow_all: true,
        },
      },
    });

    expect(await getProfileSessionPreferences('profile-1')).toEqual({
      model: 'claude-opus',
      thoughtLevel: 'high',
    });
  });

  it('preserves unrelated custom data when remembering a preference', async () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
      customData: {
        icon: { shape: 'circle', color: 'blue' },
        sessionPreferences: { model: 'gpt-5' },
      },
    });

    await rememberProfileSessionPreference('profile-1', 'thoughtLevel', 'high');

    expect(mocks.patchProfile).toHaveBeenCalledWith('profile-1', {
      customData: {
        icon: { shape: 'circle', color: 'blue' },
        sessionPreferences: { model: 'gpt-5', thoughtLevel: 'high' },
      },
      expectedRevision: 0,
    });
  });

  it('remembers only model and thought-level config options', async () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
      customData: {},
    });
    const options = [
      { id: 'model_id', category: 'model' },
      { id: 'reasoning', category: 'thought_level' },
      { id: 'allow_all', category: 'permission' },
      { id: 'mode', category: 'mode' },
    ];

    await rememberProfileConfigPreference(
      'profile-1',
      options,
      'allow_all',
      true,
    );
    await rememberProfileConfigPreference(
      'profile-1',
      options,
      'mode',
      'agent-full-access',
    );
    await rememberProfileConfigPreference(
      'profile-1',
      options,
      'model_id',
      'claude-opus',
    );

    expect(mocks.patchProfile).toHaveBeenCalledOnce();
    expect(mocks.patchProfile).toHaveBeenCalledWith('profile-1', {
      customData: {
        sessionPreferences: { model: 'claude-opus' },
      },
      expectedRevision: 0,
    });
  });

  it('keeps Custom model choices session-local even when metadata names a known harness', async () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-command', command: 'copilot --acp' },
      metadata: { cliId: 'copilot' },
      customData: { sessionPreferences: { model: 'old' } },
    });
    expect(await getProfileSessionPreferences('custom')).toEqual({});
    await rememberProfileSessionPreference('custom', 'model', 'new');
    expect(mocks.patchProfile).not.toHaveBeenCalled();
  });

  it('does not let an old execution overwrite preferences after a Profile edit', async () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
      executionRevision: 2,
    });
    await rememberProfileSessionPreference('profile', 'model', 'stale', 1);
    expect(mocks.patchProfile).not.toHaveBeenCalled();
    await rememberProfileSessionPreference('profile', 'model', 'current', 2);
    expect(mocks.patchProfile).toHaveBeenCalledOnce();
  });

  describe('against a registry with concurrent edits', () => {
    async function harness() {
      const registry = await AgentProfileRegistry.open(
        new InMemoryAgentProfileRegistryStore(),
      );
      const profile = await registry.createProfile({
        launchKind: 'acp-harness',
        harnessId: 'copilot',
        alias: 'Copilot',
        agentletId: 'device',
        workingDirPath: '/work',
      });
      mocks.getProfile.mockImplementation((id: string) =>
        registry.getProfile(id),
      );
      mocks.patchProfile.mockImplementation(
        (id: string, input: Parameters<typeof registry.patchProfile>[1]) =>
          registry.patchProfile(id, input),
      );
      return { registry, id: profile.id };
    }

    it('keeps both of two preferences remembered at once', async () => {
      const { id } = await harness();
      await Promise.all([
        rememberProfileSessionPreference(id, 'model', 'claude-opus'),
        rememberProfileSessionPreference(id, 'thoughtLevel', 'high'),
      ]);
      expect(await getProfileSessionPreferences(id)).toEqual({
        model: 'claude-opus',
        thoughtLevel: 'high',
      });
    });

    it('drops a preference whose execution was relaunched while it was merged', async () => {
      const { registry, id } = await harness();
      const read = registry.getProfile.bind(registry);
      let reads = 0;
      mocks.getProfile.mockImplementation(async (profileId: string) => {
        const profile = await read(profileId);
        // The working directory changes after the first read.
        if (++reads === 1)
          await registry.patchProfile(id, { workingDirPath: '/elsewhere' });
        return profile;
      });
      await rememberProfileSessionPreference(id, 'model', 'stale', 0);
      expect(await getProfileSessionPreferences(id)).toEqual({});
      expect((await registry.getProfile(id))?.executionRevision).toBe(1);
    });

    it('drops a preference whose Profile was deleted while it was merged', async () => {
      const { registry, id } = await harness();
      const read = registry.getProfile.bind(registry);
      mocks.getProfile.mockImplementation(async (profileId: string) => {
        const profile = await read(profileId);
        // Deleted after the read, before the patch.
        await registry.deleteProfile(id);
        return profile;
      });
      await expect(
        rememberProfileSessionPreference(id, 'model', 'orphan', 0),
      ).resolves.toBeUndefined();
      expect(await registry.getProfile(id)).toBeUndefined();
    });
  });
});
