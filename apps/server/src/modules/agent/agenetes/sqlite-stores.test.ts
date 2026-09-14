// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Agenetes conversation stores against a real SQLite profile.
 *
 * The claim under test is the one a user would notice: a conversation held in
 * a Space that has no directory survives a restart, and goes away with its
 * Space. Everything is driven through the mounted profile rather than a stub,
 * so a broken extension substrate or a missing cascade fails here.
 */

import { mountAgenetes } from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './conversation-stores.js';
import { conversationTables } from './sqlite-stores.js';
import { deleteSpace } from '../../storage/index.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from '../../storage/testing.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';

import type { StorageProfile } from '../../storage/profile.js';
import type {
  EventLogRecord,
  PersistedTurn,
  ThreadRecord,
} from '@agenetes/agenetes';
import type { AgentStateSnapshot, WorkloadSpec } from '@agenetes/protocol';

const SQLITE: StorageProfile = {
  structured: { kind: 'sqlite' },
  blobs: { kind: 'disk' },
};

const CANVAS_ID = 'canvas-conversation';
const THREAD_ID = 'thread-1';

let mounted: MountedTestStorage | null = null;

afterEach(async () => {
  await mounted?.close();
  mounted = null;
});

/** Open the profile and create the Space the conversation belongs to. */
async function openWithSpace(): Promise<MountedTestStorage> {
  const opened = await mountTestWorkspace(SQLITE, 'huabu-agenetes-sqlite-');
  mounted = opened;
  const created = await opened.storage.structured
    .spaces()
    .create({ canvasId: CANVAS_ID, title: 'Conversation Space' });
  if (!created.ok) throw new Error('Expected to create the Space');
  return opened;
}

function threadRecord(threadId = THREAD_ID): ThreadRecord {
  return {
    driverSchemaVersion: 1,
    spec: {
      kind: 'internal',
      threadId,
      namespace: { name: CANVAS_ID },
    } as unknown as WorkloadSpec,
    state: { status: 'idle' } as unknown as AgentStateSnapshot,
  };
}

describe('Agenetes conversation stores on SQLite', () => {
  for (const kind of ['events', 'turns'] as const) {
    describe(`${kind} replacement`, () => {
      async function setupReplacement() {
        const opened = await openWithSpace();
        const namespace = canvasAcpNamespace(CANVAS_ID);
        const substrate = conversationTables(namespace);
        if (!substrate) throw new Error('Expected SQLite conversation tables');
        const replace = (values: readonly number[]) => {
          if (kind === 'events') {
            conversationEventLogStore.replace(
              namespace,
              THREAD_ID,
              values.map((seq) => ({
                seq,
                ts: 1,
                kind: 'turn_start',
                request: null,
              })),
            );
          } else {
            conversationTurnStore.replace(
              namespace,
              THREAD_ID,
              values.map((seq) => ({
                seqStart: seq,
                seqEnd: seq,
                turn: { id: `turn-${seq}` } as never,
              })),
            );
          }
        };
        const read = () =>
          kind === 'events'
            ? conversationEventLogStore.readRecords(namespace, THREAD_ID)
            : conversationTurnStore.list(namespace, THREAD_ID);
        replace([1, 2]);
        return {
          opened,
          namespace,
          database: substrate.database,
          replace,
          read,
        };
      }

      it('restores the complete old log when a later replacement insert fails', async () => {
        const { opened, database, replace, read } = await setupReplacement();
        const before = read();
        // Fail the second insert after the delete and first insert have run.
        const sequence = kind === 'events' ? 'seq' : 'seq_start';
        database.exec(`
          CREATE TRIGGER reject_replacement BEFORE INSERT ON agenetes_${kind}
          WHEN NEW.${sequence} = 4
          BEGIN SELECT RAISE(ABORT, 'replacement insert failed'); END;
        `);
        expect(() => replace([3, 4])).toThrow('replacement insert failed');
        expect(read()).toEqual(before);
        expect(database.isTransaction).toBe(false);

        database.exec('DROP TRIGGER reject_replacement');
        await opened.reopen();
        expect(read()).toEqual(before);
        replace([3, 4]);
        expect(read()).toHaveLength(2);
        expect(read()).not.toEqual(before);
        replace([]);
        expect(read()).toEqual([]);
      });

      it('leaves the old log intact when replacement serialization fails', async () => {
        const { namespace, read } = await setupReplacement();
        const before = read();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => {
          if (kind === 'events') {
            conversationEventLogStore.replace(namespace, THREAD_ID, [
              { seq: 3, ts: 1, kind: 'turn_start', request: null },
              { seq: 4, ts: 1, event: cyclic } as unknown as EventLogRecord,
            ]);
          } else {
            conversationTurnStore.replace(namespace, THREAD_ID, [
              { seqStart: 3, seqEnd: 3, turn: { id: 'turn-3' } as never },
              {
                seqStart: 4,
                seqEnd: 4,
                turn: cyclic,
              } as unknown as PersistedTurn,
            ]);
          }
        }).toThrow(/circular/i);
        expect(read()).toEqual(before);
      });
    });
  }

  it.each([
    {
      stage: 'target events',
      table: 'events',
      operation: 'INSERT',
      row: 'NEW',
      sequence: 'AND NEW.seq = 2',
    },
    {
      stage: 'target turns',
      table: 'turns',
      operation: 'INSERT',
      row: 'NEW',
      sequence: 'AND NEW.ordinal = 2',
    },
    {
      stage: 'target record',
      table: 'threads',
      operation: 'INSERT',
      row: 'NEW',
      sequence: '',
    },
    {
      stage: 'source record',
      table: 'threads',
      operation: 'DELETE',
      row: 'OLD',
      sequence: '',
    },
    {
      stage: 'source events',
      table: 'events',
      operation: 'DELETE',
      row: 'OLD',
      sequence: 'AND OLD.seq = 2',
    },
    {
      stage: 'source turns',
      table: 'turns',
      operation: 'DELETE',
      row: 'OLD',
      sequence: 'AND OLD.ordinal = 2',
    },
  ])(
    'restores a conversation after rehome fails at $stage, then permits retry',
    async ({ stage, table, operation, row, sequence }) => {
      const opened = await openWithSpace();
      const targetId = 'canvas-target';
      expect(
        (
          await opened.storage.structured
            .spaces()
            .create({ canvasId: targetId, title: 'Target' })
        ).ok,
      ).toBe(true);
      const source = canvasAcpNamespace(CANVAS_ID);
      const target = canvasAcpNamespace(targetId);
      const record: ThreadRecord = {
        driverSchemaVersion: 1,
        spec: {
          kind: 'test',
          workloadType: 'Deployment',
          threadId: THREAD_ID,
          namespace: source,
          spec: {},
        },
        state: { driverState: {} },
      };
      conversationThreadStore.upsert(source, THREAD_ID, record);
      for (let seq = 1; seq <= 2; seq++) {
        conversationEventLogStore.appendTurnStart(source, THREAD_ID, null);
        conversationTurnStore.append(source, THREAD_ID, {
          seqStart: seq,
          seqEnd: seq,
          turn: { request: null, transcript: [] },
        });
      }
      const snapshot = (namespace: typeof source, threadId = THREAD_ID) => ({
        record: conversationThreadStore.get(namespace, threadId),
        events: conversationEventLogStore.readRecords(namespace, threadId),
        turns: conversationTurnStore.list(namespace, threadId),
      });
      const before = snapshot(source);
      conversationEventLogStore.replace(
        target,
        'unrelated-thread',
        before.events,
      );
      conversationTurnStore.replace(target, 'unrelated-thread', before.turns);
      const unrelated = snapshot(target, 'unrelated-thread');
      const empty = { record: undefined, events: [], turns: [] };
      const inst = mountAgenetes({
        drivers: {
          test: defineDriver({
            schemaVersion: 1,
            workloadTypes: ['Deployment'],
            specSchema: z.object({}),
            stateSchema: z.object({}),
            initialState: () => ({}),
            create: () => {
              throw new Error('Rehome must not spawn a driver');
            },
          }),
        },
        threadStore: conversationThreadStore,
        eventLogStore: conversationEventLogStore,
        turnStore: conversationTurnStore,
      });
      const substrate = conversationTables(
        stage.startsWith('target') ? target : source,
      );
      if (!substrate) throw new Error('Expected SQLite conversation tables');
      // Fail a real SQLite write at each stage, including after source deletion
      // has begun. The rehome coordinator and every storage port remain real.
      substrate.database.exec(`
      CREATE TRIGGER reject_rehome BEFORE ${operation} ON agenetes_${table}
      WHEN ${row}.extension_id = ${substrate.extensionId}
        AND ${row}.thread_id = 'thread-1' ${sequence}
      BEGIN SELECT RAISE(ABORT, 'rehome write failed'); END;
    `);
      const targetSpec = { ...record.spec, namespace: target };
      expect(() =>
        inst.rehome({ namespace: source, threadId: THREAD_ID }, targetSpec),
      ).toThrow('rehome write failed');
      expect(snapshot(source)).toEqual(before);
      expect(snapshot(target)).toEqual(empty);
      expect(snapshot(target, 'unrelated-thread')).toEqual(unrelated);
      expect(substrate.database.isTransaction).toBe(false);
      substrate.database.exec('DROP TRIGGER reject_rehome');

      await opened.reopen();
      expect(snapshot(source)).toEqual(before);
      expect(snapshot(target)).toEqual(empty);
      inst.rehome({ namespace: source, threadId: THREAD_ID }, targetSpec);
      await opened.reopen();
      expect(snapshot(source)).toEqual(empty);
      expect(snapshot(target)).toEqual({
        ...before,
        record: { ...record, spec: targetSpec },
      });
      expect(snapshot(target, 'unrelated-thread')).toEqual(unrelated);
    },
  );

  it('keeps a Space with no directory out of the file stores', async () => {
    await openWithSpace();
    const namespace = canvasAcpNamespace(CANVAS_ID);

    // The absence of `storage.root` is the whole signal: it is what tells the
    // dispatcher this Space is not a folder.
    expect(namespace.storage).toBeUndefined();
    expect(namespace.name).toBe(CANVAS_ID);
  });

  it('round-trips threads, events, and folded turns', async () => {
    await openWithSpace();
    const namespace = canvasAcpNamespace(CANVAS_ID);

    conversationThreadStore.upsert(namespace, THREAD_ID, threadRecord());
    expect(conversationThreadStore.get(namespace, THREAD_ID)).toEqual(
      threadRecord(),
    );
    expect(conversationThreadStore.list(namespace)).toHaveLength(1);

    const start = conversationEventLogStore.appendTurnStart(
      namespace,
      THREAD_ID,
      null,
    );
    expect(start).toMatchObject({ seq: 1, kind: 'turn_start', request: null });
    const appended = conversationEventLogStore.append(namespace, THREAD_ID, {
      type: 'text',
      text: 'hello',
    } as never);
    expect(appended.seq).toBe(2);
    expect(conversationEventLogStore.maxSeq(namespace, THREAD_ID)).toBe(2);

    // `read` is the streamed frames only; `readRecords` includes the internal
    // turn boundary.
    expect(conversationEventLogStore.read(namespace, THREAD_ID)).toHaveLength(
      1,
    );
    expect(
      conversationEventLogStore.readRecords(namespace, THREAD_ID),
    ).toHaveLength(2);
    expect(
      conversationEventLogStore.read(namespace, THREAD_ID, 2),
    ).toHaveLength(0);

    conversationTurnStore.append(namespace, THREAD_ID, {
      turn: { id: 'turn-1' } as never,
      seqStart: 1,
      seqEnd: 2,
    });
    expect(conversationTurnStore.count(namespace, THREAD_ID)).toBe(1);
    expect(conversationTurnStore.fence(namespace, THREAD_ID)).toBe(2);
    expect(conversationTurnStore.list(namespace, THREAD_ID)).toEqual([
      { turn: { id: 'turn-1' }, seqStart: 1, seqEnd: 2 },
    ]);
  });

  it('isolates one Space from another', async () => {
    const opened = await openWithSpace();
    const other = 'canvas-conversation-other';
    const created = await opened.storage.structured
      .spaces()
      .create({ canvasId: other, title: 'Other Space' });
    if (!created.ok) throw new Error('Expected to create the second Space');

    conversationThreadStore.upsert(
      canvasAcpNamespace(CANVAS_ID),
      THREAD_ID,
      threadRecord(),
    );

    expect(
      conversationThreadStore.get(canvasAcpNamespace(other), THREAD_ID),
    ).toBeUndefined();
    expect(conversationThreadStore.list(canvasAcpNamespace(other))).toEqual([]);
  });

  it('destroys a conversation with the Space that held it', async () => {
    await openWithSpace();
    const namespace = canvasAcpNamespace(CANVAS_ID);
    conversationThreadStore.upsert(namespace, THREAD_ID, threadRecord());
    conversationEventLogStore.append(namespace, THREAD_ID, {
      type: 'text',
      text: 'hello',
    } as never);
    conversationTurnStore.append(namespace, THREAD_ID, {
      turn: { id: 'turn-1' } as never,
      seqStart: 1,
      seqEnd: 1,
    });

    await expect(deleteSpace(CANVAS_ID)).resolves.toEqual({
      ok: true,
      reason: 'deleted',
    });

    // The Space is gone, so there is no substrate to answer from — which is
    // the port's rule, and is also what the foreign-key cascade leaves behind.
    expect(conversationThreadStore.get(namespace, THREAD_ID)).toBeUndefined();
    expect(conversationEventLogStore.maxSeq(namespace, THREAD_ID)).toBe(0);
    expect(conversationTurnStore.count(namespace, THREAD_ID)).toBe(0);
  });

  it('survives a restart', async () => {
    const opened = await openWithSpace();
    const namespace = canvasAcpNamespace(CANVAS_ID);
    conversationThreadStore.upsert(namespace, THREAD_ID, threadRecord());
    conversationEventLogStore.appendTurnStart(namespace, THREAD_ID, null);
    conversationEventLogStore.append(namespace, THREAD_ID, {
      type: 'text',
      text: 'hello',
    } as never);
    conversationTurnStore.append(namespace, THREAD_ID, {
      turn: { id: 'turn-1' } as never,
      seqStart: 1,
      seqEnd: 2,
    });

    await opened.reopen();

    // Same namespace, new connection: this is the whole reason these stores
    // exist rather than the in-memory defaults.
    const after = canvasAcpNamespace(CANVAS_ID);
    expect(conversationThreadStore.get(after, THREAD_ID)).toEqual(
      threadRecord(),
    );
    expect(conversationEventLogStore.maxSeq(after, THREAD_ID)).toBe(2);
    expect(
      conversationEventLogStore.readRecords(after, THREAD_ID),
    ).toHaveLength(2);
    expect(conversationTurnStore.fence(after, THREAD_ID)).toBe(2);
  });

  it('reports an unnamed namespace as having no durable place', async () => {
    await openWithSpace();
    const anonymous = canvasAcpNamespace('');

    // Agenetes's own rule: a namespace with no name is non-persistent. It must
    // not fall through to some other Space's tables.
    expect(conversationThreadStore.list(anonymous)).toEqual([]);
    conversationThreadStore.upsert(anonymous, THREAD_ID, threadRecord());
    expect(conversationThreadStore.get(anonymous, THREAD_ID)).toEqual(
      threadRecord(),
    );
    expect(
      conversationThreadStore.get(canvasAcpNamespace(CANVAS_ID), THREAD_ID),
    ).toBeUndefined();
  });
});
