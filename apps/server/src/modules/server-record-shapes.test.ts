// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { assertImportableShapes } from './server-record-shapes.js';
import {
  applySqliteMigrations,
  SQLITE_MIGRATIONS,
} from './storage/backends/sqlite/database.js';
import {
  closeStorage,
  initServerRecords,
  readPendingImport,
} from './storage/index.js';
import { diskServerRecords } from './storage/testing.js';

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeStorage();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A data directory holding an earlier version's SQLite database (schema 2). */
function earlierSqlite(): { dataDir: string; file: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'huabu-record-shapes-'));
  directories.push(dataDir);
  const file = join(dataDir, 'storage', 'sqlite', 'huabu.sqlite');
  mkdirSync(join(dataDir, 'storage', 'sqlite'), { recursive: true });
  const earlier = new DatabaseSync(file);
  applySqliteMigrations(earlier, SQLITE_MIGRATIONS.slice(0, 2));
  earlier.close();
  return { dataDir, file };
}

function userVersion(file: string): unknown {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare('PRAGMA user_version').get();
  } finally {
    database.close();
  }
}

it.each([
  [
    'an Agent Profile registry',
    { owner: null, name: 'user-agent-profiles' },
    // Valid JSON, but an object where the registry keeps an array.
    { schemaVersion: 1, state: { profiles: {} } },
    { schemaVersion: 1, state: { profiles: [] } },
  ],
  [
    'device ownership',
    { owner: null, name: 'device-owners' },
    { 'desk-1': '' },
    { 'desk-1': 'alice' },
  ],
  [
    'device names',
    { owner: null, name: 'device-names' },
    { 'desk-1': 7 },
    { 'desk-1': 'Desk' },
  ],
] as const)(
  'refuses %s its owner would refuse, before the database is opened',
  async (_label, key, damaged, repaired) => {
    const { dataDir, file } = earlierSqlite();
    vi.stubEnv('HUABU_DATA_DIR', dataDir);
    vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');
    const files = diskServerRecords(dataDir);
    await files.put(key, damaged);

    await expect(
      initServerRecords(process.env, { checkImport: assertImportableShapes }),
    ).rejects.toThrow(
      /^Cannot import \/.+ into the database: .+ The database was not changed/,
    );
    expect(userVersion(file)).toEqual({ user_version: 2 });

    // Repairing the file is enough, because nothing was imported.
    await files.put(key, repaired);
    const records = await initServerRecords(process.env, {
      checkImport: assertImportableShapes,
    });
    expect(await records.get(key)).toEqual(repaired);
  },
);

it('leaves the records an owner falls back from to be repaired by the next save', async () => {
  const { dataDir } = earlierSqlite();
  vi.stubEnv('HUABU_DATA_DIR', dataDir);
  vi.stubEnv('HUABU_STRUCTURED_BACKEND', 'sqlite');
  const settings = { owner: null, name: 'change-review' } as const;
  await diskServerRecords(dataDir).put(settings, { unexpected: true });
  const pending = await readPendingImport();
  expect(pending).toEqual([
    expect.objectContaining({ key: settings, value: { unexpected: true } }),
  ]);
  expect(() => assertImportableShapes(pending)).not.toThrow();
});
