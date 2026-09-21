// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureProfileCacheSubscription,
  installAcpProfileCachePort,
} from './profile-cache-port.js';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  readCache: vi.fn(),
  fold: vi.fn(),
  notifications: vi.fn(),
  install: vi.fn(),
}));
vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({ getProfile: mocks.getProfile }),
}));
vi.mock('@agenetes/acp-driver', () => ({
  setAcpProfileCachePort: mocks.install,
}));
vi.mock('./profile-schema-cache.js', () => ({
  getProfileSchemaCache: mocks.readCache,
  foldMetadataIntoProfileCache: mocks.fold,
}));
vi.mock('../agenetes/drivers.js', () => ({
  agenetes: { notifications: mocks.notifications },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProfile.mockReturnValue({ executionRevision: 1 });
});

describe('Profile cache execution isolation', () => {
  it('does not warm-start an old execution from a newer Profile cache', () => {
    installAcpProfileCachePort();
    const port = mocks.install.mock.calls[0]?.[0] as {
      readCommands: (id: string, revision?: number) => unknown;
    };
    mocks.readCache.mockReturnValue({
      availableCommands: [{ name: 'new' }],
      commandsUpdatedAt: 2,
    });
    expect(port.readCommands('profile', 0)).toBeNull();
    expect(mocks.readCache).not.toHaveBeenCalled();
    expect(port.readCommands('profile', 1)).toEqual({
      availableCommands: [{ name: 'new' }],
      commandsUpdatedAt: 2,
    });
  });

  it('fences late metadata after the Profile changes during a live subscription', async () => {
    const meta = { availableCommands: [{ name: 'old' }] };
    let finished = false;
    mocks.notifications.mockImplementation(async function* () {
      yield meta;
      mocks.getProfile.mockReturnValue({ executionRevision: 2 });
      yield meta;
      finished = true;
    });
    ensureProfileCacheSubscription('thread-generation', 'profile', 1);
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(mocks.fold).toHaveBeenCalledExactlyOnceWith('profile', meta);
  });

  it('never lets legacy executions repopulate cache after a template edit or deletion', async () => {
    let finished = false;
    mocks.notifications.mockImplementation(async function* () {
      yield {};
      mocks.getProfile.mockReturnValue(undefined);
      yield {};
      finished = true;
    });
    ensureProfileCacheSubscription('thread-legacy', 'profile');
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(mocks.fold).not.toHaveBeenCalled();
  });
});
