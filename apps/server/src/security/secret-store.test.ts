// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const directories: string[] = [];

function createDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'huabu-secret-store-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
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
    'persists one encrypted OCR record and restores explicit nulls without reviving legacy values',
    async () => {
      const dataDir = createDataDir();
      const masterKey = Buffer.alloc(32, 2).toString('base64');
      process.env.HUABU_DATA_DIR = dataDir;
      process.env.HUABU_SECRET_KEY = masterKey;
      vi.stubEnv('HUABU_SECRET_BRIDGE', '');
      vi.stubEnv('VISION_KEY', 'fake-environment-key');
      vi.stubEnv(
        'VISION_ENDPOINT',
        'https://environment.cognitiveservices.azure.com/',
      );
      const { SECRET_IDS } = await import('./secret-ids.js');
      const store = await import('./secret-store.js');
      await store.initializeSecretStore();
      await store.setSecret(SECRET_IDS.inkOcrApiKey, 'fake-legacy-key');
      const service = await import('../modules/integrations/ink-ocr-config.js');
      const endpoint = 'https://stored.cognitiveservices.azure.com/';
      await service.setInkOcrConfig({ endpoint, apiKey: 'fake-stored-key' });
      const ciphertext = readFileSync(
        join(dataDir, 'encrypted-secrets.json'),
        'utf8',
      );
      for (const plaintext of [
        endpoint,
        'fake-stored-key',
        'fake-legacy-key',
      ]) {
        expect(ciphertext).not.toContain(plaintext);
      }
      expect(
        JSON.parse(ciphertext).entries[SECRET_IDS.inkOcrConfig],
      ).toBeDefined();
      expect(existsSync(join(dataDir, 'ink-ocr-config.json'))).toBe(false);

      vi.resetModules();
      process.env.HUABU_SECRET_KEY = masterKey;
      const restoredStore = await import('./secret-store.js');
      await restoredStore.initializeSecretStore();
      const restored =
        await import('../modules/integrations/ink-ocr-config.js');
      expect(restored.resolveInkOcrConfiguration()).toEqual({
        endpoint,
        key: 'fake-stored-key',
      });
      await restored.setInkOcrConfig({ endpoint: null, apiKey: null });

      vi.resetModules();
      process.env.HUABU_SECRET_KEY = masterKey;
      const resetStore = await import('./secret-store.js');
      await resetStore.initializeSecretStore();
      const reset = await import('../modules/integrations/ink-ocr-config.js');
      expect(resetStore.getPersistedSecret(SECRET_IDS.inkOcrApiKey)).toBe(
        'fake-legacy-key',
      );
      expect(reset.resolveInkOcrConfiguration()).toEqual({
        endpoint: 'https://environment.cognitiveservices.azure.com/',
        key: 'fake-environment-key',
      });
      vi.stubEnv('VISION_KEY', '');
      vi.stubEnv('VISION_ENDPOINT', '');
      expect(reset.resolveInkOcrConfiguration()).toEqual({
        endpoint: null,
        key: null,
      });
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it.each(['legacy', 'canonical'] as const)(
    'preserves the whole %s OCR pair after an encrypted replacement failure and restart',
    async (source) => {
      const dataDir = createDataDir();
      const masterKey = Buffer.alloc(32, 3).toString('base64');
      process.env.HUABU_DATA_DIR = dataDir;
      process.env.HUABU_SECRET_KEY = masterKey;
      vi.stubEnv('HUABU_SECRET_BRIDGE', '');
      vi.stubEnv('VISION_KEY', '');
      vi.stubEnv('VISION_ENDPOINT', '');
      const { SECRET_IDS } = await import('./secret-ids.js');
      const store = await import('./secret-store.js');
      await store.initializeSecretStore();
      const endpoint = 'https://old.cognitiveservices.azure.com/';
      const legacy = JSON.stringify({ endpoint });
      writeFileSync(join(dataDir, 'ink-ocr-config.json'), legacy);
      await store.setSecret(SECRET_IDS.inkOcrApiKey, 'fake-old-key');
      const service = await import('../modules/integrations/ink-ocr-config.js');
      if (source === 'canonical') {
        await service.setInkOcrConfig({ endpoint, apiKey: 'fake-old-key' });
      }
      const ciphertext = readFileSync(
        join(dataDir, 'encrypted-secrets.json'),
        'utf8',
      );
      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw new Error('fake-new-key pre-commit failure');
      });
      await expect(
        service.setInkOcrConfig({
          endpoint: 'https://new.cognitiveservices.azure.com/',
          apiKey: 'fake-new-key',
        }),
      ).rejects.toThrow(new Error('Unable to save Ink OCR configuration'));
      expect(service.resolveInkOcrConfiguration()).toEqual({
        endpoint,
        key: 'fake-old-key',
      });
      expect(
        readFileSync(join(dataDir, 'encrypted-secrets.json'), 'utf8'),
      ).toBe(ciphertext);
      expect(readFileSync(join(dataDir, 'ink-ocr-config.json'), 'utf8')).toBe(
        legacy,
      );

      vi.resetModules();
      process.env.HUABU_SECRET_KEY = masterKey;
      const reloadedStore = await import('./secret-store.js');
      await reloadedStore.initializeSecretStore();
      const reloaded =
        await import('../modules/integrations/ink-ocr-config.js');
      expect(reloaded.resolveInkOcrConfiguration()).toEqual({
        endpoint,
        key: 'fake-old-key',
      });
      if (source === 'legacy') {
        expect(
          reloadedStore.getPersistedSecret(SECRET_IDS.inkOcrConfig),
        ).toBeNull();
      }
      await reloaded.setInkOcrConfig({ apiKey: 'fake-retry-key' });
      expect(reloaded.resolveInkOcrConfiguration()).toEqual({
        endpoint,
        key: 'fake-retry-key',
      });
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

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
