// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECRET_IDS } from '../../security/secret-ids.js';

let storedSecret: string | null = null;
const setSecret = vi.fn<(id: string, value: string | null) => Promise<void>>();

vi.mock('../../security/secret-store.js', () => ({
  getSecret: () => storedSecret,
  setSecret: async (id: string, value: string | null) => {
    await setSecret(id, value);
    storedSecret = value;
  },
}));

const { credentialStore } = await import('./pi-models.js');

describe('pi-ai credential store adapter', () => {
  beforeEach(() => {
    storedSecret = null;
    setSecret.mockReset().mockResolvedValue(undefined);
  });

  it('leaves a credential unchanged when modify returns undefined', async () => {
    const refreshed = {
      type: 'oauth' as const,
      access: 'fresh-access',
      refresh: 'refresh-token',
      expires: Date.now() + 30 * 60_000,
    };
    storedSecret = JSON.stringify(refreshed);

    const result = await credentialStore.modify(
      'github-copilot',
      async () => undefined,
    );

    expect(result).toEqual(refreshed);
    expect(storedSecret).toBe(JSON.stringify(refreshed));
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('persists a refreshed credential before a following no-op modify', async () => {
    const expired = {
      type: 'oauth' as const,
      access: 'expired-access',
      refresh: 'refresh-token',
      expires: Date.now() - 1,
    };
    const refreshed = {
      ...expired,
      access: 'fresh-access',
      expires: Date.now() + 30 * 60_000,
    };
    storedSecret = JSON.stringify(expired);

    await credentialStore.modify('github-copilot', async () => refreshed);
    const result = await credentialStore.modify(
      'github-copilot',
      async () => undefined,
    );

    expect(result).toEqual(refreshed);
    expect(storedSecret).toBe(JSON.stringify(refreshed));
    expect(setSecret).toHaveBeenCalledOnce();
    expect(setSecret).toHaveBeenCalledWith(
      SECRET_IDS.copilotOAuth,
      JSON.stringify(refreshed),
    );
  });
});
