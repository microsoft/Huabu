// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { withImmediateTransaction } from './database.js';
import { parseJson, spaceRowExists, stringifyJson } from './rows.js';
import { SqlSpaceTasks, validateSnapshot } from '../sql/space-tasks.js';

import type { SqliteStoreContext } from './database.js';
import type { TaskStoreSnapshot } from '@huabu/shared';
const EMPTY_TASKS: TaskStoreSnapshot = { version: 1, tasks: [], runs: [] };
function readSnapshot(
  context: SqliteStoreContext,
  canvasId: string,
): TaskStoreSnapshot {
  const row = context
    .database()
    .prepare('SELECT snapshot_json FROM tasks WHERE canvas_id = ?')
    .get(canvasId);
  if (row === undefined) {
    return { ...EMPTY_TASKS, tasks: [], runs: [] };
  }
  return validateSnapshot(
    parseJson(row['snapshot_json'], `Task store for Canvas ${canvasId}`),
    canvasId,
  );
}

export class SqliteSpaceTasks extends SqlSpaceTasks {
  constructor(
    context: SqliteStoreContext,
    workspaceId: string,
    canvasId: string,
  ) {
    const mutate = <T>(apply: (snapshot: TaskStoreSnapshot) => T): T => {
      context.assertBoundWorkspace(workspaceId, `Space Tasks(${canvasId})`);
      context.assertMutationAllowed(canvasId);
      const database = context.database();
      return withImmediateTransaction(database, () => {
        if (!spaceRowExists(database, workspaceId, canvasId)) {
          throw new Error(
            `Space Tasks(${canvasId}) cannot write a missing Space`,
          );
        }
        const current = readSnapshot(context, canvasId);
        const next: TaskStoreSnapshot = {
          version: 1,
          tasks: [...current.tasks],
          runs: [...current.runs],
        };
        const result = apply(next);
        database
          .prepare(
            `INSERT INTO tasks (canvas_id, snapshot_json)
           VALUES (?, ?)
           ON CONFLICT(canvas_id) DO UPDATE SET
             snapshot_json = excluded.snapshot_json`,
          )
          .run(
            canvasId,
            stringifyJson(next, `Task store for Canvas ${canvasId}`),
          );
        return result;
      });
    };
    super(
      () => {
        context.assertBoundWorkspace(workspaceId, `Space Tasks(${canvasId})`);
        return readSnapshot(context, canvasId);
      },
      mutate,
      canvasId,
    );
  }
}
