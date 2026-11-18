// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SQLite implementation of the server-record port: one row per record in
 * `server_records`, on the connection the Workspace and Space adapters share.
 *
 * Every read queries the table. Records are not Workspace data, so nothing
 * here is scoped to the active Workspace.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { withImmediateTransaction } from './database.js';
import {
  decodeServerRecord,
  encodeServerRecord,
} from '../../ports/server-records.js';
import { serverRecordColumns } from '../sql/server-records.js';

import type { SqliteStoreContext } from './database.js';
import type {
  ServerRecordEntry,
  ServerRecordImportTarget,
  ServerRecordKey,
} from '../../ports/server-records.js';

/**
 * Whether the database file at `filename` holds any server record, read on a
 * short-lived connection of its own so the database is neither created nor
 * upgraded. An in-memory or URI filename names no file to inspect, and a
 * file without the table holds none.
 */
export function sqliteDatabaseHoldsServerRecords(filename: string): boolean {
  if (filename.startsWith(':') || filename.startsWith('file:')) return false;
  if (!existsSync(filename)) return false;
  const database = new DatabaseSync(filename);
  try {
    const table = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'server_records'",
      )
      .get();
    return (
      table !== undefined &&
      database.prepare('SELECT 1 FROM server_records LIMIT 1').get() !==
        undefined
    );
  } finally {
    database.close();
  }
}

export class SqliteServerRecordStore implements ServerRecordImportTarget {
  readonly kind = 'sqlite' as const;

  /** @param context Borrowed; the composition root opens and closes it. */
  constructor(private readonly context: SqliteStoreContext) {}

  async init(): Promise<void> {
    this.context.init();
  }

  async get(key: ServerRecordKey): Promise<unknown> {
    const { ownerKey, name } = serverRecordColumns(key);
    const text = this.context
      .database()
      .prepare(
        'SELECT record_json FROM server_records WHERE owner_key = ? AND name = ?',
      )
      .get(ownerKey, name)?.['record_json'];
    if (text === undefined) return null;
    if (typeof text !== 'string')
      throw new TypeError('Invalid SQLite server record row');
    return decodeServerRecord(key, text);
  }

  async put(key: ServerRecordKey, value: unknown): Promise<void> {
    const { ownerKey, name } = serverRecordColumns(key);
    this.context
      .database()
      .prepare(
        `INSERT INTO server_records (owner_key, name, record_json, updated_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT (owner_key, name) DO UPDATE SET
           record_json = excluded.record_json,
           updated_at = excluded.updated_at`,
      )
      .run(ownerKey, name, encodeServerRecord(key, value), this.context.now());
  }

  async insertMissing(records: readonly ServerRecordEntry[]): Promise<number> {
    const rows = records.map(({ key, value }) => ({
      ...serverRecordColumns(key),
      text: encodeServerRecord(key, value),
    }));
    const database = this.context.database();
    const insert = database.prepare(
      `INSERT INTO server_records (owner_key, name, record_json, updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_key, name) DO NOTHING`,
    );
    const now = this.context.now();
    return withImmediateTransaction(database, () =>
      rows.reduce(
        (written, { ownerKey, name, text }) =>
          written + Number(insert.run(ownerKey, name, text, now).changes),
        0,
      ),
    );
  }
}
