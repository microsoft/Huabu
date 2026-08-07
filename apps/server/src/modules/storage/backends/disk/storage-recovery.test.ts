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

import { extractCanvasChanges } from '@sediment/shared/canvas-engine';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskStructuredStore } from './structured-store.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import {
  changesPath,
  deltaLogPath,
  eventsPath,
  intentPath,
} from '../../../workspace/disk/paths.js';
import {
  canvasBlobs,
  createStorage,
  setStorageForTesting,
} from '../../storage.js';

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

function delta(version: number) {
  return {
    version,
    ts: 1_000 + version,
    commands: [],
    deltas: [],
    originator: { source: 'agent' as const },
  };
}

function episode(id: string) {
  return {
    id,
    timestamp: 1,
    contextSummary: `ctx-${id}`,
    candidates: [],
    outcome: {
      type: 'selected' as const,
      chosenIndex: 0,
      chosenLabel: id,
    },
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
  root = mkdtempSync(path.join(tmpdir(), 'sediment-storage-recovery-'));
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
      const repository = new DiskStructuredStore().space('unknown-id').record;
      await expect(repository.read()).rejects.toBeInstanceOf(SyntaxError);
      expect(readFileSync(file, 'utf8')).toBe(contents);
    },
  );

  it('does not report malformed or unreadable space.json as not-found', async () => {
    const record = seedSpace('broken-record');
    const repository = new DiskStructuredStore().space('broken-record').record;
    const file = path.join(root, 'broken-record', 'space.json');

    writeFileSync(file, '{"canvasId":', 'utf8');
    await expect(repository.read()).rejects.toBeInstanceOf(SyntaxError);
    await expect(
      repository.compareAndSwap(0, {
        ...record,
        version: 1,
        updatedAt: 2,
      }),
    ).rejects.toBeInstanceOf(SyntaxError);

    rmSync(file);
    mkdirSync(file);
    await expect(repository.read()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(
      repository.compareAndSwap(0, {
        ...record,
        version: 1,
        updatedAt: 2,
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
        new DiskStructuredStore().space('single-record-read').record.read(),
      ).resolves.toEqual(record);
    } finally {
      store.read = originalRead;
    }
  });

  it.each(['null', '[]', '"not a record"'])(
    'rejects a present non-object Space record: %s',
    async (contents) => {
      seedSpace('wrong-record-shape');
      const repository = new DiskStructuredStore().space(
        'wrong-record-shape',
      ).record;
      writeFileSync(
        path.join(root, 'wrong-record-shape', 'space.json'),
        contents,
        'utf8',
      );

      await expect(repository.read()).rejects.toBeInstanceOf(SyntaxError);
    },
  );

  it.each(invalidRecordCases)(
    'rejects persisted Space records with %s before self-heal and preserves the bytes',
    async (_description, buildInvalid) => {
      const record = seedSpace('invalid-persisted-record');
      const repository = new DiskStructuredStore().space(
        'invalid-persisted-record',
      ).record;
      const file = path.join(root, 'invalid-persisted-record', 'space.json');
      const bytes = JSON.stringify(buildInvalid(record));
      writeFileSync(file, bytes, 'utf8');

      await expect(repository.read()).rejects.toBeInstanceOf(SyntaxError);
      await expect(
        repository.compareAndSwap(0, {
          ...record,
          version: 1,
          updatedAt: 2,
        }),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  it('strictly validates an externally renamed Space before title self-heal', async () => {
    const record = seedSpace('renamed-invalid-record');
    const repository = new DiskStructuredStore().space(
      'renamed-invalid-record',
    ).record;
    await expect(repository.read()).resolves.toMatchObject({
      canvasId: 'renamed-invalid-record',
    });
    const movedRoot = path.join(root, 'Finder Renamed');
    renameSync(path.join(root, 'renamed-invalid-record'), movedRoot);
    const file = path.join(movedRoot, 'space.json');
    const bytes = JSON.stringify({ ...record, state: {} });
    writeFileSync(file, bytes, 'utf8');

    await expect(repository.read()).rejects.toBeInstanceOf(SyntaxError);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it.each(invalidRecordCases)(
    'rejects CAS next records with %s and preserves the current bytes',
    async (_description, buildInvalid) => {
      const record = seedSpace('invalid-next-record');
      const repository = new DiskStructuredStore().space(
        'invalid-next-record',
      ).record;
      const file = path.join(root, 'invalid-next-record', 'space.json');
      const bytes = readFileSync(file, 'utf8');

      await expect(
        repository.compareAndSwap(
          0,
          buildInvalid({
            ...record,
            version: 1,
            updatedAt: 2,
          }) as CanvasFile,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  it('does not replace malformed mutable JSON with an empty baseline', async () => {
    seedSpace('broken-mutable');
    const { changes, intents } = new DiskStructuredStore().space(
      'broken-mutable',
    );
    const intentFile = intentPath('broken-mutable');
    const changeFile = changesPath('broken-mutable', 'thread-1');
    mkdirSync(path.dirname(changeFile), { recursive: true });
    writeFileSync(intentFile, '[{"id":"survivor"', 'utf8');
    writeFileSync(changeFile, '[{"id":"survivor"', 'utf8');

    await expect(intents.read()).rejects.toBeInstanceOf(SyntaxError);
    await expect(intents.upsert(episode('replacement'))).rejects.toBeInstanceOf(
      SyntaxError,
    );
    await expect(changes.read('thread-1')).rejects.toBeInstanceOf(SyntaxError);
    await expect(
      changes.append('thread-1', [change('replacement')]),
    ).rejects.toBeInstanceOf(SyntaxError);
    await expect(changes.remove('thread-1', 'survivor')).rejects.toBeInstanceOf(
      SyntaxError,
    );

    expect(readFileSync(intentFile, 'utf8')).toBe('[{"id":"survivor"');
    expect(readFileSync(changeFile, 'utf8')).toBe('[{"id":"survivor"');
  });

  it('uses one strict array value for change and intent reads and mutations', async () => {
    seedSpace('single-array-read');
    const handle = new DiskStructuredStore().space('single-array-read');
    const firstChange = change('n1');
    await handle.changes.append('thread-1', [firstChange]);
    await handle.intents.upsert(episode('e1'));

    const store = getCanvasStore('single-array-read');
    const legacySpies = [
      vi.spyOn(store, 'readChanges'),
      vi.spyOn(store, 'appendChanges'),
      vi.spyOn(store, 'removeChange'),
      vi.spyOn(store, 'readIntents'),
      vi.spyOn(store, 'upsertIntent'),
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
        handle.changes.remove('thread-1', firstChange.id),
      ).resolves.toEqual(firstChange);
      await expect(handle.intents.read()).resolves.toEqual([episode('e1')]);
      await expect(
        handle.intents.upsert(episode('e2')),
      ).resolves.toBeUndefined();
      await expect(handle.intents.read()).resolves.toEqual([
        episode('e1'),
        episode('e2'),
      ]);
    } finally {
      for (const spy of legacySpies) spy.mockRestore();
    }
  });

  it.each(['null', '{}', '"not a list"'])(
    'rejects non-array mutable JSON without overwriting it: %s',
    async (contents) => {
      seedSpace('wrong-mutable-shape');
      const { changes, intents } = new DiskStructuredStore().space(
        'wrong-mutable-shape',
      );
      const intentFile = intentPath('wrong-mutable-shape');
      const changeFile = changesPath('wrong-mutable-shape', 'thread-1');
      mkdirSync(path.dirname(changeFile), { recursive: true });
      writeFileSync(intentFile, contents, 'utf8');
      writeFileSync(changeFile, contents, 'utf8');

      await expect(intents.read()).rejects.toBeInstanceOf(SyntaxError);
      await expect(
        intents.upsert(episode('replacement')),
      ).rejects.toBeInstanceOf(SyntaxError);
      await expect(changes.read('thread-1')).rejects.toBeInstanceOf(
        SyntaxError,
      );
      await expect(
        changes.append('thread-1', [change('replacement')]),
      ).rejects.toBeInstanceOf(SyntaxError);

      expect(readFileSync(intentFile, 'utf8')).toBe(contents);
      expect(readFileSync(changeFile, 'utf8')).toBe(contents);
    },
  );
});

describe('JSONL recovery and ordering', () => {
  it('propagates unreadable event and delta paths instead of returning empty logs', async () => {
    seedSpace('unreadable-events');
    const events = new DiskStructuredStore().space('unreadable-events').events;
    mkdirSync(eventsPath('unreadable-events'), { recursive: true });
    await expect(events.read()).rejects.toMatchObject({
      code: 'EISDIR',
    });

    seedSpace('unreadable-deltas');
    const deltas = new DiskStructuredStore().space('unreadable-deltas').deltas;
    mkdirSync(deltaLogPath('unreadable-deltas'), { recursive: true });
    await expect(deltas.readSince(0)).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('rejects malformed durable JSONL rows without changing either log', async () => {
    seedSpace('malformed-jsonl');
    const { deltas, events } = new DiskStructuredStore().space(
      'malformed-jsonl',
    );
    const eventFile = eventsPath('malformed-jsonl');
    const deltaFile = deltaLogPath('malformed-jsonl');
    mkdirSync(path.dirname(eventFile), { recursive: true });
    const eventRaw = `${JSON.stringify({ ts: 1, payload: action('first') })}\nnot-json\n${JSON.stringify({ ts: 2, payload: action('last') })}\n`;
    const deltaRaw = `${JSON.stringify(delta(1))}\nnot-json\n${JSON.stringify(delta(2))}\n`;
    writeFileSync(eventFile, eventRaw, 'utf8');
    writeFileSync(deltaFile, deltaRaw, 'utf8');

    await expect(events.read(1)).rejects.toBeInstanceOf(SyntaxError);
    await expect(deltas.readSince(0)).rejects.toBeInstanceOf(SyntaxError);
    await expect(deltas.append(delta(3))).rejects.toBeInstanceOf(SyntaxError);

    expect(readFileSync(eventFile, 'utf8')).toBe(eventRaw);
    expect(readFileSync(deltaFile, 'utf8')).toBe(deltaRaw);
  });

  it('rejects valid JSON with invalid event or delta shapes, including rows outside an event limit', async () => {
    seedSpace('invalid-log-shapes');
    const { deltas, events } = new DiskStructuredStore().space(
      'invalid-log-shapes',
    );
    const eventFile = eventsPath('invalid-log-shapes');
    const deltaFile = deltaLogPath('invalid-log-shapes');
    mkdirSync(path.dirname(eventFile), { recursive: true });
    const eventRaw = `${JSON.stringify({})}\n${JSON.stringify({ ts: 2, payload: action('last') })}\n`;
    const deltaRaw = `${JSON.stringify(delta(1))}\n{}\n`;
    writeFileSync(eventFile, eventRaw, 'utf8');
    writeFileSync(deltaFile, deltaRaw, 'utf8');

    await expect(events.read(1)).rejects.toBeInstanceOf(SyntaxError);
    await expect(deltas.readSince(0)).rejects.toBeInstanceOf(SyntaxError);
    await expect(deltas.append(delta(2))).rejects.toBeInstanceOf(SyntaxError);

    expect(readFileSync(eventFile, 'utf8')).toBe(eventRaw);
    expect(readFileSync(deltaFile, 'utf8')).toBe(deltaRaw);
  });

  it('validates event and delta append inputs before touching durable bytes', async () => {
    seedSpace('invalid-log-inputs');
    const { deltas, events } = new DiskStructuredStore().space(
      'invalid-log-inputs',
    );
    const eventFile = eventsPath('invalid-log-inputs');
    const deltaFile = deltaLogPath('invalid-log-inputs');
    mkdirSync(path.dirname(eventFile), { recursive: true });
    const eventRaw = `${JSON.stringify({ ts: 1, payload: action('first') })}\n`;
    const deltaRaw = `${JSON.stringify(delta(1))}\n`;
    writeFileSync(eventFile, eventRaw, 'utf8');
    writeFileSync(deltaFile, deltaRaw, 'utf8');

    await expect(
      events.append([{ ts: 0, payload: action('invalid') }]),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      deltas.append({ ...delta(2), commands: null as unknown as unknown[] }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(readFileSync(eventFile, 'utf8')).toBe(eventRaw);
    expect(readFileSync(deltaFile, 'utf8')).toBe(deltaRaw);
  });

  it('preserves a valid unterminated tail and appends on a fresh boundary', async () => {
    seedSpace('valid-tail');
    const events = new DiskStructuredStore().space('valid-tail').events;
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

  it('removes a malformed crash tail before events and delta appends', async () => {
    seedSpace('broken-tail');
    const { deltas, events } = new DiskStructuredStore().space('broken-tail');
    mkdirSync(path.dirname(eventsPath('broken-tail')), { recursive: true });
    writeFileSync(
      eventsPath('broken-tail'),
      `${JSON.stringify({ ts: 1, payload: action('first') })}\n{"ts":2`,
      'utf8',
    );
    writeFileSync(
      deltaLogPath('broken-tail'),
      `${JSON.stringify(delta(5))}\n{"version":6`,
      'utf8',
    );

    await expect(events.read(1)).resolves.toMatchObject([{ ts: 1 }]);
    await events.append([{ payload: action('third'), ts: 3 }]);
    await expect(deltas.append(delta(4))).rejects.toThrow(/already at 5/);
    await deltas.append(delta(6));

    expect((await events.read()).map((event) => event.ts)).toEqual([1, 3]);
    expect((await deltas.readSince(0)).map((entry) => entry.version)).toEqual([
      5, 6,
    ]);
    expect(readFileSync(eventsPath('broken-tail'), 'utf8')).not.toContain(
      '{"ts":2{"ts":3',
    );
    expect(readFileSync(deltaLogPath('broken-tail'), 'utf8')).not.toContain(
      '{"version":6{"version":6',
    );
  });

  it('uses a valid unterminated delta as the monotonicity baseline', async () => {
    seedSpace('delta-tail');
    const deltas = new DiskStructuredStore().space('delta-tail').deltas;
    mkdirSync(path.dirname(deltaLogPath('delta-tail')), { recursive: true });
    writeFileSync(deltaLogPath('delta-tail'), JSON.stringify(delta(2)), 'utf8');

    await expect(deltas.append(delta(2))).rejects.toThrow(/already at 2/);
    await deltas.append(delta(3));

    expect((await deltas.readSince(0)).map((entry) => entry.version)).toEqual([
      2, 3,
    ]);
  });
});

describe('Space lifecycle guards and reopen', () => {
  it('does not expose the legacy store through repository object properties', () => {
    seedSpace('opaque-adapters');
    const handle = new DiskStructuredStore().space('opaque-adapters');

    for (const repository of [
      handle.record,
      handle.events,
      handle.deltas,
      handle.changes,
      handle.intents,
    ]) {
      expect('store' in repository).toBe(false);
      expect(
        (repository as unknown as { store?: unknown }).store,
      ).toBeUndefined();
    }
  });

  it('does not create log or blob directories for a missing Space', async () => {
    const handle = new DiskStructuredStore().space('missing-space');
    const rejectedBuffer = Buffer.from('x');

    await expect(
      handle.events.append([{ payload: action('n1'), ts: 1 }]),
    ).rejects.toThrow(/missing Space/);
    await expect(handle.deltas.append(delta(1))).rejects.toThrow(
      /missing Space/,
    );
    await expect(handle.intents.upsert(episode('e1'))).rejects.toThrow(
      /missing Space/,
    );
    await expect(
      handle.changes.append('thread-1', [change('n1')]),
    ).rejects.toThrow(/missing Space/);
    await expect(
      canvasBlobs('missing-space').put('x.bin', rejectedBuffer),
    ).rejects.toThrow(/missing Space/);

    expect(rejectedBuffer.toString()).toBe('x');
    expect(existsSync(path.join(root, 'missing-space'))).toBe(false);
  });

  it('drains a Readable when blob admission rejects before delegation', async () => {
    const body = Readable.from([Buffer.from('orphaned request bytes')]);
    const ended = once(body, 'end');

    await expect(
      canvasBlobs('missing-stream-space').put('x.bin', body),
    ).rejects.toThrow(/missing Space/);
    await ended;

    expect(body.readableEnded).toBe(true);
    expect(existsSync(path.join(root, 'missing-stream-space'))).toBe(false);
  });

  it('round-trips every scoped family after cache reset and reopen', async () => {
    const initial = seedSpace('reopen');
    const first = new DiskStructuredStore().space('reopen');
    await first.record.compareAndSwap(0, {
      ...initial,
      version: 1,
      state: { nodes: [{ id: 'n1' }], edges: [] },
      updatedAt: 2,
    });
    await first.events.append([{ payload: action('n1'), ts: 7 }]);
    await first.deltas.append(delta(1));
    await first.intents.upsert(episode('e1'));
    const storedChanges = await first.changes.append('thread-1', [
      change('n1'),
    ]);
    await canvasBlobs('reopen').put('payload.bin', Buffer.from('persisted'));

    resetStorageCache();
    const reopened = new DiskStructuredStore().space('reopen');

    expect((await reopened.record.read())?.version).toBe(1);
    expect((await reopened.record.read())?.state.nodes).toEqual([{ id: 'n1' }]);
    expect((await reopened.events.read()).map((event) => event.ts)).toEqual([
      7,
    ]);
    expect(
      (await reopened.deltas.readSince(0)).map((entry) => entry.version),
    ).toEqual([1]);
    expect((await reopened.intents.read()).map((entry) => entry.id)).toEqual([
      'e1',
    ]);
    expect(await reopened.changes.read('thread-1')).toEqual(storedChanges);
    expect((await canvasBlobs('reopen').read('payload.bin'))?.toString()).toBe(
      'persisted',
    );
  });
});
