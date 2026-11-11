// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Child process for the SQLite reliable-save crash tests.
 *
 * Runs one result-carrying Space write on the production connection settings
 * and kills itself either inside the transaction (a trigger on the named
 * table) or after the write returned but before anyone could be told.
 */

import { SqliteStoreContext } from './database.js';
import { createSqliteSpaceWrite } from './space-write.js';

import type { SpaceWriteInput } from '../../ports/structured.js';

const [filename, workspaceId, canvasId, encoded, stage] = process.argv.slice(2);
if (!filename || !workspaceId || !canvasId || !encoded || !stage)
  throw new Error('Missing crash fixture arguments');
const context = new SqliteStoreContext(filename, () => 2000);
context.init();
context.useWorkspace(workspaceId);
const database = context.database();
database.function('terminate_writer', () => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('Process termination did not occur');
});
const triggers: Record<string, string> = {
  sidecar: 'AFTER INSERT ON nodes',
  state: 'AFTER UPDATE ON spaces',
  delta: 'AFTER INSERT ON delta_log',
  stamps: 'AFTER UPDATE ON space_save_heads',
  result: 'AFTER INSERT ON space_save_results',
};
const trigger = triggers[stage];
if (trigger)
  database.exec(
    `CREATE TEMP TRIGGER terminate_save ${trigger} BEGIN SELECT terminate_writer(); END;`,
  );
if (!trigger && stage !== 'committed-before-reply')
  throw new Error('Unknown crash fixture stage');
const write = createSqliteSpaceWrite(context, workspaceId, canvasId);
const outcome = await write(JSON.parse(encoded) as SpaceWriteInput);
if (!outcome.ok) throw new Error(`Write was refused: ${outcome.reason}`);
if (trigger) throw new Error('The requested crash stage was not reached');
process.kill(process.pid, 'SIGKILL');
