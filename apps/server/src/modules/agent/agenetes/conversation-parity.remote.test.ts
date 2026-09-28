// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The two SQL conversation adapters, asked the same questions.
 *
 * `sqlite-stores.ts` and `postgres-stores.ts` are two hand-written answers to
 * one port, in two dialects, and nothing in the type system stops them from
 * drifting: a cursor is opaque, a page boundary is arithmetic, and a
 * generation counter is an implementation detail on both sides. So this file
 * runs one script of store operations against every SQL profile the harness
 * provisions and compares the whole observable trace, cursors included.
 *
 * The trace is also asserted against fixed expectations, so the comparison
 * cannot pass by having both adapters agree on the wrong answer. Only the
 * event timestamps are dropped — they are wall-clock, and the only thing in
 * the trace that is allowed to differ between two runs.
 */

import { describe, expect, it } from 'vitest';

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './conversation-stores.js';
import {
  describeProfile,
  mountTestWorkspace,
  PRODUCT_STORAGE_PROFILES,
} from '../../storage/testing.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';

import type { StorageProfile } from '../../storage/profile.js';
import type { ThreadRecord } from '@agenetes/agenetes';

const SQL_PROFILES = PRODUCT_STORAGE_PROFILES.filter(
  (profile) => profile.structured.kind !== 'disk',
);

const CANVAS_ID = 'canvas-parity';
const THREAD_ID = 'thread-1';

/** The folded conversation the script builds, in fold order. */
const TURNS = [
  { request: null, content: 'orphan' },
  { request: 'a', content: 'a' },
  { request: 'b', content: 'b' },
  { request: null, content: 'resume-b' },
  { request: 'c', content: 'c' },
  { request: 'd', content: 'd' },
  { request: null, content: 'resume-d' },
] as const;

function threadRecord(marker: string): ThreadRecord {
  return {
    driverSchemaVersion: 1,
    spec: {
      kind: 'test',
      workloadType: 'Deployment',
      threadId: THREAD_ID,
      namespace: { name: CANVAS_ID },
      spec: {},
    },
    state: { driverState: { marker } },
  } as unknown as ThreadRecord;
}

/** Wall-clock stamps are the one part of a record two runs may disagree on. */
function withoutTimestamps(records: readonly { ts: number }[]): unknown[] {
  return records.map(({ ts: _ts, ...rest }) => rest);
}

/** What an adapter said when it refused, rather than that it refused. */
async function refusal(
  operation: () => unknown,
): Promise<{ name: string; message: string }> {
  try {
    await operation();
  } catch (error) {
    const thrown = error as Error;
    return { name: thrown.name, message: thrown.message };
  }
  throw new Error('Expected the store to refuse');
}

/** The transcript content of every turn in a page, grouped as it was paged. */
function pageContent(groups: { turns: { turn: unknown }[] }[]): string[][] {
  return groups.map((group) =>
    group.turns.map(
      (record) =>
        (
          record.turn as {
            transcript: { data: { content: string } }[];
          }
        ).transcript[0]!.data.content,
    ),
  );
}

/** Run the whole script against one profile and record what it answered. */
async function observe(profile: StorageProfile) {
  const opened = await mountTestWorkspace(profile, 'huabu-agenetes-parity-');
  try {
    const created = await opened.storage.structured
      .spaces()
      .create({ canvasId: CANVAS_ID, title: 'Parity' });
    if (!created.ok) throw new Error('Expected to create the Space');
    const ns = canvasAcpNamespace(CANVAS_ID);

    const empty = {
      record: await conversationThreadStore.get(ns, THREAD_ID),
      list: await conversationThreadStore.list(ns),
      maxSeq: await conversationEventLogStore.maxSeq(ns, THREAD_ID),
      events: await conversationEventLogStore.readRecords(ns, THREAD_ID),
      turns: await conversationTurnStore.list(ns, THREAD_ID),
      count: await conversationTurnStore.count(ns, THREAD_ID),
      fence: await conversationTurnStore.fence(ns, THREAD_ID),
      page: await conversationTurnStore.page(ns, THREAD_ID, { limit: 2 }),
    };

    await conversationThreadStore.upsert(
      ns,
      THREAD_ID,
      threadRecord('written'),
    );
    await conversationEventLogStore.appendTurnStart(ns, THREAD_ID, {
      type: 'user_text',
      content: 'a',
    } as never);
    for (const value of ['one', 'two', 'three'])
      await conversationEventLogStore.append(ns, THREAD_ID, {
        type: 'text',
        data: { content: value },
      } as never);
    for (const [index, value] of TURNS.entries())
      await conversationTurnStore.append(ns, THREAD_ID, {
        turn: {
          request:
            value.request === null
              ? null
              : { type: 'user_text', content: value.request },
          transcript: [{ type: 'text', data: { content: value.content } }],
        },
        seqStart: index + 1,
        seqEnd: index + 1,
      } as never);

    // The same reads again on a fresh connection: everything below this line
    // is what a restarted server would see.
    await opened.reopen();

    const written = {
      record: await conversationThreadStore.get(ns, THREAD_ID),
      list: await conversationThreadStore.list(ns),
      maxSeq: await conversationEventLogStore.maxSeq(ns, THREAD_ID),
      records: withoutTimestamps(
        (await conversationEventLogStore.readRecords(
          ns,
          THREAD_ID,
        )) as readonly { ts: number }[],
      ),
      streamed: withoutTimestamps(
        (await conversationEventLogStore.read(ns, THREAD_ID)) as readonly {
          ts: number;
        }[],
      ),
      sinceSeq: withoutTimestamps(
        (await conversationEventLogStore.read(ns, THREAD_ID, 2)) as readonly {
          ts: number;
        }[],
      ),
      count: await conversationTurnStore.count(ns, THREAD_ID),
      fence: await conversationTurnStore.fence(ns, THREAD_ID),
      order: (await conversationTurnStore.list(ns, THREAD_ID)).map(
        (record) => record.seqStart,
      ),
    };

    // Page backwards to the beginning, keeping every boundary the adapter
    // issued along the way.
    const pages = [];
    let before: string | undefined;
    do {
      const page = await conversationTurnStore.page(ns, THREAD_ID, {
        limit: 2,
        ...(before ? { before } : {}),
      });
      pages.push({
        content: pageContent(page.groups),
        ids: page.groups.map((group) => group.id),
        next: page.next,
        before: page.before,
        hasMore: page.hasMore,
      });
      before = page.before;
    } while (before);

    const limits = [];
    for (const limit of [0, -1, 1.5, Number.NaN])
      limits.push(
        await refusal(() =>
          conversationTurnStore.page(ns, THREAD_ID, { limit }),
        ),
      );
    const malformed = await refusal(() =>
      conversationTurnStore.page(ns, THREAD_ID, {
        limit: 2,
        before: 'not-a-cursor',
      }),
    );

    // A cursor is only meaningful against the arrangement it was issued for.
    const cursor = (
      await conversationTurnStore.page(ns, THREAD_ID, { limit: 2 })
    ).before!;
    await conversationTurnStore.replace(
      ns,
      THREAD_ID,
      await conversationTurnStore.list(ns, THREAD_ID),
    );
    const afterReplace = {
      stale: await refusal(() =>
        conversationTurnStore.page(ns, THREAD_ID, { limit: 2, before: cursor }),
      ),
      page: (
        await conversationTurnStore.page(ns, THREAD_ID, { limit: 2 })
      ).groups.map((group) => group.id),
      order: (await conversationTurnStore.list(ns, THREAD_ID)).map(
        (record) => record.seqStart,
      ),
      fence: await conversationTurnStore.fence(ns, THREAD_ID),
    };

    const reissued = (
      await conversationTurnStore.page(ns, THREAD_ID, { limit: 2 })
    ).before!;
    await conversationTurnStore.delete(ns, THREAD_ID);
    const afterDelete = {
      stale: await refusal(() =>
        conversationTurnStore.page(ns, THREAD_ID, {
          limit: 2,
          before: reissued,
        }),
      ),
      count: await conversationTurnStore.count(ns, THREAD_ID),
      fence: await conversationTurnStore.fence(ns, THREAD_ID),
      list: await conversationTurnStore.list(ns, THREAD_ID),
    };

    await conversationEventLogStore.replace(ns, THREAD_ID, [
      { seq: 1, ts: 1, kind: 'turn_start', request: null },
      { seq: 2, ts: 1, event: { type: 'text' } } as never,
    ]);
    const afterEventReplace = {
      records: await conversationEventLogStore.readRecords(ns, THREAD_ID),
      maxSeq: await conversationEventLogStore.maxSeq(ns, THREAD_ID),
    };

    await conversationThreadStore.delete(ns, THREAD_ID);
    const afterThreadDelete = {
      record: await conversationThreadStore.get(ns, THREAD_ID),
      list: await conversationThreadStore.list(ns),
    };

    return {
      empty,
      written,
      pages,
      limits,
      malformed,
      afterReplace,
      afterDelete,
      afterEventReplace,
      afterThreadDelete,
    };
  } finally {
    await opened.close();
  }
}

type Observation = Awaited<ReturnType<typeof observe>>;

const observations = new Map<string, Observation>();

describe.each(SQL_PROFILES)('Agenetes conversation stores on %j', (profile) => {
  it('answers the scripted conversation the way the port describes', async () => {
    const observed = await observe(profile);

    // An empty thread has no fence to hand the next tail, and a page of
    // nothing still carries the position the next append would take.
    expect(observed.empty).toMatchObject({
      record: undefined,
      list: [],
      maxSeq: 0,
      events: [],
      turns: [],
      count: 0,
      fence: 0,
    });
    expect(observed.empty.page).toMatchObject({
      groups: [],
      hasMore: false,
    });

    // `read` is the streamed frames; `readRecords` also carries the turn
    // boundary Agenetes writes itself.
    expect(observed.written).toMatchObject({
      maxSeq: 4,
      count: TURNS.length,
      // The fence is the `seqEnd` of the last folded turn, which is what
      // the next tail reads from.
      fence: TURNS.length,
      order: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(observed.written.records).toHaveLength(4);
    expect(observed.written.streamed).toHaveLength(3);
    expect(observed.written.sinceSeq).toHaveLength(2);
    expect(
      (observed.written.record as ThreadRecord | undefined)?.state,
    ).toEqual({ driverState: { marker: 'written' } });

    // Backwards paging never splits a request-less continuation away from
    // the turn it continues.
    expect(observed.pages.map((page) => page.content)).toEqual([
      [['c'], ['d', 'resume-d']],
      [['a'], ['b', 'resume-b']],
      [['orphan']],
    ]);
    expect(observed.pages.map((page) => page.hasMore)).toEqual([
      true,
      true,
      false,
    ]);
    expect(observed.pages.at(-1)?.before).toBeUndefined();

    const badLimit = {
      name: 'RangeError',
      message: 'History page limit must be a positive integer',
    };
    expect(observed.limits).toEqual([badLimit, badLimit, badLimit, badLimit]);
    expect(observed.malformed).toEqual({
      name: 'MalformedTurnCursorError',
      message: 'Malformed history cursor',
    });

    // A wholesale replacement reinstates the same turns and refuses the
    // cursors of the arrangement it replaced.
    const stale = {
      name: 'StaleTurnCursorError',
      message: 'History cursor is stale',
    };
    expect(observed.afterReplace).toMatchObject({
      stale,
      order: [1, 2, 3, 4, 5, 6, 7],
      fence: TURNS.length,
    });
    expect(observed.afterDelete).toEqual({
      stale,
      count: 0,
      fence: 0,
      list: [],
    });

    expect(observed.afterEventReplace.maxSeq).toBe(2);
    expect(observed.afterEventReplace.records).toHaveLength(2);
    expect(observed.afterThreadDelete).toEqual({
      record: undefined,
      list: [],
    });

    observations.set(describeProfile(profile), observed);
  });
});

it('gives every SQL profile the same observable conversation', () => {
  // Parity is only a claim when there is more than one adapter to compare;
  // the remote configuration provisions PostgreSQL for exactly that reason.
  expect(SQL_PROFILES.length).toBeGreaterThan(1);
  const recorded = [...observations.entries()];
  expect(recorded.map(([label]) => label)).toEqual(
    SQL_PROFILES.map(describeProfile),
  );

  const [baselineLabel, baseline] = recorded[0]!;
  for (const [label, observed] of recorded.slice(1)) {
    // Cursors are opaque, not private: two adapters that page the same
    // conversation differently would show up right here.
    expect({ [label]: observed }).toEqual({ [label]: baseline });
    expect(label).not.toBe(baselineLabel);
  }
});
