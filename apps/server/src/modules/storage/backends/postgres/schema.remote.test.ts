// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pool } from 'pg';
import { afterEach, expect, it } from 'vitest';

import { PostgresStoreContext } from './database.js';
import { POSTGRES_MIGRATIONS } from './schema.js';
import {
  openPostgresTestDatabase,
  openPostgresTestStore,
} from './test-support.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('runs on PostgreSQL 18 and serializes simultaneous fresh migrations', async () => {
  const h = await openPostgresTestDatabase();
  cleanup.push(h.cleanup);
  const contexts = [
    new PostgresStoreContext(h.config),
    new PostgresStoreContext(h.config),
  ];
  cleanup.push(...contexts.map((context) => () => context.close()));
  await Promise.all(contexts.map((context) => context.init()));
  const db = contexts[0].connection();
  expect(
    Number(
      (await db.query('SHOW server_version_num')).rows[0].server_version_num,
    ),
  ).toBeGreaterThanOrEqual(180000);
  expect(
    Number(
      (await db.query('SHOW server_version_num')).rows[0].server_version_num,
    ),
  ).toBeLessThan(190000);
  expect((await db.query('SELECT * FROM huabu_schema_version')).rows).toEqual([
    { id: 1, version: POSTGRES_MIGRATIONS.length },
  ]);
  expect(
    (
      await db.query(
        'SELECT tablename FROM pg_tables WHERE schemaname = current_schema()',
      )
    ).rows.map((row) => row.tablename),
  ).toEqual(
    expect.arrayContaining([
      'workspaces',
      'spaces',
      'nodes',
      'events',
      'tasks',
      'changes',
      'space_extensions',
      'delta_log',
    ]),
  );
});
it('opens the original v1 schema without changing existing data', async () => {
  const h = await openPostgresTestDatabase();
  cleanup.push(h.cleanup);
  const pool = new Pool(h.config);
  cleanup.push(() => pool.end());
  await pool.query(POSTGRES_MIGRATIONS[0].sql);
  await pool.query(
    'CREATE TABLE huabu_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
  );
  await pool.query('INSERT INTO huabu_schema_version VALUES (1, 1)');
  await pool.query(
    "INSERT INTO workspaces VALUES ('original', 'Original', 1, 1, NULL)",
  );
  const context = new PostgresStoreContext(h.config);
  cleanup.push(() => context.close());
  await context.init();
  expect(
    (
      await context
        .connection()
        .query('SELECT workspace_id, name FROM workspaces')
    ).rows,
  ).toEqual([{ workspace_id: 'original', name: 'Original' }]);
});
it('rolls back a failed initial migration and can initialize after the cause is removed', async () => {
  const h = await openPostgresTestDatabase();
  cleanup.push(h.cleanup);
  const pool = new Pool(h.config);
  cleanup.push(() => pool.end());
  await pool.query('CREATE TABLE nodes (sentinel TEXT)');
  const context = new PostgresStoreContext(h.config);
  cleanup.push(() => context.close());
  await expect(context.init()).rejects.toMatchObject({ code: '42P07' });
  expect(
    (
      await pool.query(
        "SELECT to_regclass('workspaces') AS workspaces, to_regclass('huabu_schema_version') AS version",
      )
    ).rows[0],
  ).toEqual({ workspaces: null, version: null });
  await pool.query('DROP TABLE nodes');
  await context.init();
  expect((await context.health()).ok).toBe(true);
});
it('enforces foreign keys, JSON, nonempty revisions, and unique labels in the database', async () => {
  const h = await openPostgresTestStore();
  cleanup.push(h.cleanup);
  await h.store.spaces().create({ canvasId: 'space', title: 'Title' });
  const db = h.context.connection();
  const insert = (
    canvas: string,
    node: string,
    json: string,
    revision: string,
    label: string,
  ) =>
    db.query('INSERT INTO nodes VALUES ($1, $2, $3, $4, $5)', [
      canvas,
      node,
      json,
      revision,
      label,
    ]);
  await expect(
    insert('missing', 'n', '{}', 'r', 'label'),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(insert('space', 'n', '{', 'r', 'label')).rejects.toMatchObject({
    code: '22P02',
  });
  await expect(insert('space', 'n', '{}', '', 'label')).rejects.toMatchObject({
    code: '23514',
  });
  await insert('space', 'n', '{}', 'r', 'label');
  await expect(
    insert('space', 'other', '{}', 'r', 'label'),
  ).rejects.toMatchObject({ code: '23505' });
  await expect(
    db.query(
      "INSERT INTO spaces SELECT 'second-world', workspace_id, title, 'different', version, state_json, created_at, updated_at, 1 FROM spaces WHERE is_world = 1",
    ),
  ).rejects.toMatchObject({ code: '23505' });
  expect((await db.query('SELECT node_id FROM nodes')).rows).toEqual([
    { node_id: 'n' },
  ]);
});
