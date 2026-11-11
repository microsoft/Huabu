// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createDiskSpaceOperations } from './space-operations.js';
import { commitWorkspacePath } from '../../../workspace.js';

import type { SpaceOperationWrite } from '../../ports/operations.js';

const [root, canvasId, encoded, stage] = process.argv.slice(2);
if (!root || !canvasId || !encoded || !stage)
  throw new Error('Missing Disk crash fixture arguments');
commitWorkspacePath(root);
const operations = createDiskSpaceOperations(
  canvasId,
  () => 2000,
  (current) => {
    if (current === stage) process.kill(process.pid, 'SIGKILL');
  },
);
await operations.commit(JSON.parse(encoded) as SpaceOperationWrite);
throw new Error('The requested crash stage was not reached');
