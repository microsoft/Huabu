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
import {
  serverRecordColumns,
  serverRecordKeyFromRow,
} from '../sql/server-records.js';

import type { PostgresStoreContext } from './database.js';
import type {
  ServerRecordKey,
  ServerRecordStore,
} from '../../ports/server-records.js';

export class PostgresServerRecordStore implements ServerRecordStore {
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

  async keys(): Promise<readonly ServerRecordKey[]> {
    return (
      await this.context
        .database()
        .all('SELECT owner_key, name FROM server_records')
    ).flatMap(serverRecordKeyFromRow);
  }
}
