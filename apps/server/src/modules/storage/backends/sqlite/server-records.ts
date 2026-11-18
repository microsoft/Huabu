// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SQLite implementation of the server-record port: one row per record in
 * `server_records`, on the connection the Workspace and Space adapters share.
 *
 * Every read queries the table. Records are not Workspace data, so nothing
 * here is scoped to the active Workspace.
 */

import {
  decodeServerRecord,
  encodeServerRecord,
} from '../../ports/server-records.js';
import {
  serverRecordColumns,
  serverRecordKeyFromRow,
} from '../sql/server-records.js';

import type { SqliteStoreContext } from './database.js';
import type {
  ServerRecordKey,
  ServerRecordStore,
} from '../../ports/server-records.js';

export class SqliteServerRecordStore implements ServerRecordStore {
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

  async keys(): Promise<readonly ServerRecordKey[]> {
    return this.context
      .database()
      .prepare('SELECT owner_key, name FROM server_records')
      .all()
      .flatMap(serverRecordKeyFromRow);
  }
}
