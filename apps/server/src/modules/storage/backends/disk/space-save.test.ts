// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import {
  nodesDir,
  saveDir,
  saveHeadPath,
  savePendingPath,
  saveResultsDir,
} from './layout.js';
import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { createDiskSpaceSave } from './space-save.js';
import { createDiskSpaceWrite } from './space-write.js';
import { DiskStructuredStore } from './structured-store.js';
import { ensureWorldCanvasOnDisk } from './world-canvas.js';
import { setWorkspacePath } from '../../../workspace.js';

import type { DiskSaveStage } from './space-save.js';
import type {
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type { SaveResult } from '../../ports/save.js';
import type { SpaceWriteInput } from '../../ports/structured.js';

const CANVAS = 'disk-save-space';
const OPERATION = '0b6f3c52-7d1e-4c7a-9f3b-2a6f0e9d4c11';
const DAY_MS = 24 * 60 * 60 * 1000;

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

function note(nodeId: string, content = 'body'): NodeContent {
  return { nodeId, type: 'note', label: nodeId, content };
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

describe('Disk reliable save', () => {
  let root: string;
  let store: DiskStructuredStore;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'huabu-disk-save-'));
    setWorkspacePath(root);
    resetStorageCache();
    ensureWorldCanvasOnDisk(root);
    refreshCanvasDirIndex();
    store = new DiskStructuredStore();
    const created = await store
      .spaces()
      .create({ canvasId: CANVAS, title: 'Save Space' });
    if (!created.ok) throw new Error('Could not create the test Space');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStorageCache();
    rmSync(root, { recursive: true, force: true });
  });

  async function current(): Promise<CanvasFile> {
    const record = await store.space(CANVAS).read();
    if (!record) throw new Error('Test Space is missing');
    return record;
  }

  function journal(): DeltaLogEntry[] {
    return getCanvasStore(CANVAS).readDeltaLogSince(0);
  }

  /** A batch that creates one node, journals a delta and carries a result. */
  async function batch(result = resultFor()): Promise<SpaceWriteInput> {
    const record = await current();
    const next = bump(record, [
      ...record.state.nodes,
      { id: 'batch-node', type: 'note' },
    ]);
    return {
      expectedVersion: record.version,
      nextRecord: next,
      nodeMutations: [
        {
          kind: 'put',
          nodeId: 'batch-node',
          record: note('batch-node'),
          authoritativeInsert: true,
        },
      ],
      delta: deltaFor(next.version),
      result,
    };
  }

  it('creates no save state for a write without a result or a baseline', async () => {
    const space = store.space(CANVAS);
    const { result: _result, ...input } = await batch();
    await expect(space.write(input)).resolves.toEqual({ ok: true });
    await expect(space.save.lookup(resultFor().key)).resolves.toBeNull();
    expect(existsSync(saveDir(CANVAS))).toBe(false);

    await space.save.stamps();
    expect(existsSync(saveHeadPath(CANVAS))).toBe(true);
  });

  it('leaves no intent behind after a completed write', async () => {
    const space = store.space(CANVAS);
    await space.save.stamps();
    const input = await batch();
    await expect(space.write(input)).resolves.toEqual({ ok: true });
    expect(existsSync(savePendingPath(CANVAS))).toBe(false);
    expect(readdirSync(saveResultsDir(CANVAS))).toHaveLength(1);
    expect(
      readdirSync(saveDir(CANVAS)).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
  });

  it('keeps results and stamps through rename and re-parenting, and drops them on delete', async () => {
    const space = store.space(CANVAS);
    const input = await batch();
    await space.write(input);
    const stamps = await space.save.stamps();

    await store.spaces().create({ canvasId: 'disk-save-parent', title: 'P' });
    await expect(
      store.spaces().rename({ canvasId: CANVAS, title: 'Renamed Space' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      store.spaces().setParent({
        canvasId: CANVAS,
        parentSpaceId: 'disk-save-parent',
        parentEntryNodeId: 'node-entry',
      }),
    ).resolves.toBe(true);
    const moved = store.space(CANVAS);
    await expect(moved.save.lookup(resultFor().key)).resolves.toMatchObject({
      atVersion: 1,
    });
    await expect(moved.save.stamps()).resolves.toEqual(stamps);

    const deletion = await store.spaces().beginDelete({ canvasId: CANVAS });
    if (!deletion.ok) throw new Error('Ordinary Space must be deletable');
    await deletion.session.finish();
    const gone = store.space(CANVAS);
    await expect(gone.save.lookup(resultFor().key)).resolves.toBeNull();
    await expect(gone.save.stamps()).resolves.toBeNull();

    await store.spaces().create({ canvasId: CANVAS, title: 'Again' });
    const again = store.space(CANVAS);
    await expect(again.save.lookup(resultFor().key)).resolves.toBeNull();
    expect((await again.save.stamps())?.lineage).not.toBe(stamps?.lineage);
  });

  it('re-bases the stamps when a writer moved the version without them', async () => {
    const space = store.space(CANVAS);
    const baseline = await space.save.stamps();
    const record = await current();

    // A writer that bypasses SpaceHandle.write: the head can no longer vouch
    // for any node, so every basis of the old lineage must stop matching.
    getCanvasStore(CANVAS).write(bump(record, [{ id: 'x', type: 'note' }]));
    const rebased = await space.save.stamps();
    expect(rebased).toMatchObject({ floor: 1, version: 1, nodes: {} });
    expect(rebased?.lineage).not.toBe(baseline?.lineage);
    await expect(space.save.stamps()).resolves.toEqual(rebased);

    // The same happens when the next thing to notice is a write.
    getCanvasStore(CANVAS).write(bump(await current()));
    const now = await current();
    await space.write({
      expectedVersion: now.version,
      nextRecord: bump(now, [...now.state.nodes, { id: 'y', type: 'note' }]),
      nodeMutations: [],
    });
    const after = await space.save.stamps();
    expect(after).toMatchObject({
      floor: 2,
      version: 3,
      nodes: { y: { created: 3, membership: 3 } },
    });
    expect(after?.lineage).not.toBe(rebased?.lineage);
  });

  it('drops the intent and stores nothing when the write rolls back', async () => {
    const space = store.space(CANVAS);
    const baseline = await space.save.stamps();
    const before = await current();
    const input = await batch();
    vi.spyOn(
      getCanvasStore(CANVAS),
      'appendDeltaLogEntry',
    ).mockImplementationOnce(() => {
      throw new Error('delta append failed');
    });
    await expect(space.write(input)).rejects.toThrow('delta append failed');

    expect(existsSync(savePendingPath(CANVAS))).toBe(false);
    await expect(space.read()).resolves.toEqual(before);
    await expect(space.nodes.read('batch-node')).resolves.toBeNull();
    await expect(space.save.lookup(resultFor().key)).resolves.toBeNull();
    await expect(space.save.stamps()).resolves.toEqual(baseline);
    expect(journal()).toEqual([]);

    await expect(space.write(input)).resolves.toEqual({ ok: true });
    expect(journal()).toEqual([input.delta]);
  });

  it('rolls the record back when the stamps cannot be written', async () => {
    const space = store.space(CANVAS);
    await space.save.stamps();
    const before = await current();
    const input = await batch();
    const write = createDiskSpaceWrite(getCanvasStore(CANVAS), {
      onStage: (stage: DiskSaveStage) => {
        // Between the delta row and the head: the last step inside the
        // rollback scope fails.
        if (stage === 'delta') throw new Error('head write failed');
      },
    });
    await expect(write(input)).rejects.toThrow('head write failed');
    await expect(space.read()).resolves.toEqual(before);
    expect(journal()).toEqual([]);
    expect(existsSync(savePendingPath(CANVAS))).toBe(false);
    await expect(space.save.lookup(resultFor().key)).resolves.toBeNull();
  });

  it('keeps the result of a write that failed only after it committed', async () => {
    const space = store.space(CANVAS);
    const baseline = await space.save.stamps();
    const record = await current();
    const next = bump(record, [{ id: 'late', type: 'note' }]);
    const result = resultFor();
    // A record-only write has no rollback scope: once space.json is replaced
    // the write happened, whatever fails afterwards.
    const write = createDiskSpaceWrite(getCanvasStore(CANVAS), {
      onStage: (stage: DiskSaveStage) => {
        if (stage === 'record') throw new Error('failed after the record');
      },
    });
    await expect(
      write({
        expectedVersion: record.version,
        nextRecord: next,
        nodeMutations: [],
        result,
      }),
    ).rejects.toThrow('failed after the record');
    expect(existsSync(savePendingPath(CANVAS))).toBe(true);

    // The caller cannot know; asking is what settles it.
    await expect(space.save.lookup(result.key)).resolves.toEqual({
      digest: result.digest,
      response: result.response,
      atVersion: next.version,
    });
    expect(existsSync(savePendingPath(CANVAS))).toBe(false);
    await expect(space.save.stamps()).resolves.toEqual({
      ...baseline,
      version: next.version,
      nodes: { late: { created: 1, membership: 1 } },
    });
    await expect(space.read()).resolves.toEqual(next);
  });

  it('recovers idempotently and discards an intent it cannot read', async () => {
    const space = store.space(CANVAS);
    const save = createDiskSpaceSave(getCanvasStore(CANVAS));
    mkdirSync(saveDir(CANVAS), { recursive: true });
    writeFileSync(savePendingPath(CANVAS), '{ not json', 'utf8');
    await expect(save.lookup(resultFor().key)).resolves.toBeNull();
    expect(existsSync(savePendingPath(CANVAS))).toBe(false);

    // An intent whose target version the record never reached is dropped;
    // one the record did reach is completed. Either way, once is enough.
    const record = await current();
    const pending = (toVersion: number) =>
      JSON.stringify({
        v: 1,
        result: {
          v: 1,
          principalId: 'principal',
          operationId: OPERATION,
          digest: 'a'.repeat(64),
          atVersion: toVersion,
          createdAt: 1,
          response: { ok: true },
        },
        expectedVersion: toVersion - 1,
        toVersion,
        delta: deltaFor(toVersion),
        stamps: null,
      });
    writeFileSync(savePendingPath(CANVAS), pending(record.version + 1), 'utf8');
    await expect(save.lookup(resultFor().key)).resolves.toBeNull();
    expect(existsSync(savePendingPath(CANVAS))).toBe(false);
    expect(journal()).toEqual([]);

    getCanvasStore(CANVAS).write(bump(record));
    writeFileSync(savePendingPath(CANVAS), pending(record.version + 1), 'utf8');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(space.save.lookup(resultFor().key)).resolves.toMatchObject({
        atVersion: record.version + 1,
      });
      writeFileSync(
        savePendingPath(CANVAS),
        pending(record.version + 1),
        'utf8',
      );
    }
    await space.save.stamps();
    expect(journal()).toEqual([deltaFor(record.version + 1)]);
    expect(readdirSync(saveResultsDir(CANVAS))).toHaveLength(1);
  });

  it('sweeps expired results at most once an hour', async () => {
    let clock = 10_000_000_000;
    const save = createDiskSpaceSave(getCanvasStore(CANVAS), {
      now: () => clock,
    });
    for (let index = 0; index < 3; index += 1) {
      await save.record({
        expectedVersion: 0,
        result: resultFor(operationId(index)),
      });
    }
    const directory = saveResultsDir(CANVAS);
    const old = (clock - 15 * DAY_MS) / 1000;
    for (const name of readdirSync(directory)) {
      utimesSync(path.join(directory, name), old, old);
    }

    // Within the hour of the first sweep nothing is scanned again.
    await save.record({
      expectedVersion: 0,
      result: resultFor(operationId(3)),
    });
    expect(readdirSync(directory)).toHaveLength(4);

    clock += 2 * 60 * 60 * 1000;
    await save.record({
      expectedVersion: 0,
      result: resultFor(operationId(4)),
    });
    expect(readdirSync(directory)).toHaveLength(2);
    await expect(
      save.lookup(resultFor(operationId(0)).key),
    ).resolves.toBeNull();
    await expect(
      save.lookup(resultFor(operationId(4)).key),
    ).resolves.not.toBeNull();
    expect(statSync(directory).isDirectory()).toBe(true);
  });

  it.each<[DiskSaveStage, boolean]>([
    ['pending', false],
    ['sidecars', false],
    ['record', true],
    ['delta', true],
    ['head', true],
    ['result', true],
  ])(
    'is all-or-nothing when the process dies at %s',
    async (stage, committed) => {
      const space = store.space(CANVAS);
      const baseline = await space.save.stamps();
      const before = await current();
      const input = await batch(
        resultFor(OPERATION, { nodeIds: ['batch-node'] }),
      );
      const result = input.result as SaveResult;

      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./space-save.crash-fixture.ts', import.meta.url),
          ),
          root,
          CANVAS,
          JSON.stringify(input),
          stage,
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(child.signal, child.stderr).toBe('SIGKILL');
      // A new process: nothing the dead one held in memory survives.
      resetStorageCache();
      refreshCanvasDirIndex();
      const recovered = new DiskStructuredStore().space(CANVAS);

      // What the dead writer left: an intent in every case but the last
      // step, and a delta row only once it got that far.
      expect(existsSync(savePendingPath(CANVAS))).toBe(true);
      const rowsLeft = stage === 'record' ? 0 : committed ? 1 : 0;
      expect(journal()).toHaveLength(rowsLeft);

      const stored = {
        digest: result.digest,
        response: result.response,
        atVersion: input.nextRecord.version,
      };
      // Asking for the result is what a retrying caller does first, and it
      // is enough to settle everything the write left unfinished.
      await expect(recovered.save.lookup(result.key)).resolves.toEqual(
        committed ? stored : null,
      );
      expect(existsSync(savePendingPath(CANVAS))).toBe(false);
      await expect(recovered.read()).resolves.toEqual(
        committed ? input.nextRecord : before,
      );
      // The delta row is repaired when the crash fell between the record
      // and the log.
      expect(journal()).toEqual(committed ? [input.delta] : []);
      await expect(recovered.save.stamps()).resolves.toEqual(
        committed
          ? {
              ...baseline,
              version: 1,
              nodes: { 'batch-node': { created: 1, membership: 1 } },
            }
          : baseline,
      );
      expect(Boolean(await recovered.nodes.read('batch-node'))).toBe(
        // The legacy writer keeps its before-images in memory, so a sidecar
        // written before a crash that preceded space.json is not undone. The
        // record does not list it, and the retry below overwrites it.
        committed || stage === 'sidecars',
      );

      // Recovery already ran; running it again changes nothing.
      await expect(recovered.save.lookup(result.key)).resolves.toEqual(
        committed ? stored : null,
      );
      expect(journal()).toEqual(committed ? [input.delta] : []);

      // The caller never heard back and sends the same request again.
      await expect(recovered.write(input)).resolves.toEqual(
        committed
          ? { ok: false, reason: 'result-exists', stored }
          : { ok: true },
      );
      await expect(recovered.read()).resolves.toEqual(input.nextRecord);
      await expect(recovered.save.lookup(result.key)).resolves.toEqual(stored);
      expect(journal()).toEqual([input.delta]);
      expect(readdirSync(nodesDir(CANVAS))).toEqual(['batch-node.md']);
      expect(readdirSync(saveResultsDir(CANVAS))).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(saveHeadPath(CANVAS), 'utf8')),
      ).toMatchObject({ version: 1 });
    },
    30000,
  );
});
