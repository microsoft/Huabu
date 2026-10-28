// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedIdentity } from './service.js';

/**
 * A member's model keys and connected credentials are their own: the secret
 * store and the settings files answer from a personal namespace, and the
 * deployment's environment, which is the operator's, is never theirs.
 */

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['HUABU_DATA_DIR', 'HUABU_SECRET_KEY', 'TAVILY_API_KEY'];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-personal-settings-'));
  for (const key of ENV) saved[key] = process.env[key];
  process.env.HUABU_DATA_DIR = tmp;
  process.env.TAVILY_API_KEY = 'operator-env-key';
  delete process.env.HUABU_SECRET_KEY;
  vi.resetModules();
});
afterEach(() => {
  for (const key of ENV)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  rmSync(tmp, { recursive: true, force: true });
});

const person = (principalId: string, owner = false): ResolvedIdentity => ({
  principal: { principalId, kind: 'user' },
  member: true,
  owner,
  access: {
    can: async () => true,
    claim: async () => {},
    workspaces: async () => 'all',
  },
});

describe('personal settings', () => {
  it('keeps each member’s credentials apart from the deployment’s and each other’s', async () => {
    const store = await import('../../security/secret-store.js');
    const scope = await import('./personal-settings.js');
    const { SECRET_IDS } = await import('../../security/secret-ids.js');
    await store.initializeSecretStore();
    const as = <T>(identity: ResolvedIdentity | null, fn: () => T) =>
      scope.openPersonalSettings(() => {
        if (identity) scope.useCaller(identity);
        return fn();
      });
    const tavily = SECRET_IDS.tavilyApiKey;

    // The deployment falls back to its environment; a member does not.
    expect(as(null, () => store.getSecret(tavily))).toBe('operator-env-key');
    expect(as(person('carol'), () => store.getSecret(tavily))).toBeNull();

    await as(person('carol'), () => store.setSecret(tavily, 'carol-key'));
    await as(person('dave'), () => store.setSecrets({ [tavily]: 'dave-key' }));
    expect(as(person('carol'), () => store.getSecret(tavily))).toBe(
      'carol-key',
    );
    expect(as(person('dave'), () => store.getSecret(tavily))).toBe('dave-key');
    expect(as(null, () => store.getSecret(tavily))).toBe('operator-env-key');
    // An administrator uses the deployment's.
    expect(as(person('admin', true), () => store.getSecret(tavily))).toBe(
      'operator-env-key',
    );

    // Settings files go under the member's own directory.
    expect(as(person('carol'), () => scope.settingsFilePath('x.json'))).toMatch(
      new RegExp(`^${tmp}/people/[0-9a-f]{32}/x\\.json$`),
    );
    expect(as(null, () => scope.settingsFilePath('x.json'))).toBe(
      join(tmp, 'x.json'),
    );
  });

  it('never namespaces the deployment’s own credentials', async () => {
    const store = await import('../../security/secret-store.js');
    const scope = await import('./personal-settings.js');
    const { SECRET_IDS } = await import('../../security/secret-ids.js');
    await store.initializeSecretStore();
    await store.setSecret(SECRET_IDS.managedConnectionToken, 'machine');
    expect(
      scope.openPersonalSettings(() => {
        scope.useCaller(person('carol'));
        return store.getSecret(SECRET_IDS.managedConnectionToken);
      }),
    ).toBe('machine');
  });

  it('gives a member the Built-In agent by default, whatever the deployment picks', async () => {
    const scope = await import('./personal-settings.js');
    const defaults = await import('../agent/agent-defaults.js');
    defaults.setAgentDefaults({
      profileId: 'external-x',
      functionalModel: '',
    });
    expect(defaults.getAgentDefaults().profileId).toBe('external-x');
    expect(
      scope.openPersonalSettings(() => {
        scope.useCaller(person('carol'));
        return defaults.getAgentDefaults().profileId;
      }),
    ).toBe('huabu');
  });
});
