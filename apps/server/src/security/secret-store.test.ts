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
    'reads existing saved secrets without creating new storage or rewriting ciphertext',
    async () => {
      const directory = createDataDir();
      const env = {
        HUABU_DATA_DIR: join(directory, 'data'),
        HUABU_CONFIG_DIR: join(directory, 'config'),
      };
      vi.stubEnv('HUABU_SECRET_BRIDGE', '');
      const { SECRET_IDS } = await import('./secret-ids.js');
      const store = await import('./secret-store.js');
      expect(
        await store.readPersistedSecret(SECRET_IDS.remoteAccessPassword, env),
      ).toBeNull();
      expect(existsSync(env.HUABU_DATA_DIR)).toBe(false);
      expect(existsSync(env.HUABU_CONFIG_DIR)).toBe(false);
      await store.initializeSecretStore(env);
      await store.setSecret(
        SECRET_IDS.remoteAccessPassword,
        'saved-private-password',
      );
      const path = join(env.HUABU_DATA_DIR, 'encrypted-secrets.json');
      const ciphertext = readFileSync(path, 'utf8');
      vi.resetModules();
      const restored = await import('./secret-store.js');
      expect(
        await restored.readPersistedSecret(
          SECRET_IDS.remoteAccessPassword,
          env,
        ),
      ).toBe('saved-private-password');
      expect(readFileSync(path, 'utf8')).toBe(ciphertext);
      vi.resetModules();
      const wrongKey = await import('./secret-store.js');
      await expect(
        wrongKey.readPersistedSecret(SECRET_IDS.remoteAccessPassword, {
          ...env,
          HUABU_SECRET_KEY: Buffer.alloc(32, 4).toString('base64'),
        }),
      ).rejects.toThrow(/key/i);
      expect(readFileSync(path, 'utf8')).toBe(ciphertext);
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

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
    "looks up setup's saved password from the credential record alone",
    async () => {
      const key = Buffer.alloc(32, 7);
      process.env.HUABU_SECRET_KEY = key.toString('base64');
      vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');
      const { EncryptedSecretStore } =
        await import('./encrypted-secret-store.js');
      const { diskServerRecords } =
        await import('../modules/storage/testing.js');
      const dataDir = createDataDir();
      process.env.HUABU_DATA_DIR = dataDir;
      const earlier = new EncryptedSecretStore(diskServerRecords(dataDir), key);
      await earlier.initialize();
      await earlier.set('remote:password', 'saved-password');
      // Another record's damage is the import's concern, not this lookup's.
      writeFileSync(join(dataDir, 'agentlet-device-names.json'), '{broken');

      const mod = await import('./secret-store.js');
      expect(await mod.readPersistedSecret('remote:password')).toBe(
        'saved-password',
      );
      await expect(mod.initializeSecretStore()).rejects.toThrow(
        /Cannot import .*agentlet-device-names\.json/,
      );
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it(
    'refuses PostgreSQL without a supplied key before reaching the database',
    async () => {
      vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'postgres');
      // Nothing listens here; reaching it would fail with ECONNREFUSED.
      vi.stubEnv('HUABU_POSTGRES_URL', 'postgresql://user:pass@127.0.0.1:1/db');
      process.env.HUABU_DATA_DIR = createDataDir();
      const mod = await import('./secret-store.js');
      await expect(mod.initializeSecretStore()).rejects.toThrow(
        'PostgreSQL credential storage requires HUABU_SECRET_KEY',
      );
      await expect(mod.readPersistedSecret('remote:password')).rejects.toThrow(
        'PostgreSQL credential storage requires HUABU_SECRET_KEY',
      );
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it(
    "looks up setup's saved password without creating, upgrading, or importing into a database",
    async () => {
      const key = Buffer.alloc(32, 5);
      process.env.HUABU_SECRET_KEY = key.toString('base64');
      vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');
      const { mkdirSync } = await import('node:fs');
      const { DatabaseSync } = await import('node:sqlite');
      const { applySqliteMigrations, SQLITE_MIGRATIONS } =
        await import('../modules/storage/backends/sqlite/database.js');
      const { EncryptedSecretStore } =
        await import('./encrypted-secret-store.js');
      const { diskServerRecords } =
        await import('../modules/storage/testing.js');

      // A new instance: nothing to read, and nothing is created.
      const fresh = createDataDir();
      process.env.HUABU_DATA_DIR = fresh;
      const mod = await import('./secret-store.js');
      expect(await mod.readPersistedSecret('remote:password')).toBeNull();
      expect(existsSync(join(fresh, 'storage'))).toBe(false);

      // An earlier version's database, with the password still in its file.
      const dataDir = createDataDir();
      const earlier = new EncryptedSecretStore(diskServerRecords(dataDir), key);
      await earlier.initialize();
      await earlier.set('remote:password', 'saved-password');
      const file = join(dataDir, 'storage', 'sqlite', 'huabu.sqlite');
      mkdirSync(join(dataDir, 'storage', 'sqlite'), { recursive: true });
      const database = new DatabaseSync(file);
      applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 2));
      database.close();
      process.env.HUABU_DATA_DIR = dataDir;
      expect(await mod.readPersistedSecret('remote:password')).toBe(
        'saved-password',
      );
      const after = new DatabaseSync(file, { readOnly: true });
      try {
        // Still the earlier version's schema, with nothing imported.
        expect(after.prepare('PRAGMA user_version').get()).toEqual({
          user_version: 2,
        });
      } finally {
        after.close();
      }
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it(
    'refuses a wrong key before a database imports or upgrades anything',
    async () => {
      const dataDir = createDataDir();
      const rightKey = Buffer.alloc(32, 3);
      const { EncryptedSecretStore } =
        await import('./encrypted-secret-store.js');
      const { diskServerRecords } =
        await import('../modules/storage/testing.js');
      const earlier = new EncryptedSecretStore(
        diskServerRecords(dataDir),
        rightKey,
      );
      await earlier.initialize();
      await earlier.set('integration:test:key', 'private-test-value');
      process.env.HUABU_DATA_DIR = dataDir;
      vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');
      process.env.HUABU_SECRET_KEY = Buffer.alloc(32, 4).toString('base64');

      const mod = await import('./secret-store.js');
      // Setup's saved-password lookup checks the key the same way.
      await expect(
        mod.readPersistedSecret('integration:test:key'),
      ).rejects.toThrow('HUABU_SECRET_KEY does not match');
      await expect(mod.initializeSecretStore()).rejects.toThrow(
        'HUABU_SECRET_KEY does not match',
      );
      expect(existsSync(join(dataDir, 'storage'))).toBe(false);

      process.env.HUABU_SECRET_KEY = rightKey.toString('base64');
      await mod.initializeSecretStore();
      expect(mod.getPersistedSecret('integration:test:key')).toBe(
        'private-test-value',
      );
      const { closeStorage } = await import('../modules/storage/index.js');
      await closeStorage();
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it(
    'ignores the credentials file once a database has imported it',
    async () => {
      const dataDir = createDataDir();
      const key = Buffer.alloc(32, 5).toString('base64');
      const { EncryptedSecretStore } =
        await import('./encrypted-secret-store.js');
      const { diskServerRecords } =
        await import('../modules/storage/testing.js');
      const earlier = new EncryptedSecretStore(
        diskServerRecords(dataDir),
        Buffer.from(key, 'base64'),
      );
      await earlier.initialize();
      await earlier.set('integration:test:key', 'imported');
      process.env.HUABU_DATA_DIR = dataDir;
      vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');
      process.env.HUABU_SECRET_KEY = key;
      const mod = await import('./secret-store.js');
      await mod.initializeSecretStore();
      await mod.setSecret('integration:test:key', 'saved-later');
      const { closeStorage } = await import('../modules/storage/index.js');
      await closeStorage();

      writeFileSync(join(dataDir, 'encrypted-secrets.json'), '{broken');
      vi.resetModules();
      process.env.HUABU_SECRET_KEY = key;
      const restarted = await import('./secret-store.js');
      await restarted.initializeSecretStore();
      expect(restarted.getPersistedSecret('integration:test:key')).toBe(
        'saved-later',
      );
      await (await import('../modules/storage/index.js')).closeStorage();
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
      expect(mod.getSecretStoreKind()).toBe('encrypted');
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it(
    'automatically initializes writable storage and restores credentials without an env key',
    async () => {
      const directory = createDataDir();
      process.env.HUABU_DATA_DIR = join(directory, 'data');
      vi.stubEnv('HUABU_CONFIG_DIR', join(directory, 'config'));

      const mod = await import('./secret-store.js');
      await mod.initializeSecretStore();
      expect(mod.isSecretStoreWritable()).toBe(true);
      await mod.setSecret('integration:test:key', 'private-test-value');
      expect(
        readFileSync(
          join(process.env.HUABU_DATA_DIR, 'encrypted-secrets.json'),
          'utf8',
        ),
      ).not.toContain('private-test-value');
      vi.resetModules();
      const restored = await import('./secret-store.js');
      await restored.initializeSecretStore();
      expect(restored.getPersistedSecret('integration:test:key')).toBe(
        'private-test-value',
      );
      expect(process.env.HUABU_SECRET_KEY).toBeUndefined();
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );
});
