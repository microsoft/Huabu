// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { describeSeveralPeople } from './multi-user.scenarios.js';
import { openPostgresTestDatabase } from '../storage/backends/postgres/test-support.js';
import { closeStorage, initStorage } from '../storage/index.js';

/**
 * The same people, on Postgres: every request goes through the one shared
 * connection pool, so this is where a namespace leaking between concurrent
 * Workspaces would show.
 */

let tmp: string;
const restores: Array<() => Promise<void> | void> = [];

function setEnv(key: string, value: string): void {
  const previous = process.env[key];
  restores.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  process.env[key] = value;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-multi-user-pg-'));
  setEnv('HUABU_DATA_DIR', join(tmp, 'data'));
  const database = await openPostgresTestDatabase();
  restores.push(database.cleanup);
  const url = new URL(database.config.connectionString);
  url.searchParams.set('options', database.config.options);
  url.searchParams.set('application_name', `huabu-multi-user-${randomUUID()}`);
  setEnv('HUABU_POSTGRES_URL', url.toString());
  await initStorage({
    structured: { kind: 'postgres' },
    blobs: { kind: 'disk' },
  });
});
afterEach(async () => {
  await closeStorage();
  for (const restore of restores.splice(0).reverse()) await restore();
  rmSync(tmp, { recursive: true, force: true });
});

describeSeveralPeople('Postgres', () => tmp);
