// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECRET_IDS } from '../../security/secret-ids.js';

const getPersistedSecret = vi.fn<(id: string) => string | null>();
const setSecrets =
  vi.fn<(updates: Record<string, string | null>) => Promise<void>>();

vi.mock('../../security/secret-store.js', () => ({
  getPersistedSecret: (id: string) => getPersistedSecret(id),
  getSecret: () => null,
  setSecrets: (updates: Record<string, string | null>) => setSecrets(updates),
}));

const { setIntegrationsConfig } = await import('./integrations.js');

describe('setIntegrationsConfig', () => {
  beforeEach(() => {
    getPersistedSecret.mockReset().mockReturnValue(null);
    setSecrets.mockReset().mockResolvedValue(undefined);
  });

  it('writes all touched keys in a single batched call', async () => {
    await setIntegrationsConfig({
      tavilyApiKey: 'tav',
      rapidApiKey: 'rap',
    });

    expect(setSecrets).toHaveBeenCalledTimes(1);
    expect(setSecrets).toHaveBeenCalledWith({
      [SECRET_IDS.tavilyApiKey]: 'tav',
      [SECRET_IDS.rapidApiKey]: 'rap',
    });
  });

  it('does not write when no key is supplied', async () => {
    await setIntegrationsConfig({});
    expect(setSecrets).not.toHaveBeenCalled();
  });

  it('removes keys explicitly set to null', async () => {
    await setIntegrationsConfig({ tavilyApiKey: null });

    expect(setSecrets).toHaveBeenCalledWith({
      [SECRET_IDS.tavilyApiKey]: null,
    });
  });

  it('propagates a batch write failure to the caller', async () => {
    setSecrets.mockRejectedValueOnce(new Error('disk full'));

    // NOTE: this asserts the service layer surfaces the error, not backend
    // atomicity. The encrypted-file backend replaces the file atomically, but
    // the Electron bridge writes sequentially, so a real partial commit is
    // still possible there until a batch IPC message exists.
    await expect(
      setIntegrationsConfig({ tavilyApiKey: 'tav', rapidApiKey: 'rap' }),
    ).rejects.toThrow('disk full');
    expect(setSecrets).toHaveBeenCalledTimes(1);
  });
});
