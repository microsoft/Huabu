// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Agenetes conversation stores against a real SQL profiles.
 *
 * The claim under test is the one a user would notice: a conversation held in
 * a Space that has no directory survives a restart, and goes away with its
 * Space. Everything is driven through the mounted profile rather than a stub,
 * so a broken extension substrate or a missing cascade fails here.
 */

import { mountAgenetes } from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './conversation-stores.js';
import { conversationTables } from './sqlite-stores.js';
import { deleteSpace, space } from '../../storage/index.js';
import {
  mountTestWorkspace,
  PRODUCT_STORAGE_PROFILES,
  type MountedTestStorage,
} from '../../storage/testing.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';
import {
  readSubstrateDocument,
  writeSubstrateDocument,
  appendSubstrateLog,
} from '../substrate-store.js';

import type { StorageProfile } from '../../storage/profile.js';
import type {
  EventLogRecord,
  PersistedTurn,
  ThreadRecord,
} from '@agenetes/agenetes';
import type { AgentStateSnapshot, WorkloadSpec } from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

let profile: StorageProfile;

const CANVAS_ID = 'canvas-conversation';
const THREAD_ID = 'thread-1';

let mounted: MountedTestStorage | null = null;

afterEach(async () => {
  await mounted?.close();
  mounted = null;
});

/** Open the profile and create the Space the conversation belongs to. */
async function openWithSpace(): Promise<MountedTestStorage> {
  const opened = await mountTestWorkspace(profile, 'huabu-agenetes-sql-');
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

async function conversationSubstrate(
  namespace: ReturnType<typeof canvasAcpNamespace>,
) {
  // A store read creates its owner tables before fault injection.
  await conversationThreadStore.list(namespace);
  const value =
    profile.structured.kind === 'sqlite'
      ? conversationTables(namespace)
      : await space(namespace.name).extension('agenetes.conversations');
  if (value?.kind === 'disk')
    throw new Error('Expected SQL conversation tables');
  return value;
}

async function rejectWrite(
  substrate: NonNullable<Awaited<ReturnType<typeof conversationSubstrate>>>,
  name: string,
  table: string,
  operation: string,
  condition: string,
  message: string,
): Promise<() => Promise<void>> {
  if (substrate.kind === 'sqlite') {
    substrate.database
      .exec(`CREATE TRIGGER ${name} BEFORE ${operation} ON agenetes_${table}
      WHEN ${condition} BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
    return async () => {
      substrate.database.exec(`DROP TRIGGER ${name}`);
    };
  }
  if (substrate.kind !== 'postgres')
    throw new Error('Expected a SQL substrate');
  await substrate.database
    .query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN RAISE EXCEPTION '${message}'; END IF;
    RETURN ${operation === 'DELETE' ? 'OLD' : 'NEW'}; END $$;
    CREATE TRIGGER ${name} BEFORE ${operation} ON agenetes_${table}
    FOR EACH ROW EXECUTE FUNCTION ${name}();`);
  return async () => {
    await substrate.database.query(
      `DROP TRIGGER ${name} ON agenetes_${table}; DROP FUNCTION ${name}()`,
    );
  };
}

describe.each(
  PRODUCT_STORAGE_PROFILES.filter((p) => p.structured.kind !== 'disk'),
)('Agenetes conversation stores on %j', (selected) => {
  beforeEach(() => {
    profile = selected;
  });
  for (const kind of ['events', 'turns'] as const) {
    describe(`${kind} replacement`, () => {
      async function setupReplacement() {
        const opened = await openWithSpace();
        const namespace = canvasAcpNamespace(CANVAS_ID);
        const substrate = await conversationSubstrate(namespace);
        if (!substrate) throw new Error('Expected SQLite conversation tables');
        const replace = async (values: readonly number[]) => {
          if (kind === 'events') {
            await conversationEventLogStore.replace(
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
            await conversationTurnStore.replace(
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
        const read = async () =>
          kind === 'events'
            ? await conversationEventLogStore.readRecords(namespace, THREAD_ID)
            : await conversationTurnStore.list(namespace, THREAD_ID);
        await replace([1, 2]);
        return {
          opened,
          namespace,
          substrate,
          replace,
          read,
        };
      }

      it('restores the complete old log when a later replacement insert fails', async () => {
        const { opened, substrate, replace, read } = await setupReplacement();
        const before = await read();
        // Fail the second insert after the delete and first insert have run.
        const sequence = kind === 'events' ? 'seq' : 'seq_start';
        const remove = await rejectWrite(
          substrate,
          'reject_replacement',
          kind,
          'INSERT',
          `NEW.${sequence} = 4`,
          'replacement insert failed',
        );
        await expect(replace([3, 4])).rejects.toThrow(
          'replacement insert failed',
        );
        expect(await read()).toEqual(before);
        await remove();

        await opened.reopen();
        expect(await read()).toEqual(before);
        await replace([3, 4]);
        expect(await read()).toHaveLength(2);
        expect(await read()).not.toEqual(before);
        await replace([]);
        expect(await read()).toEqual([]);
      });

      it('leaves the old log intact when replacement serialization fails', async () => {
        const { namespace, read } = await setupReplacement();
        const before = await read();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        await expect(async () => {
          if (kind === 'events') {
            await conversationEventLogStore.replace(namespace, THREAD_ID, [
              { seq: 3, ts: 1, kind: 'turn_start', request: null },
              { seq: 4, ts: 1, event: cyclic } as unknown as EventLogRecord,
            ]);
          } else {
            await conversationTurnStore.replace(namespace, THREAD_ID, [
              { seqStart: 3, seqEnd: 3, turn: { id: 'turn-3' } as never },
              {
                seqStart: 4,
                seqEnd: 4,
                turn: cyclic,
              } as unknown as PersistedTurn,
            ]);
          }
        }).rejects.toThrow(/circular/i);
        expect(await read()).toEqual(before);
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
      await conversationThreadStore.upsert(source, THREAD_ID, record);
      for (let seq = 1; seq <= 2; seq++) {
        await conversationEventLogStore.appendTurnStart(
          source,
          THREAD_ID,
          null,
        );
        await conversationTurnStore.append(source, THREAD_ID, {
          seqStart: seq,
          seqEnd: seq,
          turn: { request: null, transcript: [] },
        });
      }
      const snapshot = async (
        namespace: typeof source,
        threadId = THREAD_ID,
      ) => ({
        record: await conversationThreadStore.get(namespace, threadId),
        events: await conversationEventLogStore.readRecords(
          namespace,
          threadId,
        ),
        turns: await conversationTurnStore.list(namespace, threadId),
      });
      const before = await snapshot(source);
      await conversationEventLogStore.replace(
        target,
        'unrelated-thread',
        before.events,
      );
      await conversationTurnStore.replace(
        target,
        'unrelated-thread',
        before.turns,
      );
      const unrelated = await snapshot(target, 'unrelated-thread');
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
      const substrate = await conversationSubstrate(
        stage.startsWith('target') ? target : source,
      );
      if (!substrate) throw new Error('Expected SQLite conversation tables');
      // Fail a real SQL write at each stage, including after source deletion
      // has begun. The rehome coordinator and every storage port remain real.
      const remove = await rejectWrite(
        substrate,
        'reject_rehome',
        table,
        operation,
        `${row}.extension_id = ${substrate.extensionId} AND ${row}.thread_id = 'thread-1' ${sequence}`,
        'rehome write failed',
      );
      const targetSpec = { ...record.spec, namespace: target };
      await expect(
        async () =>
          await inst.rehome(
            { namespace: source, threadId: THREAD_ID },
            targetSpec,
          ),
      ).rejects.toThrow('rehome write failed');
      expect(await snapshot(source)).toEqual(before);
      expect(await snapshot(target)).toEqual(empty);
      expect(await snapshot(target, 'unrelated-thread')).toEqual(unrelated);
      await remove();

      await opened.reopen();
      expect(await snapshot(source)).toEqual(before);
      expect(await snapshot(target)).toEqual(empty);
      await inst.rehome({ namespace: source, threadId: THREAD_ID }, targetSpec);
      await opened.reopen();
      expect(await snapshot(source)).toEqual(empty);
      expect(await snapshot(target)).toEqual({
        ...before,
        record: { ...record, spec: targetSpec },
      });
      expect(await snapshot(target, 'unrelated-thread')).toEqual(unrelated);
    },
  );

  it('runs a mounted agent, publishes a durable tail, and recovers folded history after restart', async () => {
    const opened = await openWithSpace();
    const namespace = canvasAcpNamespace(CANVAS_ID);
    const frames = [
      { type: 'text_delta' as const, data: { content: 'persisted answer' } },
      { type: 'end' as const, data: {} },
    ];
    const instance = mountAgenetes({
      drivers: {
        test: defineDriver({
          schemaVersion: 1,
          workloadTypes: ['Deployment'],
          specSchema: z.object({}),
          stateSchema: z.object({}),
          initialState: () => ({}),
          create: () =>
            ({
              async *run() {
                for (const frame of frames) yield frame;
              },
              close() {},
            }) as unknown as AgentHandle,
        }),
      },
      threadStore: conversationThreadStore,
      eventLogStore: conversationEventLogStore,
      turnStore: conversationTurnStore,
    });
    const handle = await instance.create({
      kind: 'test',
      workloadType: 'Deployment',
      threadId: THREAD_ID,
      namespace,
      spec: {},
    });
    const tail = instance.tail(namespace, THREAD_ID)[Symbol.asyncIterator]();
    const first = tail.next();
    const received = [];
    for await (const frame of handle.run(
      { type: 'user_text', content: 'question' } as never,
      {} as never,
    ))
      received.push(frame);
    expect(received).toEqual(frames);
    expect((await first).value).toEqual(frames[0]);
    expect((await tail.next()).value).toEqual(frames[1]);
    await tail.return?.();
    const history = await instance.history(namespace, THREAD_ID);
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]).toMatchObject({
      request: { type: 'user_text', content: 'question' },
    });
    expect(await instance.logMetadata(namespace, THREAD_ID)).toEqual({
      eventCount: 3,
      turnCount: 1,
    });
    await instance.close(THREAD_ID);
    await opened.reopen();
    expect(
      await instance.history(canvasAcpNamespace(CANVAS_ID), THREAD_ID),
    ).toEqual(history);
  });

  it('persists agent-owned documents and concurrent log appends through restart', async () => {
    const opened = await openWithSpace();
    const substrate = await space(CANVAS_ID).extension('test.documents');
    if (!substrate || substrate.kind === 'disk')
      throw new Error('Expected SQL extension');
    await writeSubstrateDocument(substrate, 'state', { cursor: 42 });
    expect(await readSubstrateDocument(substrate, 'state')).toEqual({
      cursor: 42,
    });
    await Promise.all(
      ['a', 'b', 'c'].map((value) =>
        appendSubstrateLog(substrate, 'prompt', '.log', value),
      ),
    );
    const rows =
      substrate.kind === 'postgres'
        ? (
            await substrate.database.query(
              'SELECT body FROM extension_documents WHERE extension_id=$1 AND name=$2',
              [substrate.extensionId, 'prompt.log'],
            )
          ).rows
        : substrate.database
            .prepare(
              'SELECT body FROM extension_documents WHERE extension_id=? AND name=?',
            )
            .all(substrate.extensionId, 'prompt.log');
    expect(String(rows[0]?.body).split('').sort().join('')).toBe('abc');
    await opened.reopen();
    const fresh = await space(CANVAS_ID).extension('test.documents');
    if (!fresh) throw new Error('Missing extension');
    expect(await readSubstrateDocument(fresh, 'state')).toEqual({ cursor: 42 });
  });

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

    await conversationThreadStore.upsert(namespace, THREAD_ID, threadRecord());
    expect(await conversationThreadStore.get(namespace, THREAD_ID)).toEqual(
      threadRecord(),
    );
    expect(await conversationThreadStore.list(namespace)).toHaveLength(1);

    const start = await conversationEventLogStore.appendTurnStart(
      namespace,
      THREAD_ID,
      null,
    );
    expect(start).toMatchObject({ seq: 1, kind: 'turn_start', request: null });
    const appended = await conversationEventLogStore.append(
      namespace,
      THREAD_ID,
      {
        type: 'text',
        text: 'hello',
      } as never,
    );
    expect(appended.seq).toBe(2);
    expect(await conversationEventLogStore.maxSeq(namespace, THREAD_ID)).toBe(
      2,
    );

    // `read` is the streamed frames only; `readRecords` includes the internal
    // turn boundary.
    expect(
      await conversationEventLogStore.read(namespace, THREAD_ID),
    ).toHaveLength(1);
    expect(
      await conversationEventLogStore.readRecords(namespace, THREAD_ID),
    ).toHaveLength(2);
    expect(
      await conversationEventLogStore.read(namespace, THREAD_ID, 2),
    ).toHaveLength(0);

    await conversationTurnStore.append(namespace, THREAD_ID, {
      turn: { id: 'turn-1' } as never,
      seqStart: 1,
      seqEnd: 2,
    });
    expect(await conversationTurnStore.count(namespace, THREAD_ID)).toBe(1);
    expect(await conversationTurnStore.fence(namespace, THREAD_ID)).toBe(2);
    expect(await conversationTurnStore.list(namespace, THREAD_ID)).toEqual([
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

    await conversationThreadStore.upsert(
      canvasAcpNamespace(CANVAS_ID),
      THREAD_ID,
      threadRecord(),
    );

    expect(
      await conversationThreadStore.get(canvasAcpNamespace(other), THREAD_ID),
    ).toBeUndefined();
    expect(
      await conversationThreadStore.list(canvasAcpNamespace(other)),
    ).toEqual([]);
  });

  it('destroys a conversation with the Space that held it', async () => {
    await openWithSpace();
    const namespace = canvasAcpNamespace(CANVAS_ID);
    await conversationThreadStore.upsert(namespace, THREAD_ID, threadRecord());
    await conversationEventLogStore.append(namespace, THREAD_ID, {
      type: 'text',
      text: 'hello',
    } as never);
    await conversationTurnStore.append(namespace, THREAD_ID, {
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
    expect(
      await conversationThreadStore.get(namespace, THREAD_ID),
    ).toBeUndefined();
    expect(await conversationEventLogStore.maxSeq(namespace, THREAD_ID)).toBe(
      0,
    );
    expect(await conversationTurnStore.count(namespace, THREAD_ID)).toBe(0);
  });

  it('survives a restart', async () => {
    const opened = await openWithSpace();
    const namespace = canvasAcpNamespace(CANVAS_ID);
    await conversationThreadStore.upsert(namespace, THREAD_ID, threadRecord());
    await conversationEventLogStore.appendTurnStart(namespace, THREAD_ID, null);
    await conversationEventLogStore.append(namespace, THREAD_ID, {
      type: 'text',
      text: 'hello',
    } as never);
    await conversationTurnStore.append(namespace, THREAD_ID, {
      turn: { id: 'turn-1' } as never,
      seqStart: 1,
      seqEnd: 2,
    });

    await opened.reopen();

    // Same namespace, new connection: this is the whole reason these stores
    // exist rather than the in-memory defaults.
    const after = canvasAcpNamespace(CANVAS_ID);
    expect(await conversationThreadStore.get(after, THREAD_ID)).toEqual(
      threadRecord(),
    );
    expect(await conversationEventLogStore.maxSeq(after, THREAD_ID)).toBe(2);
    expect(
      await conversationEventLogStore.readRecords(after, THREAD_ID),
    ).toHaveLength(2);
    expect(await conversationTurnStore.fence(after, THREAD_ID)).toBe(2);
  });

  it('reports an unnamed namespace as having no durable place', async () => {
    await openWithSpace();
    const anonymous = canvasAcpNamespace('');
    await conversationThreadStore.delete(anonymous, THREAD_ID);

    // Agenetes's own rule: a namespace with no name is non-persistent. It must
    // not fall through to some other Space's tables.
    expect(await conversationThreadStore.list(anonymous)).toEqual([]);
    await conversationThreadStore.upsert(anonymous, THREAD_ID, threadRecord());
    expect(await conversationThreadStore.get(anonymous, THREAD_ID)).toEqual(
      threadRecord(),
    );
    expect(
      await conversationThreadStore.get(
        canvasAcpNamespace(CANVAS_ID),
        THREAD_ID,
      ),
    ).toBeUndefined();
  });
});
