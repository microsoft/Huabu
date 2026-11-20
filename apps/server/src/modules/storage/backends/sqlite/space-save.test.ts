// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import {
  openSqliteTestStore,
  readSqliteDeltaLog,
  withTestDatabase,
} from './test-support.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

import type { OpenSqliteTestStore } from './test-support.js';
import type {
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type { SaveResult } from '../../ports/save.js';
import type { SpaceWriteInput } from '../../ports/structured.js';
import type {
  CanvasChangeRecord,
  CanvasNode,
} from '@huabu/shared/canvas-engine';

const CANVAS = 'sqlite-save-space';
const OPERATION = '0b6f3c52-7d1e-4c7a-9f3b-2a6f0e9d4c11';
const DAY_MS = 24 * 60 * 60 * 1000;
const THREAD = 'thread-save';

/** A real Review record; a hand-rolled one would be coalesced away. */
function reviewRecord(nodeId: string): CanvasChangeRecord {
  const [record] = extractCanvasChanges([
    {
      type: 'INSERT_NODE',
      node: {
        id: nodeId,
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: nodeId, content: 'body' },
      } as CanvasNode,
    },
  ]);
  if (!record) throw new Error('No Review record was produced');
  return record;
}

function resultFor(
  operationId = OPERATION,
  response: unknown = { ok: true },
): SaveResult {
  return {
    key: { principalId: 'principal', operationId },
    digest: 'a'.repeat(64),
    response,
  };
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function note(nodeId: string): NodeContent {
  return { nodeId, type: 'note', label: nodeId, content: 'body' };
}

function deltaFor(version: number): DeltaLogEntry {
  return {
    version,
    ts: version + 100,
    commands: [{ version }],
    deltas: [],
    originator: { source: 'system' },
  };
}

function countRows(filename: string, table: string, canvasId = CANVAS): number {
  return withTestDatabase(filename, (database) =>
    Number(
      database
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE canvas_id = ?`)
        .get(canvasId)?.['n'],
    ),
  );
}

describe('SQLite reliable save', () => {
  let harness: OpenSqliteTestStore | null = null;
  let clock = 1_000_000;

  async function open(): Promise<OpenSqliteTestStore> {
    clock = 1_000_000;
    harness = await openSqliteTestStore('huabu-sqlite-save-', () => clock);
    const created = await harness.store
      .spaces()
      .create({ canvasId: CANVAS, title: 'Save Space' });
    if (!created.ok) throw new Error('Could not create the test Space');
    return harness;
  }

  async function current(h: OpenSqliteTestStore): Promise<CanvasFile> {
    const record = await h.store.space(CANVAS).read();
    if (!record) throw new Error('Test Space is missing');
    return record;
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

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it('touches neither save table for a write without a result or a baseline', async () => {
    const h = await open();
    const record = await current(h);
    const next = bump(record, [{ id: 'a', type: 'note' }]);
    await h.store.space(CANVAS).write({
      expectedVersion: record.version,
      nextRecord: next,
      nodeMutations: [{ kind: 'put', nodeId: 'a', record: note('a') }],
      delta: deltaFor(next.version),
    });
    expect(countRows(h.filename, 'space_save_heads')).toBe(0);
    expect(countRows(h.filename, 'space_save_results')).toBe(0);

    // The baseline appears with the first stamps() call and not before.
    await h.store.space(CANVAS).save.stamps();
    expect(countRows(h.filename, 'space_save_heads')).toBe(1);
  });

  it('keeps results and stamps through rename and re-parenting', async () => {
    const h = await open();
    const space = h.store.space(CANVAS);
    const record = await current(h);
    const result = resultFor();
    await space.write({
      expectedVersion: record.version,
      nextRecord: bump(record),
      nodeMutations: [],
      result,
    });
    const stamps = await space.save.stamps();

    const parent = await h.store
      .spaces()
      .create({ canvasId: 'sqlite-save-parent', title: 'Parent' });
    expect(parent.ok).toBe(true);
    await expect(
      h.store.spaces().rename({ canvasId: CANVAS, title: 'Renamed' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      h.store.spaces().setParent({
        canvasId: CANVAS,
        parentSpaceId: 'sqlite-save-parent',
        parentEntryNodeId: 'node-entry',
      }),
    ).resolves.toBe(true);

    const moved = h.store.space(CANVAS);
    await expect(moved.save.lookup(result.key)).resolves.toMatchObject({
      digest: result.digest,
      atVersion: 1,
    });
    await expect(moved.save.stamps()).resolves.toEqual(stamps);
  });

  it('removes results and stamps with the Space', async () => {
    const h = await open();
    const space = h.store.space(CANVAS);
    const record = await current(h);
    const result = resultFor();
    await space.write({
      expectedVersion: record.version,
      nextRecord: bump(record),
      nodeMutations: [],
      result,
    });
    const before = await space.save.stamps();

    const deletion = await h.store.spaces().beginDelete({ canvasId: CANVAS });
    if (!deletion.ok) throw new Error('Ordinary Space must be deletable');
    await deletion.session.finish();
    expect(countRows(h.filename, 'space_save_heads')).toBe(0);
    expect(countRows(h.filename, 'space_save_results')).toBe(0);
    await expect(space.save.lookup(result.key)).resolves.toBeNull();
    await expect(space.save.stamps()).resolves.toBeNull();

    // The same id created again is a different Space with its own history.
    await h.store.spaces().create({ canvasId: CANVAS, title: 'Again' });
    const again = h.store.space(CANVAS);
    await expect(again.save.lookup(result.key)).resolves.toBeNull();
    const after = await again.save.stamps();
    expect(after?.lineage).not.toBe(before?.lineage);
    expect(after).toMatchObject({ floor: 0, version: 0, nodes: {} });
  });

  it('does not answer for a Space in another Workspace', async () => {
    const h = await open();
    const space = h.store.space(CANVAS);
    const record = await current(h);
    const result = resultFor();
    await space.write({
      expectedVersion: record.version,
      nextRecord: bump(record),
      nodeMutations: [],
      result,
    });
    await space.save.stamps();

    const other = await new SqliteWorkspaceRepository(h.context).create(
      'Other Workspace',
    );
    h.context.useWorkspace(other.workspaceId);
    try {
      // The retained handle refuses; a fresh one sees no such Space.
      await expect(space.save.lookup(result.key)).rejects.toThrow();
      const foreign = h.store.space(CANVAS);
      await expect(foreign.save.lookup(result.key)).resolves.toBeNull();
      await expect(foreign.save.stamps()).resolves.toBeNull();
      await expect(
        foreign.save.record({ expectedVersion: 1, result: resultFor() }),
      ).rejects.toThrow();
    } finally {
      h.context.useWorkspace(h.workspaceId);
    }
  });

  it('prunes a bounded number of expired results when it stores a new one', async () => {
    const h = await open();
    const space = h.store.space(CANVAS);
    const total = 70;
    for (let index = 0; index < total; index += 1) {
      await space.save.record({
        expectedVersion: 0,
        result: resultFor(operationId(index)),
      });
    }
    expect(countRows(h.filename, 'space_save_results')).toBe(total);

    // Still inside the retention window: nothing goes.
    clock += 13 * DAY_MS;
    await space.save.record({
      expectedVersion: 0,
      result: resultFor(operationId(1000)),
    });
    expect(countRows(h.filename, 'space_save_results')).toBe(total + 1);

    // Past it: one write removes at most 64, the next removes the rest.
    clock += 2 * DAY_MS;
    const record = await current(h);
    await space.write({
      expectedVersion: record.version,
      nextRecord: bump(record),
      nodeMutations: [],
      result: resultFor(operationId(1001)),
    });
    expect(countRows(h.filename, 'space_save_results')).toBe(total + 2 - 64);
    await space.save.record({
      expectedVersion: 1,
      result: resultFor(operationId(1002)),
    });
    expect(countRows(h.filename, 'space_save_results')).toBe(3);
    await expect(
      space.save.lookup(resultFor(operationId(0)).key),
    ).resolves.toBeNull();
    await expect(
      space.save.lookup(resultFor(operationId(1000)).key),
    ).resolves.not.toBeNull();
  });

  it.each([
    'sidecar',
    'state',
    'delta',
    'stamps',
    'reviews',
    'result',
    'committed-before-reply',
  ])(
    'is all-or-nothing when the process dies at %s',
    async (stage) => {
      const h = await open();
      const space = h.store.space(CANVAS);
      const record = await current(h);
      const baseline = await space.save.stamps();
      const next = bump(record, [{ id: 'crash-node', type: 'note' }]);
      const result = resultFor(OPERATION, { nodeIds: ['crash-node'] });
      // The thread already holds a list, so the write updates a row.
      const existing = await space.changes.append(THREAD, [
        reviewRecord('reviewed-earlier'),
      ]);
      const added = reviewRecord('crash-node');
      const merged = [...existing, added];
      const input: SpaceWriteInput = {
        expectedVersion: record.version,
        nextRecord: next,
        nodeMutations: [
          { kind: 'put', nodeId: 'crash-node', record: note('crash-node') },
        ],
        delta: deltaFor(next.version),
        result,
        reviews: [{ threadId: THREAD, records: [added] }],
      };

      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./space-save.crash-fixture.ts', import.meta.url),
          ),
          h.filename,
          h.workspaceId,
          CANVAS,
          JSON.stringify(input),
          stage,
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(child.signal, child.stderr).toBe('SIGKILL');

      const committed = stage === 'committed-before-reply';
      const stored = {
        digest: result.digest,
        response: result.response,
        atVersion: next.version,
      };
      expect((await space.read())?.version).toBe(committed ? 1 : 0);
      await expect(space.save.lookup(result.key)).resolves.toEqual(
        committed ? stored : null,
      );
      expect(Boolean(await space.nodes.read('crash-node'))).toBe(committed);
      await expect(space.changes.read(THREAD)).resolves.toEqual(
        committed ? merged : existing,
      );
      expect(readSqliteDeltaLog(h.filename, CANVAS)).toEqual(
        committed ? [input.delta] : [],
      );
      await expect(space.save.stamps()).resolves.toEqual(
        committed
          ? {
              ...baseline,
              version: 1,
              nodes: { 'crash-node': { created: 1, membership: 1 } },
            }
          : baseline,
      );

      // The caller never heard back and sends the same request again.
      await expect(space.write(input)).resolves.toEqual(
        committed
          ? { ok: false, reason: 'result-exists', stored }
          : { ok: true, reviews: { [THREAD]: merged } },
      );
      await expect(space.changes.read(THREAD)).resolves.toEqual(merged);
      await expect(space.read()).resolves.toEqual(next);
      await expect(space.save.lookup(result.key)).resolves.toEqual(stored);
      expect(readSqliteDeltaLog(h.filename, CANVAS)).toEqual([input.delta]);
      expect(countRows(h.filename, 'space_save_results')).toBe(1);
    },
    30000,
  );
});
