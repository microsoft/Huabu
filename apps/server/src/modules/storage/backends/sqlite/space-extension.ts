// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SQLite connection point for one extension namespace in one Space.
 *
 * The port's `extension()` is async because a backend may have to go and open
 * something. SQLite does not: `node:sqlite` is synchronous, so the whole
 * operation is a row read and possibly one insert. That matters beyond
 * tidiness — an owner whose own interface is synchronous (the Agenetes
 * conversation stores are the live example) cannot await, and would otherwise
 * have to keep its own cache warmed by an unrelated code path. So the work
 * lives in a synchronous function and the port member wraps it.
 */

import { withImmediateTransaction } from './database.js';
import { spaceRowExists } from './rows.js';
import { assertValidNamespace } from '../../ports/namespace.js';

import type { SqliteStoreContext } from './database.js';
import type { SpaceHandle, SpaceSubstrate } from '../../ports/structured.js';

/** The SQLite arm of {@link SpaceSubstrate}, for callers that narrowed already. */
export type SqliteSpaceSubstrate = Extract<SpaceSubstrate, { kind: 'sqlite' }>;

/**
 * Resolve — creating if absent — the namespace's connection point.
 *
 * `null` when the Space does not exist, which is the port's rule: refusing a
 * substrate for a Space that is gone is what stops an owner from resurrecting
 * one through an ad-hoc write.
 */
export function resolveSqliteSpaceExtension(
  context: SqliteStoreContext,
  boundWorkspaceId: string,
  canvasId: string,
  namespaceInput: string,
): SqliteSpaceSubstrate | null {
  const namespace = assertValidNamespace(namespaceInput);
  const workspaceId = context.assertBoundWorkspace(
    boundWorkspaceId,
    `SQLite Space extension(${canvasId})`,
  );
  context.assertMutationAllowed(canvasId);
  const database = context.database();

  return withImmediateTransaction(database, () => {
    if (!spaceRowExists(database, workspaceId, canvasId)) return null;

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
}

export function createSqliteSpaceExtension(
  context: SqliteStoreContext,
  boundWorkspaceId: string,
  canvasId: string,
): SpaceHandle['extension'] {
  return async function extension(namespaceInput: string) {
    return resolveSqliteSpaceExtension(
      context,
      boundWorkspaceId,
      canvasId,
      namespaceInput,
    );
  };
}
