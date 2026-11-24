// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Data step of SQLite schema version 5: store the order keys of every Space
 * written before nodes carried them.
 *
 * Runs once per database, inside the upgrade transaction, so either every
 * Space has its keys and the version says so, or nothing changed. Only
 * `state_json` is replaced: `version`, `updated_at`, the change log, the
 * stamps and the node rows stay as they are, because the read already
 * returned these keys and nothing changed for any reader.
 */

import { storedNodesWithOrderKeys } from '../../../canvas/stored-node-order.js';
import { parseJson, stringifyJson } from '../sql/codecs.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { DatabaseSync } from 'node:sqlite';

export function storeSqliteSpaceOrderKeys(database: DatabaseSync): void {
  const update = database.prepare(
    'UPDATE spaces SET state_json = ? WHERE canvas_id = ?',
  );
  for (const row of database
    .prepare('SELECT canvas_id, state_json FROM spaces')
    .all()) {
    const context = `Space ${String(row['canvas_id'])} state`;
    const state = parseJson(row['state_json'], context) as CanvasFile['state'];
    const nodes = storedNodesWithOrderKeys(state);
    if (nodes)
      update.run(stringifyJson({ ...state, nodes }, context), row['canvas_id']);
  }
}
