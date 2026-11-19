// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * PostgreSQL implementation of the server-record port: one row per record in
 * `server_records`, on the pool the Workspace and Space adapters share.
 *
 * Every read queries the table. Records are not Workspace data, so nothing
 * here is scoped to the active Workspace.
 */

import {
  decodeServerRecord,
  encodeServerRecord,
} from '../../ports/server-records.js';
import { serverRecordColumns } from '../sql/server-records.js';

import type { PostgresStoreContext } from './database.js';
import type {
  ServerRecordEntry,
  ServerRecordImportTarget,
  ServerRecordKey,
} from '../../ports/server-records.js';

/**
 * The `server_records` table of the schema `context.init()` would upgrade,
 * schema-qualified and quoted, or `null` when that schema has none yet, as
 * an earlier version left it. Asked before `context.init()`, so the
 * database is not upgraded.
 *
 * The migrations create their tables in `current_schema()`, the first schema
 * of the `search_path` that exists. An unqualified name would instead resolve
 * through the whole path, and find another schema's table while the one being
 * upgraded still has none.
 */
async function serverRecordsTableBeforeInit(
  context: PostgresStoreContext,
): Promise<string | null> {
  const row = await context.beforeInit().get(
    `SELECT quote_ident(current_schema()) AS schema,
            to_regclass(quote_ident(current_schema()) || '.server_records')
              IS NOT NULL AS present`,
  );
  const schema = row?.['schema'];
  return row?.['present'] === true && typeof schema === 'string'
    ? `${schema}.server_records`
    : null;
}

/**
 * Whether the schema `context` would upgrade holds any server record, asked
 * without upgrading it.
 */
export async function postgresDatabaseHoldsServerRecords(
  context: PostgresStoreContext,
): Promise<boolean> {
  const table = await serverRecordsTableBeforeInit(context);
  if (table === null) return false;
  const held = await context
    .beforeInit()
    .get(`SELECT EXISTS (SELECT 1 FROM ${table}) AS held`);
  return held?.['held'] === true;
}

/**
 * One record of the schema `context` would upgrade, read without upgrading
 * it, or `null` when it holds no such record.
 */
export async function postgresServerRecordBeforeInit(
  context: PostgresStoreContext,
  key: ServerRecordKey,
): Promise<unknown> {
  const table = await serverRecordsTableBeforeInit(context);
  if (table === null) return null;
  const { ownerKey, name } = serverRecordColumns(key);
  const row = await context
    .beforeInit()
    .get(
      `SELECT record_json FROM ${table} WHERE owner_key = ? AND name = ?`,
      ownerKey,
      name,
    );
  const text = row?.['record_json'];
  if (text === undefined) return null;
  if (typeof text !== 'string')
    throw new TypeError('Invalid PostgreSQL server record row');
  return decodeServerRecord(key, text);
}

export class PostgresServerRecordStore implements ServerRecordImportTarget {
  readonly kind = 'postgres' as const;
  /** @param context Borrowed; the composition root opens and closes it. */
  constructor(private readonly context: PostgresStoreContext) {}

  async init(): Promise<void> {
    await this.context.init();
  }

  async get(key: ServerRecordKey): Promise<unknown> {
    const { ownerKey, name } = serverRecordColumns(key);
    const row = await this.context
      .database()
      .get(
        'SELECT record_json FROM server_records WHERE owner_key = ? AND name = ?',
        ownerKey,
        name,
      );
    const text = row?.['record_json'];
    if (text === undefined) return null;
    if (typeof text !== 'string')
      throw new TypeError('Invalid PostgreSQL server record row');
    return decodeServerRecord(key, text);
  }

  async put(key: ServerRecordKey, value: unknown): Promise<void> {
    const { ownerKey, name } = serverRecordColumns(key);
    const text = encodeServerRecord(key, value);
    await this.context.database().run(
      `INSERT INTO server_records (owner_key, name, record_json, updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_key, name) DO UPDATE SET
         record_json = excluded.record_json,
         updated_at = excluded.updated_at`,
      ownerKey,
      name,
      text,
      this.context.now(),
    );
  }

  async insertMissing(records: readonly ServerRecordEntry[]): Promise<number> {
    const rows = records.map(({ key, value }) => ({
      ...serverRecordColumns(key),
      text: encodeServerRecord(key, value),
    }));
    const now = this.context.now();
    return this.context.transaction(async (database) => {
      let written = 0;
      for (const { ownerKey, name, text } of rows)
        written += (
          await database.run(
            `INSERT INTO server_records (owner_key, name, record_json, updated_at)
               VALUES (?, ?, ?, ?)
             ON CONFLICT (owner_key, name) DO NOTHING`,
            ownerKey,
            name,
            text,
            now,
          )
        ).changes;
      return written;
    });
  }
}
