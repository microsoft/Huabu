// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Child process for the Disk reliable-save crash tests.
 *
 * Runs one result-carrying Space write and kills itself as soon as the named
 * stage has reached the file system.
 */

import { getCanvasStore } from './legacy/canvas-store-cache.js';
import { createDiskSpaceWrite } from './space-write.js';
import { commitWorkspacePath } from '../../../workspace.js';

import type { SpaceWriteInput } from '../../ports/structured.js';

const [root, canvasId, encoded, stage] = process.argv.slice(2);
if (!root || !canvasId || !encoded || !stage)
  throw new Error('Missing Disk crash fixture arguments');
commitWorkspacePath(root);
const write = createDiskSpaceWrite(getCanvasStore(canvasId), {
  now: () => 2000,
  onStage: (current) => {
    if (current === stage) process.kill(process.pid, 'SIGKILL');
  },
});
await write(JSON.parse(encoded) as SpaceWriteInput);
throw new Error('The requested crash stage was not reached');
