// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncryptedSecretStore } from './encrypted-secret-store.js';
import { DiskServerRecordStore } from '../modules/storage/backends/disk/server-records.js';
import { ServerRecords } from '../modules/storage/server-records.js';
import { diskServerRecords } from '../modules/storage/testing.js';

const directories: string[] = [];
const key = Buffer.alloc(32, 7);

function createDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'huabu-server-secrets-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true });
  directories.length = 0;
});

describe('EncryptedSecretStore', () => {
  it('publishes both of two concurrent saves', async () => {
    const dataDir = createDataDir();
    const records = new ServerRecords(new DiskServerRecordStore(() => dataDir));
    // A save reads its write back through `get`; the first save's read-back
    // (after initialization's read) answers last, as a database's may.
    const get = records.get.bind(records);
    let reads = 0;
    vi.spyOn(records, 'get').mockImplementation(async (recordKey) => {
      const value = await get(recordKey);
      if (reads++ === 1)
        await new Promise((resolve) => setTimeout(resolve, 30));
      return value;
    });
    const store = new EncryptedSecretStore(records, key);
    await store.initialize();

    const ids = ['test:a', 'test:b'];
    await Promise.all(ids.map((id) => store.set(id, `value-${id}`)));

    for (const id of ids) expect(store.get(id)).toBe(`value-${id}`);
  });

  it('persists authenticated ciphertext without plaintext', async () => {
    const dataDir = createDataDir();
    const store = new EncryptedSecretStore(diskServerRecords(dataDir), key);
    await store.initialize();
    await store.set('test:credential', 'private-value');

    const raw = readFileSync(join(dataDir, 'encrypted-secrets.json'), 'utf-8');
    expect(raw).not.toContain('private-value');

    const restored = new EncryptedSecretStore(diskServerRecords(dataDir), key);
    await restored.initialize();
    expect(restored.get('test:credential')).toBe('private-value');
  });

  it('fails closed when ciphertext is modified or the key is wrong', async () => {
    const dataDir = createDataDir();
    const store = new EncryptedSecretStore(diskServerRecords(dataDir), key);
    await store.initialize();
    await store.set('test:credential', 'private-value');

    const path = join(dataDir, 'encrypted-secrets.json');
    const persisted = JSON.parse(readFileSync(path, 'utf-8'));
    persisted.entries['test:credential'].ciphertext =
      Buffer.from('tampered').toString('base64');
    writeFileSync(path, JSON.stringify(persisted));

    await expect(
      new EncryptedSecretStore(diskServerRecords(dataDir), key).initialize(),
    ).rejects.toThrow('Failed to decrypt credential');
    await expect(
      new EncryptedSecretStore(
        diskServerRecords(dataDir),
        Buffer.alloc(32, 8),
      ).initialize(),
    ).rejects.toThrow('does not match');
  });
});
