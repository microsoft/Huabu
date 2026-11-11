// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logoutOAuth, pollDeviceCode, startDeviceCodeFlow } from './oauth.js';
import {
  openPersonalSettings,
  personalSettingsOwner,
  useCaller,
} from '../identity/personal-settings.js';

import type { AuthInteraction, Credential } from '@earendil-works/pi-ai';

const login = vi.hoisted(() => vi.fn());
vi.mock('./pi-models.js', () => ({
  getPiModels: () => ({ login }),
  isOAuthProvider: () => true,
  oauthProviderIds: () => [],
  secretIdFor: (id: string) => id,
}));
vi.mock('../../security/secret-store.js', () => ({
  getSecret: () => null,
  getPersistedSecret: () => null,
}));

function as<T>(id: string | null, fn: () => T): T {
  return openPersonalSettings(() => {
    if (id)
      useCaller({
        principal: { principalId: id, kind: 'user' },
        member: true,
        owner: false,
        access: {
          can: async () => true,
          claim: async () => {},
          workspaces: async () => 'all',
        },
      });
    return fn();
  });
}

afterEach(async () => {
  for (const id of [null, 'carol', 'dave']) await as(id, () => logoutOAuth());
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('personal OAuth logins', () => {
  it('starts, polls and cancels only the caller’s own login, including the deployment', async () => {
    vi.useFakeTimers();
    const flows = new Map<
      string | null,
      { signal: AbortSignal; complete: () => void }
    >();
    login.mockImplementation(
      (_provider: string, _type: string, interaction: AuthInteraction) => {
        const owner = personalSettingsOwner();
        interaction.notify?.({
          type: 'device_code',
          userCode: owner ?? 'operator',
          verificationUri: 'https://login.example',
        });
        return new Promise<Credential>((resolve, reject) => {
          flows.set(owner, {
            signal: interaction.signal!,
            complete: () =>
              resolve({
                type: 'oauth',
                access: owner ?? 'operator',
                refresh: 'r',
                expires: Date.now() + 3600000,
              }),
          });
          interaction.signal?.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          );
        });
      },
    );
    expect(await as(null, () => startDeviceCodeFlow())).toMatchObject({
      userCode: 'operator',
    });
    expect(await as('carol', () => startDeviceCodeFlow())).toMatchObject({
      userCode: 'carol',
    });
    expect(await as('dave', () => startDeviceCodeFlow())).toMatchObject({
      userCode: 'dave',
    });
    expect([...flows.values()].every((f) => !f.signal.aborted)).toBe(true);
    await as('dave', () => logoutOAuth());
    expect(flows.get('dave')?.signal.aborted).toBe(true);
    expect(flows.get('carol')?.signal.aborted).toBe(false);
    expect(flows.get(null)?.signal.aborted).toBe(false);
    await expect(as('dave', () => pollDeviceCode())).rejects.toThrow(
      'No pending OAuth session',
    );
    flows.get('carol')?.complete();
    expect(await as('carol', () => pollDeviceCode())).toBe('complete');
    const polling = as(null, () => pollDeviceCode());
    await vi.advanceTimersByTimeAsync(500);
    expect(await polling).toBe('pending');
    flows.get(null)?.complete();
    expect(await as(null, () => pollDeviceCode())).toBe('complete');
  });
});
