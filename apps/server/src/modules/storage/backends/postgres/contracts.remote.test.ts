// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { PostgresStoreContext } from './database.js';
import {
  PostgresServerRecordStore,
  postgresDatabaseHoldsServerRecords,
  postgresServerRecordBeforeInit,
} from './server-records.js';
import { PostgresStructuredStore } from './structured-store.js';
import {
  openPostgresTestDatabase,
  openPostgresTestStore,
} from './test-support.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';
import {
  describeServerRecordImportContract,
  describeServerRecordStoreContract,
} from '../../ports/contracts/server-records.contract.js';
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
    space: h.space,
    // A second pool on the same schema, as a restarted Server has.
    reopen: () => h.concurrent.nodes,
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

it('orders node writes of one Space made through two pools at once, without deadlock', async () => {
  const h = await ordinary();
  try {
    const { nodes } = h.space;
    for (const id of ['seed-a', 'seed-b'])
      await nodes.put({ nodeId: id, record: note(id, `Seed ${id}`, 'seed') });
    const { position } = await nodes.changes();

    // Standalone puts on both pools race Space writes that delete one node
    // and put another — the two shapes that take the Space row and a node
    // row in what would otherwise be opposite orders.
    let version = (await h.space.read())?.version ?? 0;
    const writes = (async () => {
      for (let round = 0; round < 6; round += 1) {
        const record = await h.space.read();
        if (!record) throw new Error('Space is missing');
        const written = await h.space.write({
          expectedVersion: record.version,
          nextRecord: { ...record, version: record.version + 1 },
          nodeMutations: [
            { kind: 'delete', nodeId: 'seed-a' },
            {
              kind: 'put',
              nodeId: `batch-${round}`,
              record: note(`batch-${round}`, `Batch ${round}`, 'batch'),
            },
          ],
        });
        expect(written.ok).toBe(true);
        version = record.version + 1;
      }
    })();
    const puts = Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? h.concurrent.nodes : nodes).put({
          nodeId: index % 3 ? `put-${index}` : 'seed-a',
          record:
            index % 3
              ? note(`put-${index}`, `Put ${index}`, 'put')
              : note('seed-a', 'Seed seed-a', `rewritten ${index}`),
        }),
      ),
    );
    await Promise.all([writes, puts]);
    expect(version).toBeGreaterThan(0);

    const after = await nodes.changes(position);
    const present = new Set((await nodes.list()).keys());
    present.delete('seed-b');
    // Everything written since, and still there, is named; the untouched
    // node is not.
    expect(new Set(after.nodeIds)).toEqual(present);
    expect(after.position.seq).toBeGreaterThan(position.seq);
    // A position read now is behind every later write.
    await nodes.put({ nodeId: 'late', record: note('late', 'Late', 'late') });
    expect((await nodes.changes(after.position)).nodeIds).toEqual(['late']);
  } finally {
    await h.cleanup();
  }
});

describeServerRecordStoreContract('Postgres', async () => {
  const h = await openPostgresTestStore(false);
  const peers: PostgresStoreContext[] = [];
  const store = new PostgresServerRecordStore(h.context);
  await store.init();
  return {
    store,
    reopen: async () => {
      const context = new PostgresStoreContext(h.config);
      peers.push(context);
      const reopened = new PostgresServerRecordStore(context);
      await reopened.init();
      return reopened;
    },
    cleanup: async () => {
      try {
        for (const peer of peers) await peer.close();
      } finally {
        await h.cleanup();
      }
    },
  };
});

describeServerRecordImportContract('Postgres', async () => {
  const h = await openPostgresTestStore(false);
  const store = new PostgresServerRecordStore(h.context);
  await store.init();
  // Startup asks before it opens, on a connection that has not migrated.
  const unopened = new PostgresStoreContext(h.config);
  return {
    store,
    holdsRecords: () => postgresDatabaseHoldsServerRecords(unopened),
    cleanup: async () => {
      try {
        await unopened.close();
      } finally {
        await h.cleanup();
      }
    },
  };
});

it('asks the schema it would upgrade about records, not another on the search_path', async () => {
  const key = { owner: null, name: 'credentials' } as const;
  const tenant = await openPostgresTestDatabase();
  const shared = await openPostgresTestDatabase();
  const schemaOf = (database: { config: { options: string } }) =>
    database.config.options.replace('-c search_path=', '');
  const contexts: PostgresStoreContext[] = [];
  try {
    // A later schema on the path already holds records.
    const holder = new PostgresStoreContext(shared.config);
    contexts.push(holder);
    const held = new PostgresServerRecordStore(holder);
    await held.init();
    await held.put(key, { v: 'shared' });

    // The tenant schema, first on the path, holds none yet.
    const context = new PostgresStoreContext({
      ...tenant.config,
      options: `-c search_path=${schemaOf(tenant)},${schemaOf(shared)}`,
    });
    contexts.push(context);
    expect(await postgresDatabaseHoldsServerRecords(context)).toBe(false);
    expect(await postgresServerRecordBeforeInit(context, key)).toBeNull();

    // Opening migrates the tenant schema, and its own rows answer from then on.
    const store = new PostgresServerRecordStore(context);
    await store.init();
    await store.put(key, { v: 'tenant' });
    expect(await postgresDatabaseHoldsServerRecords(context)).toBe(true);
    expect(await postgresServerRecordBeforeInit(context, key)).toEqual({
      v: 'tenant',
    });
  } finally {
    for (const context of contexts) await context.close();
    await tenant.cleanup();
    await shared.cleanup();
  }
});
