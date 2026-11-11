// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { PostgresStoreContext } from './database.js';
import { createPostgresSpaceOperations } from './space-operations.js';
import { openPostgresTestStore } from './test-support.js';
import { prepareOperationCandidate } from '../../../canvas/operations/candidate.js';
import { submitOperationAlreadyLocked } from '../../../canvas/operations/service.js';

import type { SpaceOperationSnapshot } from '../../ports/operations.js';
import type { CanvasOperationRequest } from '@huabu/shared';
import type { Socket } from 'node:net';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(nodeType = 'note') {
  const h = await openPostgresTestStore(false);
  cleanup.push(h.cleanup);
  const canvasId = 'operations-test';
  const created = await h.store
    .spaces()
    .create({ canvasId, title: 'Operations' });
  if (!created.ok) throw new Error('Space fixture creation failed');
  const record = {
    ...created.record,
    state: {
      nodes: [
        {
          id: 'a',
          type: nodeType,
          position: { x: 0, y: 0 },
          data: nodeType === 'question' ? { threadId: 'thread-test' } : {},
        },
      ],
      edges: [],
    },
  };
  const spaceEpoch = randomUUID();
  const metadata: SpaceOperationSnapshot['metadata'] = {
    modelVersion: 1,
    spaceEpoch,
    earliestReplayVersion: 0,
    reviewRevision: 0,
    siblingOrderVersions: [{ parentId: null, version: 0 }],
    nodes: {
      a: {
        incarnation: randomUUID(),
        membershipVersion: 0,
        coordinateContext: `root:${spaceEpoch}`,
        fieldVersions: { position: 0, 'style.accent': 0 },
      },
    },
  };
  if (nodeType === 'web' || nodeType === 'question' || nodeType === 'video')
    await h.store.space(canvasId).nodes.put({
      nodeId: 'a',
      record: {
        nodeId: 'a',
        type: nodeType,
        label: 'A',
        content: 'Original body',
        ...(nodeType === 'video' ? { src: 'movie.mp4' } : {}),
      },
    });
  await h.context.transaction(async (db) => {
    await db.run(
      'UPDATE spaces SET state_json = ? WHERE canvas_id = ?',
      JSON.stringify(record.state),
      canvasId,
    );
    await db.run(
      'INSERT INTO operation_heads (workspace_id, canvas_id, metadata_json) VALUES (?, ?, ?)',
      h.workspaceId,
      canvasId,
      JSON.stringify(metadata),
    );
  });
  const operations = createPostgresSpaceOperations(
    h.context,
    h.workspaceId,
    canvasId,
  );
  const session = await operations.createSession('owner');
  const snapshot = await operations.readSnapshot();
  if (!snapshot) throw new Error('Missing operation fixture baseline');
  const request: CanvasOperationRequest = {
    protocolVersion: 1,
    spaceEpoch,
    sessionId: session.sessionId,
    operationId: randomUUID(),
    observedVersion: 0,
    mode: 'atomic',
    commands: [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'a', position: { x: 10, y: 20 } }],
      },
    ],
    preconditions: [
      {
        kind: 'coordinates',
        commandIndex: 0,
        nodeId: 'a',
        incarnation: metadata.nodes['a']!.incarnation,
        parentId: null,
        membershipVersion: 0,
        coordinateContext: metadata.nodes['a']!.coordinateContext,
      },
    ],
  };
  return {
    ...h,
    canvasId,
    operations,
    request,
    snapshot,
  };
}

describe('PostgreSQL operation transaction integration', () => {
  it('resolves an actual lost COMMIT reply through the original receipt on a new connection', async () => {
    const f = await fixture();
    const target = new URL(f.config.connectionString);
    let armed = false;
    let dropped = false;
    const sockets = new Set<Socket>();
    const proxy = createServer((client) => {
      const directory = target.searchParams.get('host');
      const backend = directory
        ? createConnection(
            path.join(directory, `.s.PGSQL.${target.port || '5432'}`),
          )
        : createConnection({
            host: target.hostname,
            port: Number(target.port || 5432),
          });
      sockets.add(client);
      sockets.add(backend);
      const close = () => {
        client.destroy();
        backend.destroy();
      };
      client.on('error', close);
      backend.on('error', close);
      client.on('close', () => {
        sockets.delete(client);
        backend.destroy();
      });
      backend.on('close', () => {
        sockets.delete(backend);
        client.destroy();
      });
      client.pipe(backend);
      let pending: Buffer = Buffer.alloc(0);
      backend.on('data', (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        while (pending.length >= 5) {
          const length = pending.readInt32BE(1) + 1;
          if (length < 5) {
            close();
            return;
          }
          if (pending.length < length) return;
          const message = pending.subarray(0, length);
          pending = pending.subarray(length);
          // Observe the server's successful COMMIT, but discard that reply on
          // the wire so the actual pg client cannot distinguish its outcome.
          if (
            armed &&
            message[0] === 67 &&
            message.subarray(5).toString() === 'COMMIT\0'
          ) {
            armed = false;
            dropped = true;
            close();
            return;
          }
          client.write(message);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = proxy.address();
    if (!address || typeof address === 'string')
      throw new Error('Proxy did not bind');
    const url = new URL(target);
    url.hostname = '127.0.0.1';
    url.port = String(address.port);
    url.searchParams.delete('host');
    const context = new PostgresStoreContext({
      ...f.config,
      connectionString: url.toString(),
    });
    cleanup.push(() => context.close());
    await context.init();
    context.useWorkspace(f.workspaceId);
    const operations = createPostgresSpaceOperations(
      context,
      f.workspaceId,
      f.canvasId,
    );
    const plan = prepareOperationCandidate(
      f.snapshot,
      f.request,
      'owner',
      { kind: 'ui' },
      Date.now(),
    );
    armed = true;
    await expect(operations.commit(plan)).rejects.toThrow();
    expect(dropped).toBe(true);
    expect(await operations.lookup(plan.key, plan.digest)).toEqual({
      status: 'terminal',
      receipt: plan.receipt,
    });
    expect(await operations.commit(plan)).toEqual(plan.receipt);
    expect((await operations.readSnapshot())?.record.version).toBe(1);
  });

  it.each(['create', 'delete'] as const)(
    'rolls back %s lifetimes on sidecar backend termination and preserves retry IDs',
    async (kind) => {
      const f = await fixture();
      const creation: CanvasOperationRequest = {
        ...f.request,
        preconditions: [],
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'new-node',
                nodeType: 'note',
                data: { label: 'New', content: 'New body' },
                position: { x: 1, y: 2 },
              },
            ],
          },
        ],
      };
      let request = creation;
      let snapshot = f.snapshot;
      if (kind === 'delete') {
        await submitOperationAlreadyLocked(
          f.operations,
          creation,
          'owner',
          { kind: 'ui' },
          Date.now(),
        );
        const current = await f.operations.readSnapshot();
        const meta = current?.metadata.nodes['new-node'];
        const body = current?.sidecars['new-node'];
        if (!current || !meta || !body)
          throw new Error('Missing created fixture');
        snapshot = current;
        request = {
          ...creation,
          operationId: randomUUID(),
          observedVersion: current.record.version,
          commands: [{ type: 'DELETE_NODES', nodeIds: ['new-node'] }],
          preconditions: [
            {
              kind: 'delete',
              commandIndex: 0,
              nodeId: 'new-node',
              ...meta,
              expectRev: nodeRevisionOf(body),
            },
          ],
        };
      }
      const plan = prepareOperationCandidate(
        snapshot,
        request,
        'owner',
        { kind: 'ui' },
        Date.now(),
      );
      await f.context.database()
        .run(`CREATE FUNCTION terminate_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$`);
      await f.context.database()
        .run(`CREATE TRIGGER terminate_lifecycle_writer AFTER INSERT OR DELETE ON nodes
      FOR EACH ROW EXECUTE FUNCTION terminate_lifecycle()`);
      await expect(f.operations.commit(plan)).rejects.toThrow();
      await f.context
        .database()
        .run('DROP TRIGGER terminate_lifecycle_writer ON nodes');
      expect(await f.operations.readSnapshot()).toEqual(snapshot);
      expect(await f.operations.lookup(plan.key, plan.digest)).toEqual({
        status: 'absent',
      });
      expect(await f.operations.commit(plan)).toEqual(plan.receipt);
      expect(
        await submitOperationAlreadyLocked(
          f.operations,
          request,
          'owner',
          { kind: 'ui' },
          Date.now(),
        ),
      ).toEqual(plan.receipt);
      const saved = await f.operations.readSnapshot();
      expect(saved?.record.version).toBe(snapshot.record.version + 1);
      expect(Boolean(saved?.sidecars['new-node'])).toBe(kind === 'create');
      expect(Boolean(saved?.metadata.retiredNodes?.['new-node'])).toBe(
        kind === 'delete',
      );
    },
  );

  it('persists canonical commits and returns the original receipt across fresh handles', async () => {
    const f = await fixture();
    const receipt = await submitOperationAlreadyLocked(
      f.operations,
      f.request,
      'owner',
      { kind: 'ui' },
      Date.now(),
    );
    const fresh = createPostgresSpaceOperations(
      f.context,
      f.workspaceId,
      f.canvasId,
    );
    expect(
      await submitOperationAlreadyLocked(
        fresh,
        f.request,
        'owner',
        { kind: 'ui' },
        Date.now(),
      ),
    ).toEqual(receipt);
    expect((await fresh.readSnapshot())?.record.version).toBe(1);
    expect(
      await fresh.readCommits({
        spaceEpoch: f.request.spaceEpoch,
        afterVersion: 0,
        limit: 200,
        maxBytes: 4194304,
      }),
    ).toMatchObject({
      status: 'commits',
      commits: [receipt.commit],
      nextAfterVersion: 1,
    });
  });

  it.each(['spaces', 'changes', 'operation_commits', 'operation_receipts'])(
    'rolls back all records when the backend terminates at %s',
    async (table) => {
      const f = await fixture();
      const plan = prepareOperationCandidate(
        f.snapshot,
        f.request,
        'owner',
        { kind: 'ui' },
        Date.now(),
      );
      if (plan.receipt.status !== 'committed')
        throw new Error('Missing commit fixture');
      plan.receipt.commit.reviewRevision = 1;
      const input = {
        ...plan,
        metadata: { ...plan.metadata, reviewRevision: 1 },
        review: [{ threadId: 'thread-a', records: [] }],
      };
      await f.context.database()
        .run(`CREATE FUNCTION terminate_operation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$`);
      // The table identifier is selected exclusively from the fixed test matrix.
      await f.context.database()
        .run(`CREATE TRIGGER terminate_writer AFTER INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION terminate_operation()`);
      await expect(f.operations.commit(input)).rejects.toThrow();
      await f.context
        .database()
        .run(`DROP TRIGGER terminate_writer ON ${table}`);
      const current = await f.operations.readSnapshot();
      expect(current?.record).toEqual(f.snapshot.record);
      expect(current?.metadata.reviewRevision).toBe(0);
      expect(await f.operations.lookup(input.key)).toEqual({
        status: 'absent',
      });
      expect(
        await f.context
          .database()
          .get(
            'SELECT snapshot_json FROM changes WHERE canvas_id = ?',
            f.canvasId,
          ),
      ).toBeUndefined();
      expect(
        await f.context
          .database()
          .get(
            'SELECT commit_json FROM operation_commits WHERE canvas_id = ?',
            f.canvasId,
          ),
      ).toBeUndefined();
      expect(await f.operations.commit(input)).toEqual(input.receipt);
    },
  );
});
