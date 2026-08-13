// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SqliteStructuredStore } from './structured-store.js';
import {
  createSqliteTestFile,
  installDeltaAbortTrigger,
  openSqliteTestStore,
  readSqliteDeltaLog,
} from './test-support.js';
import { describeSpaceLogsContract } from '../../ports/contracts/space-logs.contract.js';
import { describeSpaceNodesContract } from '../../ports/contracts/space-nodes.contract.js';
import { describeSpaceRepositoryContract } from '../../ports/contracts/space-repository.contract.js';
import { describeSpaceTasksContract } from '../../ports/contracts/space-tasks.contract.js';
import { describeSpaceWriteContract } from '../../ports/contracts/space-write.contract.js';
import { describeStructuredStoreContract } from '../../ports/contracts/structured-store.contract.js';

import type { NodeContent } from '../../../canvas/persistence-types.js';

function note(nodeId: string, label: string, content: string): NodeContent {
  return { nodeId, type: 'note', label, content };
}

async function createOrdinarySpace(
  store: SqliteStructuredStore,
  canvasId: string,
  title: string,
): Promise<void> {
  const created = await store.spaces().create({ canvasId, title });
  if (!created.ok) throw new Error(`Could not create test Space ${canvasId}`);
}

describeStructuredStoreContract('SQLite', () => {
  const file = createSqliteTestFile('huabu-sqlite-structured-contract-');
  return {
    store: new SqliteStructuredStore(file.filename),
    cleanup: file.remove,
  };
});

describeSpaceRepositoryContract('SQLite', async () => {
  const harness = await openSqliteTestStore(
    'huabu-sqlite-space-repository-contract-',
  );
  return {
    repository: harness.store.spaces(),
    read: (canvasId: string) => harness.store.space(canvasId).read(),
    worldCanvasId: harness.world.canvasId,
    attemptMutation: (canvasId: string) =>
      harness.store.space(canvasId).nodes.put({
        nodeId: 'contract-delete-fence-node',
        record: note(
          'contract-delete-fence-node',
          'Deletion fence node',
          'body',
        ),
      }),
    cleanup: harness.cleanup,
  };
});

describeSpaceNodesContract('SQLite', async () => {
  const harness = await openSqliteTestStore('huabu-sqlite-nodes-contract-');
  const canvasId = 'sqlite-nodes-contract';
  await createOrdinarySpace(harness.store, canvasId, 'SQLite Nodes Contract');
  const space = harness.store.space(canvasId);
  return {
    repository: space.nodes,
    space,
    missingRepository: harness.store.space('sqlite-nodes-missing').nodes,
    expectedCanvasId: canvasId,
    cleanup: harness.cleanup,
  };
});

describeSpaceWriteContract('SQLite', async () => {
  const harness = await openSqliteTestStore('huabu-sqlite-write-contract-');
  const canvasId = 'sqlite-write-contract';
  await createOrdinarySpace(harness.store, canvasId, 'SQLite Write Contract');
  const existingNode = note(
    'contract-existing-node',
    'Existing contract node',
    'before',
  );
  const space = harness.store.space(canvasId);
  const put = await space.nodes.put({
    nodeId: existingNode.nodeId,
    record: existingNode,
  });
  if (!put.ok) {
    throw new Error(`Could not seed SQLite write contract: ${put.reason}`);
  }

  return {
    space,
    concurrent: harness.store.space(canvasId),
    missing: harness.store.space('sqlite-write-missing'),
    existingNode,
    newNode: note('contract-new-node', 'New contract node', 'after'),
    readJournal: async () => readSqliteDeltaLog(harness.filename, canvasId),
    failNextDeltaAppend: (error: Error) =>
      installDeltaAbortTrigger(harness.filename, error.message),
    cleanup: harness.cleanup,
  };
});

describeSpaceLogsContract('SQLite', async () => {
  const harness = await openSqliteTestStore('huabu-sqlite-logs-contract-');
  const canvasId = 'sqlite-logs-contract';
  await createOrdinarySpace(harness.store, canvasId, 'SQLite Logs Contract');
  const first = harness.store.space(canvasId);
  const second = harness.store.space(canvasId);
  return {
    events: first.events,
    changes: first.changes,
    concurrent: {
      events: second.events,
      changes: second.changes,
    },
    cleanup: harness.cleanup,
  };
});

describeSpaceTasksContract('SQLite', async () => {
  const harness = await openSqliteTestStore('huabu-sqlite-tasks-contract-');
  const canvasId = 'sqlite-tasks-contract';
  const missingCanvasId = 'sqlite-tasks-missing';
  await createOrdinarySpace(harness.store, canvasId, 'SQLite Tasks Contract');
  return {
    tasks: harness.store.space(canvasId).tasks,
    concurrent: harness.store.space(canvasId).tasks,
    canvasId,
    missing: harness.store.space(missingCanvasId).tasks,
    missingCanvasId,
    beginDelete: async () => {
      const result = await harness.store.spaces().beginDelete({ canvasId });
      if (!result.ok) throw new Error('Ordinary Space must be deletable');
      return result.session;
    },
    cleanup: harness.cleanup,
  };
});
