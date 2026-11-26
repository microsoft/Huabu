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
 * returned these keys and nothing changed for any reader. Which keys those
 * are is not this backend's to know (`ports/space-state-rewrites.ts`).
 */

import {
  SPACE_ORDER_KEYS_REWRITE,
  spaceStateRewrite,
} from '../../ports/space-state-rewrites.js';
import { parseJson, stringifyJson } from '../sql/codecs.js';

import type { DatabaseSync } from 'node:sqlite';

export function storeSqliteSpaceOrderKeys(database: DatabaseSync): void {
  const rows = database
    .prepare('SELECT canvas_id, state_json FROM spaces')
    .all();
  // A database with no Space has nothing to rewrite and needs no rule.
  if (rows.length === 0) return;
  const rewrite = spaceStateRewrite(SPACE_ORDER_KEYS_REWRITE);
  const update = database.prepare(
    'UPDATE spaces SET state_json = ? WHERE canvas_id = ?',
  );
  for (const row of rows) {
    const context = `Space ${String(row['canvas_id'])} state`;
    const next = rewrite(parseJson(row['state_json'], context));
    if (next !== null)
      update.run(stringifyJson(next, context), row['canvas_id']);
  }
}
