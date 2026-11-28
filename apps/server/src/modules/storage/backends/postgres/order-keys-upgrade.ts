// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Data step of Postgres schema version 5: store the order keys of every
 * Space written before nodes carried them.
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

import type { PoolClient } from 'pg';

export async function storePostgresSpaceOrderKeys(
  client: PoolClient,
): Promise<void> {
  const { rows } = await client.query(
    'SELECT canvas_id, state_json FROM spaces',
  );
  // A database with no Space has nothing to rewrite and needs no rule.
  if (rows.length === 0) return;
  const rewrite = spaceStateRewrite(SPACE_ORDER_KEYS_REWRITE);
  for (const row of rows as { canvas_id: string; state_json: string }[]) {
    const context = `Space ${row.canvas_id} state`;
    const next = rewrite(parseJson(row.state_json, context));
    if (next !== null)
      await client.query(
        'UPDATE spaces SET state_json = $1 WHERE canvas_id = $2',
        [stringifyJson(next, context), row.canvas_id],
      );
  }
}
