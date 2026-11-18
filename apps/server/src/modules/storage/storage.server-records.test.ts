// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Server records as the composition root serves them: serialized
 * read-modify-write over any adapter, and the one-time import that moves an
 * earlier version's data-directory files into a database backend.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { DiskServerRecordStore } from './backends/disk/server-records.js';
import { StorageProfileError } from './profile.js';
import {
  closeStorage,
  getServerRecords,
  initServerRecords,
  ServerRecords,
} from './storage.js';

import type { ServerRecordStore } from './ports/server-records.js';

const directories: string[] = [];
function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'huabu-server-records-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeStorage();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** An adapter that acknowledges writes a macrotask later, like a database. */
function slowStore(): ServerRecordStore {
  const dataDir = dataDirectory();
  const store = new DiskServerRecordStore(() => dataDir);
  return {
    kind: store.kind,
    init: () => store.init(),
    get: (key) => store.get(key),
    keys: () => store.keys(),
    put: async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.put(key, value);
    },
  };
}

const VERSIONS = { owner: null, name: 'agent-credential-versions' } as const;

it('applies concurrent changes to one record in turn, each on the last acknowledged value', async () => {
  const records = new ServerRecords(slowStore());
  const bump = (id: string) =>
    records.update(VERSIONS, (current) => {
      const versions = (current ?? {}) as Record<string, number>;
      return { ...versions, [id]: (versions[id] ?? 0) + 1 };
    });

  await Promise.all([bump('alice'), bump('bob'), bump('alice')]);

  expect(await records.get(VERSIONS)).toEqual({ alice: 2, bob: 1 });
});

it('writes nothing when a change throws, and keeps serving later changes', async () => {
  const records = new ServerRecords(slowStore());
  await records.put(VERSIONS, { alice: 1 });

  await expect(
    records.update(VERSIONS, () => {
      throw new Error('refused');
    }),
  ).rejects.toThrow('refused');
  await records.update(VERSIONS, (current) => ({
    ...(current as object),
    bob: 1,
  }));

  expect(await records.get(VERSIONS)).toEqual({ alice: 1, bob: 1 });
});

it('requires an awaited open before a database backend serves records', () => {
  vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');
  expect(() => getServerRecords()).toThrow(StorageProfileError);
});

it('moves data-directory records into a database once, never over newer rows', async () => {
  const dataDir = dataDirectory();
  const owner = 'd'.repeat(32);
  const legacy = new DiskServerRecordStore(() => dataDir);
  await legacy.put({ owner: null, name: 'credentials' }, { v: 'file' });
  await legacy.put({ owner, name: 'model-settings' }, { active: 'openai' });
  vi.stubEnv('HUABU_DATA_DIR', dataDir);
  vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');

  const records = await initServerRecords();
  expect(records.kind).toBe('sqlite');
  expect(await records.get({ owner: null, name: 'credentials' })).toEqual({
    v: 'file',
  });
  expect(await records.get({ owner, name: 'model-settings' })).toEqual({
    active: 'openai',
  });

  // The database copy moves on; the stale file must never win it back.
  await records.put({ owner: null, name: 'credentials' }, { v: 'database' });
  await closeStorage();
  const restarted = await initServerRecords();
  expect(await restarted.get({ owner: null, name: 'credentials' })).toEqual({
    v: 'database',
  });
});

it('fails to start rather than skip a damaged data-directory record', async () => {
  const dataDir = dataDirectory();
  writeFileSync(join(dataDir, 'encrypted-secrets.json'), '{broken');
  vi.stubEnv('HUABU_DATA_DIR', dataDir);
  vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');

  await expect(initServerRecords()).rejects.toThrow(
    'Server record credentials is not valid JSON',
  );
});
