// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const directories: string[] = [];

function createDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'huabu-secret-store-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true });
  directories.length = 0;
  delete process.env.HUABU_SECRET_KEY;
  delete process.env.HUABU_DATA_DIR;
  delete process.env.HUABU_SECRET_BRIDGE;
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * `initializeSecretStore` latches on module-level state, so each case has to
 * import a fresh copy after `vi.resetModules()`. That reloads the whole graph
 * behind it — including `@earendil-works/pi-ai/compat`, reached through
 * `EnvironmentSecretStore` — which costs seconds even though the logic under
 * test is a handful of branches. The default 5s budget therefore has no
 * headroom: on a machine running anything else it expires mid-import and the
 * assertions never run, which reads as a security regression that isn't one.
 */
const MODULE_RELOAD_TIMEOUT_MS = 30_000;

describe('initializeSecretStore — master key isolation', () => {
  it(
    'persists the Azure Vision key encrypted and resolves it after reinitialization',
    async () => {
      const dataDir = createDataDir();
      const masterKey = Buffer.alloc(32, 2).toString('base64');
      process.env.HUABU_DATA_DIR = dataDir;
      process.env.HUABU_SECRET_KEY = masterKey;
      vi.stubEnv('VISION_KEY', 'test-environment-vision-key');
      const { SECRET_IDS } = await import('./secret-ids.js');
      const mod = await import('./secret-store.js');
      await mod.initializeSecretStore();
      await mod.setSecret(SECRET_IDS.inkOcrApiKey, 'test-vision-private-key');
      expect(
        readFileSync(join(dataDir, 'encrypted-secrets.json'), 'utf8'),
      ).not.toContain('test-vision-private-key');

      vi.resetModules();
      process.env.HUABU_SECRET_KEY = masterKey;
      const reloaded = await import('./secret-store.js');
      await reloaded.initializeSecretStore();
      expect(reloaded.getPersistedSecret(SECRET_IDS.inkOcrApiKey)).toBe(
        'test-vision-private-key',
      );
      expect(reloaded.getSecret(SECRET_IDS.inkOcrApiKey)).toBe(
        'test-vision-private-key',
      );
      await reloaded.setSecret(SECRET_IDS.inkOcrApiKey, null);
      expect(reloaded.getPersistedSecret(SECRET_IDS.inkOcrApiKey)).toBeNull();
      expect(reloaded.getSecret(SECRET_IDS.inkOcrApiKey)).toBe(
        'test-environment-vision-key',
      );
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it(
    'scrubs HUABU_SECRET_KEY from the environment after consuming it',
    async () => {
      process.env.HUABU_DATA_DIR = createDataDir();
      process.env.HUABU_SECRET_KEY = Buffer.alloc(32, 1).toString('base64');

      const mod = await import('./secret-store.js');
      await mod.initializeSecretStore();

      // The parsed key now lives only inside the store; the raw env var is
      // gone so it can never be inherited by a forked child process.
      expect(process.env.HUABU_SECRET_KEY).toBeUndefined();
      expect(mod.getSecretStoreKind()).toBe('encrypted-file');
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it(
    'leaves the environment untouched when no master key is set',
    async () => {
      process.env.HUABU_DATA_DIR = createDataDir();

      const mod = await import('./secret-store.js');
      await mod.initializeSecretStore();

      expect(process.env.HUABU_SECRET_KEY).toBeUndefined();
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );
});
