// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECRET_IDS } from '../../security/secret-ids.js';

const getPersistedSecret = vi.fn<(id: string) => string | null>();
const setSecret = vi.fn<(id: string, value: string | null) => Promise<void>>();

vi.mock('../../security/secret-store.js', () => ({
  getPersistedSecret: (id: string) => getPersistedSecret(id),
  getSecret: () => null,
  setSecret: (id: string, value: string | null) => setSecret(id, value),
}));

const { logoutOAuth } = await import('./oauth.js');

describe('logoutOAuth', () => {
  beforeEach(() => {
    getPersistedSecret.mockReset().mockReturnValue(null);
    setSecret.mockReset().mockResolvedValue(undefined);
  });

  it('is a no-op success when no credentials are stored (env-only mode)', async () => {
    getPersistedSecret.mockReturnValue(null);

    await expect(logoutOAuth()).resolves.toBeUndefined();
    // Nothing to delete → must not attempt a (read-only) write.
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('deletes stored credentials when present', async () => {
    getPersistedSecret.mockReturnValue('{"refresh":"r","access":"a"}');

    await logoutOAuth();

    expect(setSecret).toHaveBeenCalledWith(SECRET_IDS.copilotOAuth, null);
  });

  it('propagates a deletion failure instead of reporting success', async () => {
    getPersistedSecret.mockReturnValue('{"refresh":"r","access":"a"}');
    setSecret.mockRejectedValueOnce(new Error('bridge timeout'));

    // Models.logout wraps the underlying store error, but the rejection must
    // still propagate so the client is never told "logged out" while the
    // credential remains on disk.
    await expect(logoutOAuth()).rejects.toThrow();
  });
});
