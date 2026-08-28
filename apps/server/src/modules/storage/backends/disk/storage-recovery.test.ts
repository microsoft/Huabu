// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { changesPath, eventsPath } from './layout.js';
import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskStructuredStore } from './structured-store.js';
import { space, createStorage, setStorageForTesting } from '../../storage.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

let root = '';
let restoreStorage: (() => void) | null = null;

function seedSpace(canvasId: string): CanvasFile {
  const dir = path.join(root, canvasId);
  mkdirSync(dir, { recursive: true });
  const record: CanvasFile = {
    canvasId,
    title: null,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify(record), 'utf8');
  refreshCanvasDirIndex();
  return record;
}

function action(nodeId: string) {
  return {
    action: 'node_selected' as const,
    node: { id: nodeId, type: 'note' as const, label: nodeId },
  };
}

function change(nodeId: string) {
  const [record] = extractCanvasChanges([
    {
      type: 'INSERT_NODE' as const,
      node: {
        id: nodeId,
        type: 'note' as const,
        position: { x: 0, y: 0 },
        data: { label: nodeId, content: `body-${nodeId}` },
      },
    },
  ]);
  return record;
}

type InvalidRecordFactory = (record: CanvasFile) => unknown;

const invalidRecordCases: ReadonlyArray<
  readonly [description: string, build: InvalidRecordFactory]
> = [
  ['an empty object', () => ({})],
  ['a different canvasId', (record) => ({ ...record, canvasId: 'other' })],
  [
    'a missing title',
    (record) => {
      const copy = { ...record } as Partial<CanvasFile>;
      delete copy.title;
      return copy;
    },
  ],
  ['a non-string title', (record) => ({ ...record, title: 42 })],
  ['a non-numeric version', (record) => ({ ...record, version: '0' })],
  ['a non-numeric createdAt', (record) => ({ ...record, createdAt: '1' })],
  ['a non-numeric updatedAt', (record) => ({ ...record, updatedAt: null })],
  [
    'a missing state',
    (record) => {
      const copy = { ...record } as Partial<CanvasFile>;
      delete copy.state;
      return copy;
    },
  ],
  ['an array state', (record) => ({ ...record, state: [] })],
  ['missing state.nodes', (record) => ({ ...record, state: { edges: [] } })],
  [
    'non-array state.nodes',
    (record) => ({ ...record, state: { nodes: {}, edges: [] } }),
  ],
  ['missing state.edges', (record) => ({ ...record, state: { nodes: [] } })],
  [
    'non-array state.edges',
    (record) => ({ ...record, state: { nodes: [], edges: {} } }),
  ],
];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'huabu-storage-recovery-'));
  workspaceState.path = root;
  resetStorageCache();
  restoreStorage = setStorageForTesting(
    createStorage({ structured: { kind: 'disk' }, blobs: { kind: 'disk' } }),
  );
});

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  resetStorageCache();
  rmSync(root, { recursive: true, force: true });
});

describe('strict structured reads', () => {
  it.each(['{"canvasId":', '{}'])(
    'surfaces an unindexable titled Space during a cold scan: %s',
    async (contents) => {
      const spaceRoot = path.join(root, 'Finder Titled Space');
      mkdirSync(spaceRoot);
      const file = path.join(spaceRoot, 'space.json');
      writeFileSync(file, contents, 'utf8');
      refreshCanvasDirIndex();

      // The record is the sole source of the stable id once a directory has
      // a human title. With no recoverable identity, the honest boundary is a
      // scan error rather than falsely reporting an arbitrary requested id as
      // missing and silently hiding the corrupt Space.
      const space = new DiskStructuredStore().space('unknown-id');
      await expect(space.read()).rejects.toBeInstanceOf(SyntaxError);
      expect(readFileSync(file, 'utf8')).toBe(contents);
    },
  );

  it('does not report malformed or unreadable space.json as not-found', async () => {
    const record = seedSpace('broken-record');
    const handle = new DiskStructuredStore().space('broken-record');
    const file = path.join(root, 'broken-record', 'space.json');

    writeFileSync(file, '{"canvasId":', 'utf8');
    await expect(handle.read()).rejects.toBeInstanceOf(SyntaxError);
    await expect(
      handle.write({
        expectedVersion: 0,
        nextRecord: { ...record, version: 1, updatedAt: 2 },
        nodeMutations: [],
      }),
    ).rejects.toBeInstanceOf(SyntaxError);

    rmSync(file);
    mkdirSync(file);
    await expect(handle.read()).rejects.toMatchObject({
      code: 'EISDIR',
    });
    await expect(
      handle.write({
        expectedVersion: 0,
        nextRecord: { ...record, version: 1, updatedAt: 2 },
        nodeMutations: [],
      }),
    ).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('reconciles the single strict record value without a legacy reread', async () => {
    const record = seedSpace('single-record-read');
    const store = getCanvasStore('single-record-read');
    const originalRead = store.read;
    store.read = () => {
      throw new Error('legacy reread should not run');
    };
    try {
      await expect(
        new DiskStructuredStore().space('single-record-read').read(),
      ).resolves.toEqual(record);
    } finally {
      store.read = originalRead;
    }
  });

  it.each(['null', '[]', '"not a record"'])(
    'rejects a present non-object Space record: %s',
    async (contents) => {
      seedSpace('wrong-record-shape');
      const space = new DiskStructuredStore().space('wrong-record-shape');
      writeFileSync(
        path.join(root, 'wrong-record-shape', 'space.json'),
        contents,
        'utf8',
      );

      await expect(space.read()).rejects.toBeInstanceOf(SyntaxError);
    },
  );

  it.each(invalidRecordCases)(
    'rejects persisted Space records with %s before self-heal and preserves the bytes',
    async (_description, buildInvalid) => {
      const record = seedSpace('invalid-persisted-record');
      const handle = new DiskStructuredStore().space(
        'invalid-persisted-record',
      );
      const file = path.join(root, 'invalid-persisted-record', 'space.json');
      const bytes = JSON.stringify(buildInvalid(record));
      writeFileSync(file, bytes, 'utf8');

      await expect(handle.read()).rejects.toBeInstanceOf(SyntaxError);
      await expect(
        handle.write({
          expectedVersion: 0,
          nextRecord: { ...record, version: 1, updatedAt: 2 },
          nodeMutations: [],
        }),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  it('strictly validates an externally renamed Space before title self-heal', async () => {
    const record = seedSpace('renamed-invalid-record');
    const space = new DiskStructuredStore().space('renamed-invalid-record');
    await expect(space.read()).resolves.toMatchObject({
      canvasId: 'renamed-invalid-record',
    });
    const movedRoot = path.join(root, 'Finder Renamed');
    renameSync(path.join(root, 'renamed-invalid-record'), movedRoot);
    const file = path.join(movedRoot, 'space.json');
    const bytes = JSON.stringify({ ...record, state: {} });
    writeFileSync(file, bytes, 'utf8');

    await expect(space.read()).rejects.toBeInstanceOf(SyntaxError);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it.each(invalidRecordCases)(
    'rejects ordered next records with %s and preserves the current bytes',
    async (_description, buildInvalid) => {
      const record = seedSpace('invalid-next-record');
      const handle = new DiskStructuredStore().space('invalid-next-record');
      const file = path.join(root, 'invalid-next-record', 'space.json');
      const bytes = readFileSync(file, 'utf8');

      await expect(
        handle.write({
          expectedVersion: 0,
          nextRecord: buildInvalid({
            ...record,
            version: 1,
            updatedAt: 2,
          }) as CanvasFile,
          nodeMutations: [],
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  it('does not replace malformed mutable JSON with an empty baseline', async () => {
    seedSpace('broken-mutable');
    const { changes } = new DiskStructuredStore().space('broken-mutable');
    const changeFile = changesPath('broken-mutable', 'thread-1');
    mkdirSync(path.dirname(changeFile), { recursive: true });
    writeFileSync(changeFile, '[{"id":"survivor"', 'utf8');

    await expect(changes.read('thread-1')).rejects.toBeInstanceOf(SyntaxError);
    await expect(
      changes.append('thread-1', [change('replacement')]),
    ).rejects.toBeInstanceOf(SyntaxError);
    await expect(changes.delete('thread-1', 'survivor')).rejects.toBeInstanceOf(
      SyntaxError,
    );

    expect(readFileSync(changeFile, 'utf8')).toBe('[{"id":"survivor"');
  });

  it('uses one strict array value for change reads and mutations', async () => {
    seedSpace('single-array-read');
    const handle = new DiskStructuredStore().space('single-array-read');
    const firstChange = change('n1');
    await handle.changes.append('thread-1', [firstChange]);

    const store = getCanvasStore('single-array-read');
    const legacySpies = [
      vi.spyOn(store, 'readChanges'),
      vi.spyOn(store, 'appendChanges'),
      vi.spyOn(store, 'removeChange'),
    ];
    for (const spy of legacySpies) {
      spy.mockImplementation(() => {
        throw new Error('legacy array reread should not run');
      });
    }

    try {
      await expect(handle.changes.read('thread-1')).resolves.toEqual([
        firstChange,
      ]);
      await expect(
        handle.changes.append('thread-1', [change('n2')]),
      ).resolves.toHaveLength(2);
      await expect(
        handle.changes.delete('thread-1', firstChange.id),
      ).resolves.toEqual(firstChange);
    } finally {
      for (const spy of legacySpies) spy.mockRestore();
    }
  });

  it.each(['null', '{}', '"not a list"'])(
    'rejects non-array mutable JSON without overwriting it: %s',
    async (contents) => {
      seedSpace('wrong-mutable-shape');
      const { changes } = new DiskStructuredStore().space(
        'wrong-mutable-shape',
      );
      const changeFile = changesPath('wrong-mutable-shape', 'thread-1');
      mkdirSync(path.dirname(changeFile), { recursive: true });
      writeFileSync(changeFile, contents, 'utf8');

      await expect(changes.read('thread-1')).rejects.toBeInstanceOf(
        SyntaxError,
      );
      await expect(
        changes.append('thread-1', [change('replacement')]),
      ).rejects.toBeInstanceOf(SyntaxError);

      expect(readFileSync(changeFile, 'utf8')).toBe(contents);
    },
  );
});

describe('JSONL recovery and ordering', () => {
  it('propagates an unreadable event path instead of returning an empty log', async () => {
    seedSpace('unreadable-events');
    const { events } = new DiskStructuredStore().space('unreadable-events');
    mkdirSync(eventsPath('unreadable-events'), { recursive: true });
    await expect(events.read()).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('rejects malformed durable JSONL rows without changing the log', async () => {
    seedSpace('malformed-jsonl');
    const { events } = new DiskStructuredStore().space('malformed-jsonl');
    const eventFile = eventsPath('malformed-jsonl');
    mkdirSync(path.dirname(eventFile), { recursive: true });
    const eventRaw = `${JSON.stringify({ ts: 1, payload: action('first') })}\nnot-json\n${JSON.stringify({ ts: 2, payload: action('last') })}\n`;
    writeFileSync(eventFile, eventRaw, 'utf8');

    await expect(events.read(1)).rejects.toBeInstanceOf(SyntaxError);

    expect(readFileSync(eventFile, 'utf8')).toBe(eventRaw);
  });

  it('rejects valid JSON with an invalid event shape, including rows outside the limit', async () => {
    seedSpace('invalid-log-shapes');
    const { events } = new DiskStructuredStore().space('invalid-log-shapes');
    const eventFile = eventsPath('invalid-log-shapes');
    mkdirSync(path.dirname(eventFile), { recursive: true });
    const eventRaw = `${JSON.stringify({})}\n${JSON.stringify({ ts: 2, payload: action('last') })}\n`;
    writeFileSync(eventFile, eventRaw, 'utf8');

    await expect(events.read(1)).rejects.toBeInstanceOf(SyntaxError);

    expect(readFileSync(eventFile, 'utf8')).toBe(eventRaw);
  });

  it('validates event append inputs before touching durable bytes', async () => {
    seedSpace('invalid-log-inputs');
    const { events } = new DiskStructuredStore().space('invalid-log-inputs');
    const eventFile = eventsPath('invalid-log-inputs');
    mkdirSync(path.dirname(eventFile), { recursive: true });
    const eventRaw = `${JSON.stringify({ ts: 1, payload: action('first') })}\n`;
    writeFileSync(eventFile, eventRaw, 'utf8');

    await expect(
      events.append([{ ts: 0, payload: action('invalid') }]),
    ).rejects.toBeInstanceOf(TypeError);

    expect(readFileSync(eventFile, 'utf8')).toBe(eventRaw);
  });

  it('preserves a valid unterminated tail and appends on a fresh boundary', async () => {
    seedSpace('valid-tail');
    const { events } = new DiskStructuredStore().space('valid-tail');
    mkdirSync(path.dirname(eventsPath('valid-tail')), { recursive: true });
    writeFileSync(
      eventsPath('valid-tail'),
      JSON.stringify({ ts: 1, payload: action('first') }),
      'utf8',
    );

    await events.append([{ payload: action('second'), ts: 2 }]);

    await expect(events.read()).resolves.toMatchObject([{ ts: 1 }, { ts: 2 }]);
    expect(readFileSync(eventsPath('valid-tail'), 'utf8')).toMatch(/\n$/);
  });

  it('removes a malformed crash tail before the next event append', async () => {
    seedSpace('broken-tail');
    const { events } = new DiskStructuredStore().space('broken-tail');
    mkdirSync(path.dirname(eventsPath('broken-tail')), { recursive: true });
    writeFileSync(
      eventsPath('broken-tail'),
      `${JSON.stringify({ ts: 1, payload: action('first') })}\n{"ts":2`,
      'utf8',
    );

    await expect(events.read(1)).resolves.toMatchObject([{ ts: 1 }]);
    await events.append([{ payload: action('third'), ts: 3 }]);

    expect((await events.read()).map((event) => event.ts)).toEqual([1, 3]);
    expect(readFileSync(eventsPath('broken-tail'), 'utf8')).not.toContain(
      '{"ts":2{"ts":3',
    );
  });
});

describe('Space lifecycle guards and reopen', () => {
  it('does not expose the legacy store through part object properties', () => {
    seedSpace('opaque-adapters');
    const handle = new DiskStructuredStore().space('opaque-adapters');

    for (const part of [
      handle.nodes,
      handle.events,
      handle.changes,
      handle.tasks,
      handle.tasks.runs,
    ]) {
      expect('store' in part).toBe(false);
      expect((part as unknown as { store?: unknown }).store).toBeUndefined();
    }
  });

  it('does not create log or blob directories for a missing Space', async () => {
    const handle = new DiskStructuredStore().space('missing-space');
    const rejectedBuffer = Buffer.from('x');

    await expect(
      handle.events.append([{ payload: action('n1'), ts: 1 }]),
    ).rejects.toThrow(/missing Space/);
    await expect(
      handle.changes.append('thread-1', [change('n1')]),
    ).rejects.toThrow(/missing Space/);
    await expect(
      space('missing-space').blobs.put('x.bin', rejectedBuffer),
    ).rejects.toThrow(/missing Space/);

    expect(rejectedBuffer.toString()).toBe('x');
    expect(existsSync(path.join(root, 'missing-space'))).toBe(false);
  });

  it('drains a Readable when blob admission rejects before delegation', async () => {
    const body = Readable.from([Buffer.from('orphaned request bytes')]);
    const ended = once(body, 'end');

    await expect(
      space('missing-stream-space').blobs.put('x.bin', body),
    ).rejects.toThrow(/missing Space/);
    await ended;

    expect(body.readableEnded).toBe(true);
    expect(existsSync(path.join(root, 'missing-stream-space'))).toBe(false);
  });

  it('round-trips every scoped family after cache reset and reopen', async () => {
    const initial = seedSpace('reopen');
    const first = new DiskStructuredStore().space('reopen');
    await first.write({
      expectedVersion: 0,
      nextRecord: {
        ...initial,
        version: 1,
        state: { nodes: [{ id: 'n1' }], edges: [] },
        updatedAt: 2,
      },
      nodeMutations: [],
    });
    await first.events.append([{ payload: action('n1'), ts: 7 }]);
    const storedChanges = await first.changes.append('thread-1', [
      change('n1'),
    ]);
    await space('reopen').blobs.put('payload.bin', Buffer.from('persisted'));

    resetStorageCache();
    const reopened = new DiskStructuredStore().space('reopen');

    expect((await reopened.read())?.version).toBe(1);
    expect((await reopened.read())?.state.nodes).toEqual([{ id: 'n1' }]);
    expect((await reopened.events.read()).map((event) => event.ts)).toEqual([
      7,
    ]);
    expect(await reopened.changes.read('thread-1')).toEqual(storedChanges);
    expect((await space('reopen').blobs.read('payload.bin'))?.toString()).toBe(
      'persisted',
    );
  });
});
