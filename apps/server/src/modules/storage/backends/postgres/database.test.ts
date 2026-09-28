// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import { PgExecutor, PostgresStoreContext } from './database.js';
import { POSTGRES_MIGRATIONS } from './schema.js';
const pg = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  // A checked-out client is an EventEmitter in `pg`, and the adapter listens
  // on it for the duration of the checkout so an unexpected disconnection
  // cannot raise an unhandled 'error' event. The double models that surface.
  const on = vi.fn();
  const removeListener = vi.fn();
  const client = { query, release, on, removeListener };
  const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn(), on: vi.fn() };
  return { query, release, client, pool };
});
vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      return pg.pool;
    }
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  pg.pool.connect.mockResolvedValue(pg.client);
  pg.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith('SELECT version')
      ? [{ version: POSTGRES_MIGRATIONS.length }]
      : sql.startsWith('SELECT current_database()')
        ? [{ database: 'test', schema: 'public' }]
        : [],
    rowCount: 0,
  }));
  pg.pool.query.mockResolvedValue({ rows: [], rowCount: null });
});
it('binds values separately and resets numbered placeholders for each query', async () => {
  const db = new PgExecutor(pg.pool as never);
  const value = "'; DROP TABLE nodes; --";
  await db.all('SELECT ? AS first, ? AS second', value, 3);
  expect(pg.pool.query).toHaveBeenLastCalledWith(
    'SELECT $1 AS first, $2 AS second',
    [value, 3],
  );
  expect(await db.get('SELECT ?', 1)).toBeUndefined();
  expect(pg.pool.query).toHaveBeenLastCalledWith('SELECT $1', [1]);
  expect(await db.run('DELETE FROM nodes')).toEqual({ changes: 0 });
});
it('guards lifecycle and makes init and close idempotent', async () => {
  const context = new PostgresStoreContext({});
  expect(() => context.database()).toThrow(/not initialized/);
  expect((await context.health()).ok).toBe(false);
  await context.init();
  await context.init();
  expect(pg.pool.connect).toHaveBeenCalledTimes(1);
  expect(() => context.workspaceId()).toThrow(/No Workspace/);
  context.useWorkspace('workspace');
  expect(context.workspaceId()).toBe('workspace');
  expect(await context.health()).toEqual({ ok: true, kind: 'postgres' });
  await context.close();
  await context.close();
  expect(pg.pool.end).toHaveBeenCalledTimes(1);
  await expect(context.init()).rejects.toThrow(/closed/);
});
it('rolls back a failed migration and permits a later initialization attempt', async () => {
  const failure = new Error('migration failed');
  pg.query.mockImplementation(async (sql: string) => {
    if (sql === POSTGRES_MIGRATIONS[0].sql) throw failure;
    return { rows: sql.startsWith('SELECT version') ? [{ version: 0 }] : [] };
  });
  const context = new PostgresStoreContext({});
  await expect(context.init()).rejects.toBe(failure);
  expect(pg.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(pg.release).toHaveBeenLastCalledWith(false);
  expect(() => context.connection()).toThrow(/not initialized/);
  pg.query.mockResolvedValue({
    rows: [
      {
        version: POSTGRES_MIGRATIONS.length,
        database: 'test',
        schema: 'public',
      },
    ],
  });
  await context.init();
  expect(context.connection()).toBe(pg.pool);
});
it('discards a broken client while preserving the original transaction failure', async () => {
  const context = new PostgresStoreContext({});
  await context.init();
  const failure = new Error('write failed');
  pg.query.mockImplementation(async (sql: string) => {
    if (sql === 'ROLLBACK') throw new Error('connection lost');
    return { rows: [] };
  });
  await expect(
    context.transaction(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(pg.release).toHaveBeenLastCalledWith(true);
  await expect(context.transaction(async () => 'recovered')).resolves.toBe(
    'recovered',
  );
});
it('rejects queued operations after workspace activation and drains writes before closing', async () => {
  const context = new PostgresStoreContext({});
  await context.init();
  context.useWorkspace('first');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = context.transaction(async () => {
    entered();
    await gate;
    return 1;
  });
  await started;
  const callback = vi.fn(async () => 2);
  const queued = expect(context.transaction(callback)).rejects.toThrow(
    /inactive Workspace/,
  );
  context.useWorkspace('second');
  const closing = context.close();
  expect(pg.pool.end).not.toHaveBeenCalled();
  release();
  await first;
  await queued;
  await closing;
  expect(callback).not.toHaveBeenCalled();
  expect(pg.pool.end).toHaveBeenCalledOnce();
});
