// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SqliteStoreContext } from './database.js';
import { createSqliteSpaceOperations } from './space-operations.js';

import type { SpaceOperationWrite } from '../../ports/operations.js';

const [filename, workspaceId, canvasId, encoded, stage] = process.argv.slice(2);
if (!filename || !workspaceId || !canvasId || !encoded || !stage)
  throw new Error('Missing crash fixture arguments');
const context = new SqliteStoreContext(filename, () => 2000);
context.init();
context.useWorkspace(workspaceId);
const database = context.database();
database.exec('PRAGMA synchronous=FULL');
database.function('terminate_writer', () => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('Process termination did not occur');
});
const triggers: Record<string, string> = {
  sidecar: 'AFTER UPDATE ON nodes',
  'sidecar-insert': 'AFTER INSERT ON nodes',
  'sidecar-delete': 'AFTER DELETE ON nodes',
  state: 'AFTER UPDATE ON spaces',
  review: 'AFTER INSERT ON changes',
  journal: 'AFTER INSERT ON operation_commits',
  receipt: 'AFTER INSERT ON operation_receipts',
};
const trigger = triggers[stage];
if (trigger)
  database.exec(
    `CREATE TEMP TRIGGER terminate_operation ${trigger} BEGIN SELECT terminate_writer(); END;`,
  );
if (stage === 'review')
  database.exec(
    'CREATE TEMP TRIGGER terminate_review_update AFTER UPDATE ON changes BEGIN SELECT terminate_writer(); END;',
  );
if (!trigger && stage !== 'committed-before-reply')
  throw new Error('Unknown crash fixture stage');
const operations = createSqliteSpaceOperations(context, workspaceId, canvasId);
await operations.commit(JSON.parse(encoded) as SpaceOperationWrite);
process.kill(process.pid, 'SIGKILL');
