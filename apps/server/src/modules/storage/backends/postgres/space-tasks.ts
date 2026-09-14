// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spaceRowExists } from './rows.js';
import { parseJson, stringifyJson } from '../sql/codecs.js';
import { SqlSpaceTasks, validateSnapshot } from '../sql/space-tasks.js';

import type { PgExecutor, PostgresStoreContext } from './database.js';
import type { TaskStoreSnapshot } from '@huabu/shared';

async function readSnapshot(
  database: PgExecutor,
  canvasId: string,
): Promise<TaskStoreSnapshot> {
  const row = await database.get(
    'SELECT snapshot_json FROM tasks WHERE canvas_id = ?',
    canvasId,
  );
  return row === undefined
    ? { version: 1, tasks: [], runs: [] }
    : validateSnapshot(
        parseJson(row['snapshot_json'], `Tasks(${canvasId})`),
        canvasId,
      );
}

export class PostgresSpaceTasks extends SqlSpaceTasks {
  constructor(
    context: PostgresStoreContext,
    workspaceId: string,
    canvasId: string,
  ) {
    const guard = () =>
      context.assertBoundWorkspace(workspaceId, `Tasks(${canvasId})`);
    super(
      async () => {
        guard();
        if (!(await spaceRowExists(context.database(), workspaceId, canvasId)))
          return { version: 1, tasks: [], runs: [] };
        return readSnapshot(context.database(), canvasId);
      },
      async <T>(apply: (snapshot: TaskStoreSnapshot) => T): Promise<T> => {
        guard();
        context.assertMutationAllowed(canvasId);
        return context.transaction(async (database) => {
          if (!(await spaceRowExists(database, workspaceId, canvasId)))
            throw new Error(
              `Space Tasks(${canvasId}) cannot write a missing Space`,
            );
          const snapshot = await readSnapshot(database, canvasId);
          const result = apply(snapshot);
          await database.run(
            `INSERT INTO tasks (canvas_id, snapshot_json) VALUES (?, ?)
          ON CONFLICT(canvas_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
            canvasId,
            stringifyJson(snapshot, `Tasks(${canvasId})`),
          );
          return result;
        });
      },
      canvasId,
    );
  }
}
