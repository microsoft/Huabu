// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * PostgreSQL implementation of the server-record port: one row per record in
 * `server_records`, on the pool the Workspace and Space adapters share.
 *
 * `pg` cannot answer synchronously, so `init()` loads every record and reads
 * are served from that snapshot. A value enters the snapshot only after its
 * upsert commits, so `get` never returns an unacknowledged write. The
 * snapshot is authoritative only while this process is the database's one
 * Huabu writer — the deployment rule this backend already documents.
 * Records are not Workspace data, so nothing here is scoped to the active
 * Workspace.
 */

import {
  decodeServerRecord,
  encodeServerRecord,
  serverRecordId,
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
  /** Stored JSON text by {@link serverRecordId}; parsed on every read. */
  readonly #snapshot = new Map<string, string>();

  /** @param context Borrowed; the composition root opens and closes it. */
  constructor(private readonly context: PostgresStoreContext) {}

  async init(): Promise<void> {
    await this.context.init();
    const rows = await this.context
      .database()
      .all('SELECT owner_key, name, record_json FROM server_records');
    this.#snapshot.clear();
    for (const row of rows) {
      const [key] = serverRecordKeyFromRow(row);
      const text = row['record_json'];
      if (key && typeof text === 'string')
        this.#snapshot.set(serverRecordId(key), text);
    }
  }

  get(key: ServerRecordKey): unknown {
    serverRecordColumns(key);
    const text = this.#snapshot.get(serverRecordId(key));
    return text === undefined ? null : decodeServerRecord(key, text);
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
    this.#snapshot.set(serverRecordId(key), text);
  }

  async keys(): Promise<readonly ServerRecordKey[]> {
    return (
      await this.context
        .database()
        .all('SELECT owner_key, name FROM server_records')
    ).flatMap(serverRecordKeyFromRow);
  }
}
