// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which backing a namespace routes to, and when the question gets asked.
 *
 * `sqlite-stores.test.ts` proves what each SQL backing does once it has been
 * chosen. This file covers the choosing: a Space with a directory stays on
 * files whatever the structured backend is, a namespace with no name gets the
 * one process-wide in-memory conversation, everything else answers from the
 * structured store in force, and a named Space with neither a directory nor a
 * SQL backend is refused in a sentence rather than half-written somewhere.
 *
 * The routing is asked again on every call on purpose — the active Workspace
 * and profile can change under a running process — so the last case here
 * changes the profile between two calls on one namespace and expects the
 * answer to change with it.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './conversation-stores.js';
import { conversationTables } from './sqlite-stores.js';
import { DiskStructuredStore } from '../../storage/backends/disk/structured-store.js';
import {
  composeStorage,
  getStorage,
  setStorageForTesting,
  withSpaceDirHandlesReleased,
} from '../../storage/index.js';
import { mountTestWorkspace } from '../../storage/testing.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';

import type { MountedTestStorage } from '../../storage/testing.js';
import type { ThreadRecord } from '@agenetes/agenetes';
import type { Namespace } from '@agenetes/protocol';

const SQLITE_PROFILE = {
  structured: { kind: 'sqlite' as const },
  blobs: { kind: 'disk' as const },
};
const DISK_PROFILE = {
  structured: { kind: 'disk' as const },
  blobs: { kind: 'disk' as const },
};

const CANVAS_ID = 'canvas-routing';

let mounted: MountedTestStorage | null = null;
const disposals: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  await mounted?.close();
  mounted = null;
});

async function mount(
  profile: typeof SQLITE_PROFILE | typeof DISK_PROFILE,
): Promise<MountedTestStorage> {
  const opened = await mountTestWorkspace(profile, 'huabu-agenetes-routing-');
  mounted = opened;
  return opened;
}

function threadRecord(marker: string): ThreadRecord {
  return {
    driverSchemaVersion: 1,
    spec: {
      kind: 'test',
      workloadType: 'Deployment',
      threadId: 'thread-1',
      namespace: { name: CANVAS_ID },
      spec: {},
    },
    state: { driverState: { marker } },
  } as unknown as ThreadRecord;
}

/** Write one conversation through all three ports and read it back. */
async function roundTrip(namespace: Namespace, marker: string) {
  await conversationThreadStore.upsert(
    namespace,
    'thread-1',
    threadRecord(marker),
  );
  await conversationEventLogStore.appendTurnStart(namespace, 'thread-1', null);
  await conversationEventLogStore.append(namespace, 'thread-1', {
    type: 'text',
    text: marker,
  } as never);
  await conversationTurnStore.append(namespace, 'thread-1', {
    turn: { request: null, transcript: [] } as never,
    seqStart: 1,
    seqEnd: 2,
  });
  const stored = await conversationThreadStore.get(namespace, 'thread-1');
  return {
    // The file store re-resolves `spec.namespace` against the namespace it
    // was read with, so the identifying parts are what every backing agrees
    // on.
    threadId: stored?.spec.threadId,
    state: stored?.state,
    maxSeq: await conversationEventLogStore.maxSeq(namespace, 'thread-1'),
    turns: await conversationTurnStore.count(namespace, 'thread-1'),
  };
}

/** What {@link roundTrip} must answer on any backing. */
function persisted(marker: string) {
  return {
    threadId: 'thread-1',
    state: { driverState: { marker } },
    maxSeq: 2,
    turns: 1,
  };
}

/** How many conversation rows the SQLite backing holds for a Space. */
function sqliteThreadRows(namespace: Namespace): number {
  const substrate = conversationTables({ name: namespace.name });
  if (!substrate) throw new Error('Expected SQLite conversation tables');
  return Number(
    substrate.database
      .prepare(
        'SELECT COUNT(*) AS rows FROM agenetes_threads WHERE extension_id = ?',
      )
      .get(substrate.extensionId)?.['rows'],
  );
}

it('keeps a Space that has a directory on the file stores, whatever the structured backend is', async () => {
  const opened = await mount(SQLITE_PROFILE);
  expect(
    (
      await opened.storage.structured
        .spaces()
        .create({ canvasId: CANVAS_ID, title: 'Routing' })
    ).ok,
  ).toBe(true);
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-agenetes-history-'));
  const namespace: Namespace = { name: CANVAS_ID, storage: { root } };
  disposals.push(async () => {
    // The file turn store holds an open database under `root`; the handle
    // arbitration point is how a Space's owners are asked to let go.
    await withSpaceDirHandlesReleased(CANVAS_ID, () => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  expect(await roundTrip(namespace, 'files')).toEqual(persisted('files'));
  // A directory answers the question outright: the Space also has a SQLite
  // substrate here, and nothing was written to it.
  expect(readdirSync(root).length).toBeGreaterThan(0);
  expect(sqliteThreadRows(namespace)).toBe(0);
});

it('gives an unnamed namespace one in-memory conversation for the life of the process', async () => {
  const opened = await mount(SQLITE_PROFILE);
  const anonymous = canvasAcpNamespace('');
  expect(anonymous.name).toBe('');

  expect(await roundTrip(anonymous, 'memory')).toEqual(persisted('memory'));

  // Three ports, one conversation: a fresh backing per port or per call would
  // have restarted the sequence and lost the record the previous line read.
  await conversationEventLogStore.append(anonymous, 'thread-1', {
    type: 'text',
    text: 'again',
  } as never);
  expect(await conversationEventLogStore.maxSeq(anonymous, 'thread-1')).toBe(3);

  // It is not a backend choice, so changing the backend leaves it alone.
  disposals.push(
    setStorageForTesting(
      composeStorage(
        DISK_PROFILE,
        new DiskStructuredStore(),
        opened.storage.blobs,
      ),
    ),
  );
  expect(
    (await conversationThreadStore.get(anonymous, 'thread-1'))?.state,
  ).toEqual({ driverState: { marker: 'memory' } });
  expect(await conversationTurnStore.count(anonymous, 'thread-1')).toBe(1);
});

it('keeps an unnamed conversation out of a named Space', async () => {
  const opened = await mount(SQLITE_PROFILE);
  expect(
    (
      await opened.storage.structured
        .spaces()
        .create({ canvasId: CANVAS_ID, title: 'Routing' })
    ).ok,
  ).toBe(true);
  const named = canvasAcpNamespace(CANVAS_ID);
  await roundTrip(canvasAcpNamespace(''), 'anonymous');

  expect(await conversationThreadStore.get(named, 'thread-1')).toBeUndefined();
  expect(await conversationThreadStore.list(named)).toEqual([]);
  expect(sqliteThreadRows(named)).toBe(0);
});

it('routes a named Space with no directory to the structured backend it was selected with', async () => {
  const opened = await mount(SQLITE_PROFILE);
  expect(
    (
      await opened.storage.structured
        .spaces()
        .create({ canvasId: CANVAS_ID, title: 'Routing' })
    ).ok,
  ).toBe(true);
  const namespace = canvasAcpNamespace(CANVAS_ID);
  expect(namespace.storage).toBeUndefined();

  expect(await roundTrip(namespace, 'rows')).toEqual(persisted('rows'));
  expect(sqliteThreadRows(namespace)).toBe(1);
});

it('refuses a named Disk conversation that has no directory', async () => {
  await mount(DISK_PROFILE);
  // Disk mints its own namespaces with a root, so this shape arrives from
  // elsewhere: a namespace minted while the profile kept Spaces in rows and
  // carried in a persisted thread spec. Guessing a backing for it would
  // scatter a conversation into a directory no Space owns.
  const namespace: Namespace = { name: CANVAS_ID };
  expect(canvasAcpNamespace(CANVAS_ID).storage?.root).toEqual(
    expect.stringContaining(CANVAS_ID),
  );

  const refusal = 'A named Disk conversation requires a storage root';
  // The dispatcher refuses before it has a backing to call, so the throw is
  // synchronous and the call belongs inside the thunk.
  await expect(async () =>
    conversationThreadStore.get(namespace, 'thread-1'),
  ).rejects.toThrow(refusal);
  await expect(async () =>
    conversationThreadStore.upsert(namespace, 'thread-1', threadRecord('disk')),
  ).rejects.toThrow(refusal);
  await expect(async () =>
    conversationEventLogStore.maxSeq(namespace, 'thread-1'),
  ).rejects.toThrow(refusal);
  await expect(async () =>
    conversationTurnStore.page(namespace, 'thread-1', { limit: 1 }),
  ).rejects.toThrow(refusal);
});

it('asks again on every call, so a profile change takes effect between two reads', async () => {
  const opened = await mount(SQLITE_PROFILE);
  expect(
    (
      await opened.storage.structured
        .spaces()
        .create({ canvasId: CANVAS_ID, title: 'Routing' })
    ).ok,
  ).toBe(true);
  const namespace = canvasAcpNamespace(CANVAS_ID);
  await conversationThreadStore.upsert(
    namespace,
    'thread-1',
    threadRecord('rows'),
  );

  const sqliteStorage = getStorage();
  const restore = setStorageForTesting(
    composeStorage(
      DISK_PROFILE,
      new DiskStructuredStore(),
      sqliteStorage.blobs,
    ),
  );
  // Same namespace object, same process, one call later: the answer follows
  // the profile rather than a decision cached at mount.
  await expect(async () =>
    conversationThreadStore.get(namespace, 'thread-1'),
  ).rejects.toThrow('A named Disk conversation requires a storage root');
  restore();

  expect(
    (await conversationThreadStore.get(namespace, 'thread-1'))?.state,
  ).toEqual({ driverState: { marker: 'rows' } });
});
