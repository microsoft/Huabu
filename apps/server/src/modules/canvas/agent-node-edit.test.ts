// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentNodeEditError,
  withDefaultAgentBinding,
} from './agent-node-edit.js';
import { SelectableAgentProfileError } from '../agent/selectable-agent-profile.js';

import type * as SelectableProfiles from '../agent/selectable-agent-profile.js';

const mocks = vi.hoisted(() => ({
  defaults: vi.fn(),
  profile: vi.fn(),
}));

vi.mock('../agent/agent-defaults.js', () => ({
  getAgentDefaults: mocks.defaults,
}));

vi.mock('../agent/selectable-agent-profile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SelectableProfiles>()),
  requireSelectableAgentProfile: mocks.profile,
}));

describe('new Agent Node default binding', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.defaults.mockReturnValue({
      profileId: 'external-default',
      functionalModel: '',
    });
    mocks.profile.mockReturnValue({
      id: 'external-default',
      alias: 'External',
    });
  });

  it('snapshots the selected external Profile without using functional model preferences', () => {
    expect(withDefaultAgentBinding({ label: 'New Agent' })).toEqual({
      label: 'New Agent',
      agentBinding: {
        kind: 'external',
        profileId: 'external-default',
        alias: 'External',
      },
    });
    expect(mocks.profile).toHaveBeenCalledWith('external-default');
  });

  it.each([
    { kind: 'internal' as const },
    { kind: 'external' as const, profileId: 'explicit-profile' },
  ])('preserves an explicitly supplied binding: %j', (agentBinding) => {
    const data = { agentBinding };
    expect(withDefaultAgentBinding(data)).toBe(data);
    expect(mocks.defaults).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it('reports an unconfigured default instead of silently choosing internal', () => {
    mocks.defaults.mockReturnValue({ profileId: null, functionalModel: '' });
    expect(() => withDefaultAgentBinding({})).toThrow(AgentNodeEditError);
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it('maps an unavailable saved Profile to an actionable Canvas error', () => {
    mocks.profile.mockImplementation(() => {
      throw new SelectableAgentProfileError(
        'profile_not_selectable',
        'Profile is unavailable',
      );
    });
    expect(() => withDefaultAgentBinding({})).toThrow(AgentNodeEditError);
    expect(() => withDefaultAgentBinding({})).toThrow('Profile is unavailable');
  });
});
