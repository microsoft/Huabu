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
 * Whether the database `context` connects to holds any server record, asked
 * before `context.init()` so the database is not upgraded. A database
 * without the table, as an earlier version left it, holds none.
 */
export async function postgresDatabaseHoldsServerRecords(
  context: PostgresStoreContext,
): Promise<boolean> {
  const database = context.beforeInit();
  const table = await database.get(
    "SELECT to_regclass('server_records') IS NOT NULL AS present",
  );
  if (table?.['present'] !== true) return false;
  const held = await database.get(
    'SELECT EXISTS (SELECT 1 FROM server_records) AS held',
  );
  return held?.['held'] === true;
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
