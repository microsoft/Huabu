// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it } from 'vitest';

import { PostgresStoreContext } from './database.js';
import { PostgresStructuredStore } from './structured-store.js';
import { openPostgresTestStore } from './test-support.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';
import { note } from '../sql/test-fixtures.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SaveResult } from '../../ports/save.js';

const CANVAS = 'space';
const DAY_MS = 24 * 60 * 60 * 1000;

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function resultFor(index = 0, response: unknown = { ok: true }): SaveResult {
  return {
    key: { principalId: 'principal', operationId: operationId(index) },
    digest: 'a'.repeat(64),
    response,
  };
}

function bump(
  record: CanvasFile,
  nodes: unknown[] = record.state.nodes,
): CanvasFile {
  return {
    ...record,
    version: record.version + 1,
    state: { ...record.state, nodes },
    updatedAt: record.updatedAt + 1,
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function open() {
  const h = await openPostgresTestStore();
  cleanup.push(h.cleanup);
  await h.store.spaces().create({ canvasId: CANVAS, title: 'Test' });
  const count = async (table: string): Promise<number> =>
    Number(
      (
        await h.context
          .database()
          .get(`SELECT COUNT(*) AS n FROM ${table} WHERE canvas_id = ?`, CANVAS)
      )?.['n'],
    );
  const current = async (): Promise<CanvasFile> => {
    const record = await h.store.space(CANVAS).read();
    if (!record) throw new Error('Test Space is missing');
    return record;
  };
  return { ...h, count, current };
}

it('touches neither save table for a write without a result or a baseline', async () => {
  const h = await open();
  const space = h.store.space(CANVAS);
  const record = await h.current();
  const next = bump(record, [{ id: 'a', type: 'note' }]);
  await space.write({
    expectedVersion: record.version,
    nextRecord: next,
    nodeMutations: [{ kind: 'put', nodeId: 'a', record: note('a') }],
    delta: {
      version: next.version,
      ts: 1,
      commands: [],
      deltas: [],
      originator: { source: 'system' },
    },
  });
  expect(await h.count('space_save_heads')).toBe(0);
  expect(await h.count('space_save_results')).toBe(0);
  await space.save.stamps();
  expect(await h.count('space_save_heads')).toBe(1);
});

it('keeps results and stamps through rename and re-parenting, and cascades on delete', async () => {
  const h = await open();
  const space = h.store.space(CANVAS);
  const record = await h.current();
  const result = resultFor();
  await space.write({
    expectedVersion: record.version,
    nextRecord: bump(record, [{ id: 'a', type: 'note' }]),
    nodeMutations: [],
    result,
  });
  const stamps = await space.save.stamps();

  await h.store.spaces().create({ canvasId: 'parent', title: 'Parent' });
  expect(
    await h.store.spaces().rename({ canvasId: CANVAS, title: 'Renamed' }),
  ).toMatchObject({ ok: true });
  expect(
    await h.store.spaces().setParent({
      canvasId: CANVAS,
      parentSpaceId: 'parent',
      parentEntryNodeId: 'node-entry',
    }),
  ).toBe(true);
  const moved = h.store.space(CANVAS);
  expect(await moved.save.lookup(result.key)).toEqual({
    digest: result.digest,
    response: result.response,
    atVersion: 1,
  });
  expect(await moved.save.stamps()).toEqual(stamps);

  const deletion = await h.store.spaces().beginDelete({ canvasId: CANVAS });
  if (!deletion.ok) throw new Error('Ordinary Space must be deletable');
  await deletion.session.finish();
  expect(await h.count('space_save_heads')).toBe(0);
  expect(await h.count('space_save_results')).toBe(0);
  expect(await moved.save.lookup(result.key)).toBeNull();
  expect(await moved.save.stamps()).toBeNull();

  await h.store.spaces().create({ canvasId: CANVAS, title: 'Again' });
  const again = h.store.space(CANVAS);
  expect(await again.save.lookup(result.key)).toBeNull();
  expect((await again.save.stamps())?.lineage).not.toBe(stamps?.lineage);
});

it('does not answer for a Space in another Workspace', async () => {
  const h = await open();
  const space = h.store.space(CANVAS);
  const record = await h.current();
  const result = resultFor();
  await space.write({
    expectedVersion: record.version,
    nextRecord: bump(record),
    nodeMutations: [],
    result,
  });
  await space.save.stamps();

  const other = await new PostgresWorkspaceRepository(h.context).create(
    'Other Workspace',
  );
  h.context.useWorkspace(other.workspaceId);
  try {
    await expect(space.save.lookup(result.key)).rejects.toThrow();
    const foreign = h.store.space(CANVAS);
    expect(await foreign.save.lookup(result.key)).toBeNull();
    expect(await foreign.save.stamps()).toBeNull();
    await expect(
      foreign.save.record({ expectedVersion: 1, result: resultFor(1) }),
    ).rejects.toThrow();
  } finally {
    h.context.useWorkspace(h.workspaceId);
  }
});

it('gives two connections one baseline and one stored result', async () => {
  const h = await open();
  const peer = new PostgresStoreContext(h.config);
  cleanup.push(() => peer.close());
  await peer.init();
  peer.useWorkspace(h.workspaceId);
  const first = h.store.space(CANVAS);
  const second = new PostgresStructuredStore(peer).space(CANVAS);

  const [a, b] = await Promise.all([first.save.stamps(), second.save.stamps()]);
  expect(a).toEqual(b);
  expect(await h.count('space_save_heads')).toBe(1);

  const record = await h.current();
  const input = {
    expectedVersion: record.version,
    nextRecord: bump(record),
    nodeMutations: [],
    result: resultFor(),
  };
  const outcomes = await Promise.all([first.write(input), second.write(input)]);
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
    {
      ok: false,
      reason: 'result-exists',
      stored: {
        digest: input.result.digest,
        response: input.result.response,
        atVersion: 1,
      },
    },
  ]);
  expect((await h.current()).version).toBe(1);
  expect(await h.count('space_save_results')).toBe(1);
});

it('prunes a bounded number of expired results when it stores a new one', async () => {
  const database = await openPostgresTestStore();
  cleanup.push(database.cleanup);
  let clock = 1_000_000;
  const context = new PostgresStoreContext(database.config, () => clock);
  cleanup.push(() => context.close());
  await context.init();
  context.useWorkspace(database.workspaceId);
  const store = new PostgresStructuredStore(context);
  await store.spaces().create({ canvasId: CANVAS, title: 'Test' });
  const space = store.space(CANVAS);
  const count = async (): Promise<number> =>
    Number(
      (
        await context
          .database()
          .get(
            'SELECT COUNT(*) AS n FROM space_save_results WHERE canvas_id = ?',
            CANVAS,
          )
      )?.['n'],
    );

  const total = 70;
  for (let index = 0; index < total; index += 1) {
    await space.save.record({ expectedVersion: 0, result: resultFor(index) });
  }
  clock += 13 * DAY_MS;
  await space.save.record({ expectedVersion: 0, result: resultFor(1000) });
  expect(await count()).toBe(total + 1);

  clock += 2 * DAY_MS;
  await space.save.record({ expectedVersion: 0, result: resultFor(1001) });
  expect(await count()).toBe(total + 2 - 64);
  await space.save.record({ expectedVersion: 0, result: resultFor(1002) });
  expect(await count()).toBe(3);
  expect(await space.save.lookup(resultFor(0).key)).toBeNull();
  expect(await space.save.lookup(resultFor(1000).key)).not.toBeNull();
});
