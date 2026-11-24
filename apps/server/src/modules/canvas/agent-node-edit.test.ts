// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentNodeEditError,
  withDefaultAgentBinding,
} from './agent-node-edit.js';

import type * as SelectableProfiles from '../agent/selectable-agent-profile.js';

const mocks = vi.hoisted(() => ({
  firstProfile: vi.fn(),
}));

vi.mock('../agent/selectable-agent-profile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SelectableProfiles>()),
  getFirstSelectableAgentProfile: mocks.firstProfile,
}));

describe('new Agent Node default binding', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.firstProfile.mockResolvedValue({
      id: 'external-default',
      alias: 'External',
    });
  });

  it('snapshots the selected external Profile without using functional model preferences', async () => {
    expect(await withDefaultAgentBinding({ label: 'New Agent' })).toEqual({
      label: 'New Agent',
      agentBinding: {
        kind: 'external',
        profileId: 'external-default',
        alias: 'External',
      },
    });
    expect(mocks.firstProfile).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'internal' as const },
    { kind: 'external' as const, profileId: 'explicit-profile' },
  ])('preserves an explicitly supplied binding: %j', async (agentBinding) => {
    const data = { agentBinding };
    expect(await withDefaultAgentBinding(data)).toBe(data);
    expect(mocks.firstProfile).not.toHaveBeenCalled();
  });

  it('reports that no external Profile is available', async () => {
    mocks.firstProfile.mockResolvedValue(null);
    await expect(withDefaultAgentBinding({})).rejects.toThrow(
      AgentNodeEditError,
    );
  });

  it('uses a default the caller already resolved for this write', async () => {
    const resolveDefault = vi
      .fn()
      .mockResolvedValue({ kind: 'external', profileId: 'shared' });
    expect(await withDefaultAgentBinding({}, resolveDefault)).toEqual({
      agentBinding: { kind: 'external', profileId: 'shared' },
    });
    expect(mocks.firstProfile).not.toHaveBeenCalled();
  });
});
