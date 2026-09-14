// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PostgresStoreContext } from './database.js';
import { PostgresStructuredStore } from './structured-store.js';
import { openPostgresTestStore } from './test-support.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';
import { describeSpaceExtensionContract } from '../../ports/contracts/space-extension.contract.js';
import { describeSpaceLogsContract } from '../../ports/contracts/space-logs.contract.js';
import { describeSpaceNodesContract } from '../../ports/contracts/space-nodes.contract.js';
import { describeSpaceRepositoryContract } from '../../ports/contracts/space-repository.contract.js';
import { describeSpaceTasksContract } from '../../ports/contracts/space-tasks.contract.js';
import { describeSpaceWriteContract } from '../../ports/contracts/space-write.contract.js';
import { describeStructuredStoreContract } from '../../ports/contracts/structured-store.contract.js';
import { describeWorkspaceRepositoryContract } from '../../ports/contracts/workspace-repository.contract.js';

import type { NodeContent } from '../../../canvas/persistence-types.js';

function note(nodeId: string, label: string, content: string): NodeContent {
  return { nodeId, type: 'note', label, content };
}

async function ordinary() {
  const harness = await openPostgresTestStore();
  const canvasId = 'contract-space';
  await harness.store.spaces().create({ canvasId, title: 'Contract Space' });
  const peer = new PostgresStoreContext(harness.config);
  try {
    await peer.init();
    peer.useWorkspace(harness.workspaceId);
    return {
      ...harness,
      canvasId,
      space: harness.store.space(canvasId),
      concurrent: new PostgresStructuredStore(peer).space(canvasId),
      cleanup: async () => {
        try {
          await peer.close();
        } finally {
          await harness.cleanup();
        }
      },
    };
  } catch (error) {
    await peer.close();
    await harness.cleanup();
    throw error;
  }
}

describeStructuredStoreContract('Postgres', async () => {
  const h = await openPostgresTestStore(false);
  return { store: h.store, cleanup: h.cleanup };
});

describeSpaceRepositoryContract('Postgres', async () => {
  const h = await openPostgresTestStore();
  const extra: Array<Awaited<ReturnType<typeof openPostgresTestStore>>> = [];
  return {
    repository: h.store.spaces(),
    read: (id: string) => h.store.space(id).read(),
    worldCanvasId: h.worldId!,
    attemptMutation: (id: string) =>
      h.store.space(id).nodes.put({
        nodeId: 'fence-node',
        record: note('fence-node', 'Fence', 'body'),
      }),
    openEmptyNamespace: async () => {
      const empty = await openPostgresTestStore(false);
      extra.push(empty);
      return {
        repository: empty.store.spaces(),
        read: (id: string) => empty.store.space(id).read(),
      };
    },
    cleanup: async () => {
      for (const e of extra) await e.cleanup();
      await h.cleanup();
    },
  };
});

describeSpaceNodesContract('Postgres', async () => {
  const h = await ordinary();
  return {
    repository: h.space.nodes,
    missingRepository: h.store.space('missing').nodes,
    expectedCanvasId: h.canvasId,
    deletedNodePut: 'allowed',
    cleanup: h.cleanup,
  };
});

describeSpaceWriteContract('Postgres', async () => {
  const h = await ordinary();
  const existingNode = note(
    'contract-existing-node',
    'Existing contract node',
    'before',
  );
  await h.space.nodes.put({
    nodeId: existingNode.nodeId,
    record: existingNode,
  });
  return {
    space: h.space,
    concurrent: h.concurrent,
    missing: h.store.space('missing'),
    existingNode,
    newNode: note('contract-new-node', 'New contract node', 'after'),
    readJournal: async () =>
      (
        await h.context
          .database()
          .all(
            'SELECT entry_json FROM delta_log WHERE canvas_id = ? ORDER BY version',
            h.canvasId,
          )
      ).map((row) => JSON.parse(String(row['entry_json']))),
    failNextDeltaAppend: async (error: Error) => {
      const message = error.message.split("'").join("''");
      await h.context.connection()
        .query(`CREATE FUNCTION abort_delta() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION '${message}'; END $fn$;
        CREATE TRIGGER abort_delta BEFORE INSERT ON delta_log FOR EACH ROW EXECUTE FUNCTION abort_delta()`);
      return async () => {
        await h.context
          .connection()
          .query(
            'DROP TRIGGER abort_delta ON delta_log; DROP FUNCTION abort_delta()',
          );
      };
    },
    cleanup: h.cleanup,
  };
});

describeSpaceLogsContract('Postgres', async () => {
  const h = await ordinary();
  const concurrent = h.concurrent;
  return {
    events: h.space.events,
    changes: h.space.changes,
    concurrent: { events: concurrent.events, changes: concurrent.changes },
    cleanup: h.cleanup,
  };
});

describeSpaceTasksContract('Postgres', async () => {
  const h = await ordinary();
  return {
    tasks: h.space.tasks,
    concurrent: h.concurrent.tasks,
    canvasId: h.canvasId,
    missing: h.store.space('missing').tasks,
    missingCanvasId: 'missing',
    beginDelete: async () => {
      const result = await h.store
        .spaces()
        .beginDelete({ canvasId: h.canvasId });
      if (!result.ok) throw new Error('Expected delete session');
      return result.session;
    },
    cleanup: h.cleanup,
  };
});

describeSpaceExtensionContract('Postgres', async () => {
  const h = await openPostgresTestStore();
  await h.context.connection().query(`CREATE TABLE contract_extension_values (
    extension_id INTEGER PRIMARY KEY REFERENCES space_extensions(extension_id) ON DELETE CASCADE, value TEXT NOT NULL)`);
  return {
    repository: h.store.spaces(),
    space: (id: string) => h.store.space(id),
    write: async (substrate, value: string) => {
      if (substrate.kind !== 'postgres') throw new Error('Expected Postgres');
      await substrate.database.query(
        `INSERT INTO contract_extension_values (extension_id, value) VALUES ($1, $2)
        ON CONFLICT(extension_id) DO UPDATE SET value = excluded.value`,
        [substrate.extensionId, value],
      );
    },
    read: async (substrate) => {
      if (substrate.kind !== 'postgres') throw new Error('Expected Postgres');
      const row = (
        await substrate.database.query(
          'SELECT value FROM contract_extension_values WHERE extension_id = $1',
          [substrate.extensionId],
        )
      ).rows[0];
      return row?.value ?? null;
    },
    cleanup: h.cleanup,
  };
});

describeWorkspaceRepositoryContract('Postgres', async () => {
  const h = await openPostgresTestStore(false);
  await h.context.connection().query('DELETE FROM workspaces');
  const repository = new PostgresWorkspaceRepository(h.context);
  return {
    repository,
    create: (name: string) => repository.create(name),
    cleanup: h.cleanup,
  };
});
