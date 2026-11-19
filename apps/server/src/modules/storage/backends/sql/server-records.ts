// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The `server_records` row shape both SQL adapters share.
 *
 * SQLite and PostgreSQL store a record in the same columns; only the driver
 * differs. The deployment's records have no owner, which the table spells as
 * `''` so the primary key stays two plain non-null columns.
 */

import { assertServerRecordKey } from '../../ports/server-records.js';

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
