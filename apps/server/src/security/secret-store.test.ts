import { mkdtempSync, rmSync } from 'node:fs';
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
  vi.resetModules();
});

describe('initializeSecretStore — master key isolation', () => {
  it('scrubs HUABU_SECRET_KEY from the environment after consuming it', async () => {
    process.env.HUABU_DATA_DIR = createDataDir();
    process.env.HUABU_SECRET_KEY = Buffer.alloc(32, 1).toString('base64');

    const mod = await import('./secret-store.js');
    await mod.initializeSecretStore();

    // The parsed key now lives only inside the store; the raw env var is
    // gone so it can never be inherited by a forked child process.
    expect(process.env.HUABU_SECRET_KEY).toBeUndefined();
    expect(mod.getSecretStoreKind()).toBe('encrypted-file');
  });

  it('leaves the environment untouched when no master key is set', async () => {
    process.env.HUABU_DATA_DIR = createDataDir();

    const mod = await import('./secret-store.js');
    await mod.initializeSecretStore();

    expect(process.env.HUABU_SECRET_KEY).toBeUndefined();
  });
});
