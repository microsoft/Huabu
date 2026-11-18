// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The `server_records` row shape both SQL adapters share.
 *
 * SQLite and PostgreSQL store a record in the same columns; only the driver
 * differs. The deployment's records have no owner, which the table spells as
 * `''` so the primary key stays two plain non-null columns.
 */

import {
  SERVER_RECORDS,
  assertServerRecordKey,
  isServerRecordOwner,
} from '../../ports/server-records.js';

import type {
  ServerRecordKey,
  ServerRecordName,
} from '../../ports/server-records.js';

/** The validated key columns for one record. */
export function serverRecordColumns(key: ServerRecordKey): {
  ownerKey: string;
  name: ServerRecordName;
} {
  const { owner, name } = assertServerRecordKey(key);
  return { ownerKey: owner ?? '', name };
}

/**
 * Read a key back from its columns. A row neither adapter could have written
 * (an unknown name, a malformed owner) is skipped rather than reported.
 */
export function serverRecordKeyFromRow(
  row: Record<string, unknown>,
): ServerRecordKey[] {
  const ownerKey = row['owner_key'];
  const name = row['name'];
  if (typeof ownerKey !== 'string' || typeof name !== 'string') return [];
  if (!Object.hasOwn(SERVER_RECORDS, name)) return [];
  if (ownerKey !== '' && !isServerRecordOwner(ownerKey)) return [];
  return [
    {
      owner: ownerKey === '' ? null : ownerKey,
      name: name as ServerRecordName,
    },
  ];
}
