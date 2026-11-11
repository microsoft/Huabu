// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The core reliable-save cases of `canvas-executor.reliable.test.ts`, run
 * against the SQLite backend: there the result record, the Review records
 * and the state share one transaction rather than a write-ahead intent.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encodeBasis } from '@huabu/shared';

import {
  ExecuteRequestReusedError,
  executeOnServer,
  type ExecuteOnServerInput,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import {
  closeStorage,
  createSpace,
  initStorage,
  space,
} from '../storage/index.js';

import type { CanvasFile } from './persistence-types.js';
import type { CanvasCommand, CanvasSyncEvent } from '@huabu/shared';

const CANVAS = 'c1';
const THREAD = 'thread-review';
const PRINCIPAL = 'user:alice';
const NOTES = ['a', 'b'] as const;

let tmp: string;
let previousDataDir: string | undefined;
let events: CanvasSyncEvent[];
let unsubscribe: () => void;

/** One root frame (`f1`) and two root notes (`a`, `b`), at version 1. */
async function seed(): Promise<void> {
  const created = await createSpace(CANVAS, 'Reliable');
  if (!created.ok) throw new Error('Could not create the test Space');
  const next: CanvasFile = {
    ...created.record,
    version: 1,
    state: {
      nodes: [
        {
          id: 'f1',
          type: 'frame',
          position: { x: 0, y: 400 },
          style: { width: 300, height: 300 },
          data: { label: 'f1', sizing: 'manual' },
        },
        ...NOTES.map((id, index) => ({
          id,
          type: 'note',
          position: { x: index * 300, y: 0 },
          style: { width: 200, height: 100 },
          data: { label: id.toUpperCase() },
        })),
      ],
      edges: [],
    },
  };
  const written = await space(CANVAS).write({
    expectedVersion: 0,
    nextRecord: next,
    nodeMutations: [
      {
        kind: 'put',
        nodeId: 'f1',
        record: { nodeId: 'f1', type: 'frame', label: 'f1', content: '' },
      },
      ...NOTES.map((id) => ({
        kind: 'put' as const,
        nodeId: id,
        record: {
          nodeId: id,
          type: 'note',
          label: id.toUpperCase(),
          content: `${id} body`,
        },
      })),
    ],
  });
  if (!written.ok) throw new Error('Could not seed the test Space');
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-reliable-sqlite-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = join(tmp, 'data');
  await initStorage({
    structured: { kind: 'sqlite' },
    blobs: { kind: 'disk' },
  });
  await seed();
  events = [];
  unsubscribe = subscribeCanvasUpdates(CANVAS, (event) => events.push(event));
});

afterEach(async () => {
  unsubscribe();
  await closeStorage();
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

function run(
  commands: unknown[],
  extra: Partial<ExecuteOnServerInput> = {},
): Promise<ExecuteOnServerOutput> {
  return executeOnServer({
    canvasId: CANVAS,
    commands: commands as CanvasCommand[],
    originator: { source: 'ui' },
    ...extra,
  });
}

const requestOf = () => ({ operationId: randomUUID(), principalId: PRINCIPAL });

const createNote = (label: string) => ({
  type: 'CREATE_NODES',
  nodes: [
    {
      nodeType: 'note',
      position: { x: 0, y: 900 },
      size: { width: 200, height: 100 },
      data: { label, content: `${label} body` },
    },
  ],
});

async function recordNow(): Promise<CanvasFile> {
  const record = await space(CANVAS).read();
  if (!record) throw new Error('Space is missing');
  return record;
}

describe('reliable save on SQLite', () => {
  it('answers a retry with the stored response instead of applying it twice', async () => {
    const input = {
      originator: { source: 'agent' as const },
      request: requestOf(),
      issueBasis: true,
    };

    const first = await run([createNote('New')], input);
    const second = await run([createNote('New')], input);

    expect(first.replayed).toBeUndefined();
    expect(first.toVersion).toBe(2);
    expect(second).toEqual({ ...first, replayed: true });
    const record = await recordNow();
    expect(record.version).toBe(2);
    expect(record.state.nodes).toHaveLength(4);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'update',
      data: { toVersion: 2, operationId: input.request.operationId },
    });
  });

  it('refuses a request id reused for a different request', async () => {
    const request = requestOf();
    await run([createNote('One')], { request });

    await expect(
      run([createNote('Another')], { request }),
    ).rejects.toBeInstanceOf(ExecuteRequestReusedError);
    expect((await recordNow()).version).toBe(2);
  });

  it('rejects a move built on a read from before the node was reparented', async () => {
    const stamps = await space(CANVAS).save.stamps();
    if (!stamps) throw new Error('Space is missing');
    const basis = encodeBasis(stamps.lineage, stamps.version);
    await run([{ type: 'SET_NODE_PARENT', nodeIds: ['a'], parentId: 'f1' }]);

    const output = await run(
      [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'a', position: { x: 5, y: 5 } }],
        },
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'b', position: { x: 7, y: 7 } }],
        },
      ],
      { basis, request: requestOf() },
    );

    expect(
      output.results.map(({ applied, reason }) => [applied, reason]),
    ).toEqual([
      [false, 'stale-parent'],
      [true, undefined],
    ]);
    expect(output.toVersion).toBe(3);
  });

  it('stores Review records with the write, once, and not at all when it fails', async () => {
    const reviewed = {
      originator: { source: 'agent' as const, threadId: THREAD },
      computeChanges: true,
      request: requestOf(),
    };

    const first = await run([createNote('New')], reviewed);
    const replay = await run([createNote('New')], reviewed);

    expect(replay).toEqual({ ...first, replayed: true });
    const stored = await space(CANVAS).changes.read(THREAD);
    expect(stored).toEqual(first.changes);
    expect(stored).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      data: { threadId: THREAD, changes: stored },
    });

    // Fail the transaction at its Review step, after the state was updated.
    const substrate = await space(CANVAS).extension('test.reliable');
    if (substrate?.kind !== 'sqlite') throw new Error('Expected SQLite');
    substrate.database.exec(
      `CREATE TEMP TRIGGER fail_reviews AFTER UPDATE ON changes
       BEGIN SELECT RAISE(ABORT, 'review storage failed'); END;`,
    );
    await expect(
      run([createNote('Second')], { ...reviewed, request: requestOf() }),
    ).rejects.toThrow('review storage failed');
    substrate.database.exec('DROP TRIGGER fail_reviews');
    expect((await recordNow()).version).toBe(2);
    expect((await recordNow()).state.nodes).toHaveLength(4);
    await expect(space(CANVAS).changes.read(THREAD)).resolves.toEqual(stored);
    expect(events).toHaveLength(1);
  });
});
