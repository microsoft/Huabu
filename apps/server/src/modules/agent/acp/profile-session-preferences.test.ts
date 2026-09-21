// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  it('reads only the supported string preferences', () => {
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

    expect(getProfileSessionPreferences('profile-1')).toEqual({
      model: 'claude-opus',
      thoughtLevel: 'high',
    });
  });

  it('preserves unrelated custom data when remembering a preference', () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
      customData: {
        icon: { shape: 'circle', color: 'blue' },
        sessionPreferences: { model: 'gpt-5' },
      },
    });

    rememberProfileSessionPreference('profile-1', 'thoughtLevel', 'high');

    expect(mocks.patchProfile).toHaveBeenCalledWith('profile-1', {
      customData: {
        icon: { shape: 'circle', color: 'blue' },
        sessionPreferences: { model: 'gpt-5', thoughtLevel: 'high' },
      },
    });
  });

  it('remembers only model and thought-level config options', () => {
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

    rememberProfileConfigPreference('profile-1', options, 'allow_all', true);
    rememberProfileConfigPreference(
      'profile-1',
      options,
      'mode',
      'agent-full-access',
    );
    rememberProfileConfigPreference(
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
    });
  });

  it('keeps Custom model choices session-local even when metadata names a known harness', () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-command', command: 'copilot --acp' },
      metadata: { cliId: 'copilot' },
      customData: { sessionPreferences: { model: 'old' } },
    });
    expect(getProfileSessionPreferences('custom')).toEqual({});
    rememberProfileSessionPreference('custom', 'model', 'new');
    expect(mocks.patchProfile).not.toHaveBeenCalled();
  });

  it('does not let an old execution overwrite preferences after a Profile edit', () => {
    mocks.getProfile.mockReturnValue({
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
      executionRevision: 2,
    });
    rememberProfileSessionPreference('profile', 'model', 'stale', 1);
    expect(mocks.patchProfile).not.toHaveBeenCalled();
    rememberProfileSessionPreference('profile', 'model', 'current', 2);
    expect(mocks.patchProfile).toHaveBeenCalledOnce();
  });
});
