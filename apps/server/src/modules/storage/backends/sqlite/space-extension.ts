// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** SQLite connection point for one extension namespace in one Space. */

import { withImmediateTransaction } from './database.js';
import { assertValidNamespace } from '../../ports/namespace.js';

import type { SqliteStoreContext } from './database.js';
import type { SpaceHandle } from '../../ports/structured.js';

export function createSqliteSpaceExtension(
  context: SqliteStoreContext,
  canvasId: string,
): SpaceHandle['extension'] {
  return async function extension(namespaceInput: string) {
    const namespace = assertValidNamespace(namespaceInput);
    context.assertMutationAllowed(canvasId);
    const database = context.database();

    return withImmediateTransaction(database, () => {
      const exists =
        database
          .prepare('SELECT 1 AS present FROM spaces WHERE canvas_id = ?')
          .get(canvasId)?.['present'] === 1;
      if (!exists) return null;

      database
        .prepare(
          `INSERT INTO space_extensions (canvas_id, namespace)
           VALUES (?, ?)
           ON CONFLICT(canvas_id, namespace) DO NOTHING`,
        )
        .run(canvasId, namespace);
      const extensionId = database
        .prepare(
          `SELECT extension_id
           FROM space_extensions
           WHERE canvas_id = ? AND namespace = ?`,
        )
        .get(canvasId, namespace)?.['extension_id'];
      if (
        typeof extensionId !== 'number' ||
        !Number.isSafeInteger(extensionId) ||
        extensionId <= 0
      ) {
        throw new Error(
          `Could not resolve SQLite extension ${JSON.stringify(namespace)}`,
        );
      }
      return Object.freeze({
        kind: 'sqlite' as const,
        database,
        extensionId,
      });
    });
  };
}
