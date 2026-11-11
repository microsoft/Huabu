// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reliable save in the headless executor: request ids (a retried call is
 * answered with the stored response instead of being applied again) and the
 * read-version check (a command built on a stale read of the nodes it targets
 * is rejected, and only that command).
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBasis } from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  ExecuteBasisError,
  ExecuteOutcomeUnknownError,
  ExecuteRequestReusedError,
  executeOnServer,
  type ExecuteOnServerInput,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import { importForeignNodeSources } from './import-node-src.js';
import { getCanvasStore, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type * as ImportNodeSrcModule from './import-node-src.js';
import type * as StorageModule from '../storage/index.js';
import type {
  CanvasCommand,
  CanvasSyncEvent,
  ExecuteOriginator,
} from '@huabu/shared';

/** Storage faults a test can switch on for the executor's Space handle. */
const faults = vi.hoisted(() => ({
  write: null as
    | null
    | ((real: (input: never) => Promise<unknown>, input: never) => unknown),
  record: null as
    | null
    | ((real: (input: never) => Promise<unknown>, input: never) => unknown),
  lookup: null as null | ((real: () => Promise<unknown>) => unknown),
}));

vi.mock('../storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return {
    ...actual,
    space: (canvasId: string) => {
      const handle = actual.space(canvasId);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'write' && faults.write) {
            const fault = faults.write;
            return (input: never) =>
              fault((value) => target.write(value), input);
          }
          if (property === 'save' && (faults.lookup || faults.record)) {
            const { lookup, record } = faults;
            const save = target.save;
            return {
              stamps: () => save.stamps(),
              record: (input: never) =>
                record
                  ? record((value) => save.record(value), input)
                  : save.record(input),
              lookup: (key: never) =>
                lookup ? lookup(() => save.lookup(key)) : save.lookup(key),
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
});

vi.mock('./import-node-src.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportNodeSrcModule>();
  return {
    ...actual,
    importForeignNodeSources: vi.fn(actual.importForeignNodeSources),
  };
});

const CANVAS = 'c1';
const UI: ExecuteOriginator = { source: 'ui' };
const AGENT: ExecuteOriginator = { source: 'agent' };
const PRINCIPAL = 'user:alice';

let tmp: string;
const originalDataDir = process.env.HUABU_DATA_DIR;
let events: CanvasSyncEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-reliable-'));
  process.env.HUABU_DATA_DIR = tmp;
  setWorkspacePath(tmp);
  faults.write = null;
  faults.lookup = null;
  faults.record = null;
  vi.mocked(importForeignNodeSources).mockClear();
  events = [];
  unsubscribe = subscribeCanvasUpdates(CANVAS, (event) => events.push(event));
});

afterEach(() => {
  unsubscribe();
  if (originalDataDir === undefined) {
    delete process.env.HUABU_DATA_DIR;
  } else {
    process.env.HUABU_DATA_DIR = originalDataDir;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const NOTES = ['a', 'b', 'c'] as const;

/** Two root frames (`f1`, `f2`) and three root notes (`a`, `b`, `c`). */
function seed(): void {
  const store = getCanvasStore(CANVAS);
  const frame = (id: string, x: number) => ({
    id,
    type: 'frame',
    position: { x, y: 400 },
    style: { width: 300, height: 300 },
    data: { label: id, sizing: 'manual' },
  });
  store.write({
    canvasId: CANVAS,
    title: null,
    version: 1,
    state: {
      nodes: [
        frame('f1', 0),
        frame('f2', 600),
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  for (const id of ['f1', 'f2']) {
    store.writeNode(id, { nodeId: id, type: 'frame', label: id, content: '' });
  }
  for (const id of NOTES) {
    store.writeNode(id, {
      nodeId: id,
      type: 'note',
      label: id.toUpperCase(),
      content: `${id} body`,
    });
  }
}

function cmds(...commands: unknown[]): CanvasCommand[] {
  return commands as CanvasCommand[];
}

function run(
  commands: CanvasCommand[],
  extra: Partial<ExecuteOnServerInput> = {},
): Promise<ExecuteOnServerOutput> {
  return executeOnServer({
    canvasId: CANVAS,
    commands,
    originator: UI,
    ...extra,
  });
}

function requestOf(operationId: string = randomUUID()) {
  return { operationId, principalId: PRINCIPAL };
}

async function nodesNow(): Promise<
  Array<{ id: string; parentId?: string; position: { x: number; y: number } }>
> {
  const record = await space(CANVAS).read();
  return (record?.state.nodes ?? []) as never;
}

async function versionNow(): Promise<number> {
  return (await space(CANVAS).read())?.version ?? -1;
}

function deltaRows(): Array<{ version: number; runId?: string }> {
  const path = join(tmp, CANVAS, '.history', 'delta-log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Every file below `<space>/.history/save/results`, if any. */
function resultFiles(): string[] {
  const dir = join(tmp, CANVAS, '.history', 'save', 'results');
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** The read version of the Space as it is now. */
async function basisNow(): Promise<string> {
  const stamps = await space(CANVAS).save.stamps();
  if (!stamps) throw new Error('Space is missing');
  return encodeBasis(stamps.lineage, stamps.version);
}

const createNote = (label: string, id?: string) => ({
  type: 'CREATE_NODES',
  nodes: [
    {
      ...(id ? { id } : {}),
      nodeType: 'note',
      position: { x: 0, y: 900 },
      size: { width: 200, height: 100 },
      data: { label, content: `${label} body` },
    },
  ],
});

describe('request ids', () => {
  it('answers a retry with the stored response instead of applying it twice', async () => {
    seed();
    const request = requestOf();
    const input = {
      originator: AGENT,
      request,
      issueBasis: true,
    } satisfies Partial<ExecuteOnServerInput>;

    const first = await run(cmds(createNote('New')), input);
    const second = await run(cmds(createNote('New')), input);

    expect(first.replayed).toBeUndefined();
    expect(first.toVersion).toBe(2);
    expect(first.operationId).toBe(request.operationId);
    expect(first.runId).toEqual(expect.any(String));
    expect(first.results[0]?.nodes).toHaveLength(1);
    expect(second).toEqual({ ...first, replayed: true });
    expect(second.results[0]?.nodes?.[0]?.nodeId).toBe(
      first.results[0]?.nodes?.[0]?.nodeId,
    );
    // What callers read off the output survives the round trip.
    expect(second).toEqual(JSON.parse(JSON.stringify(second)));

    expect(await nodesNow()).toHaveLength(6);
    expect(await versionNow()).toBe(2);
    const rows = deltaRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 2, runId: first.runId });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'update',
      data: { toVersion: 2, operationId: request.operationId },
    });
    expect(importForeignNodeSources).toHaveBeenCalledTimes(1);
    expect(first.basis).toBe(await basisNow());
  });

  it('treats request ids case-insensitively and keeps the original run id', async () => {
    seed();
    const operationId = randomUUID();
    const first = await run(cmds(createNote('New')), {
      request: requestOf(operationId.toUpperCase()),
      runId: 'run-first',
    });
    const second = await run(cmds(createNote('New')), {
      request: requestOf(operationId),
      runId: 'run-second',
    });

    expect(first.operationId).toBe(operationId);
    expect(second.replayed).toBe(true);
    expect(second.runId).toBe('run-first');
    expect(await nodesNow()).toHaveLength(6);
  });

  it('keeps request ids apart per principal', async () => {
    seed();
    const operationId = randomUUID();
    await run(cmds(createNote('New')), { request: requestOf(operationId) });
    const other = await run(cmds(createNote('New')), {
      request: { operationId, principalId: 'user:bob' },
    });

    expect(other.replayed).toBeUndefined();
    expect(await nodesNow()).toHaveLength(7);
  });

  it('refuses a request id reused for a different request', async () => {
    seed();
    const request = requestOf();
    await run(cmds(createNote('New')), { request });

    await expect(
      run(cmds(createNote('Other')), { request }),
    ).rejects.toBeInstanceOf(ExecuteRequestReusedError);
    await expect(
      run(cmds(createNote('New')), { request, basis: await basisNow() }),
    ).rejects.toBeInstanceOf(ExecuteRequestReusedError);
    await expect(
      run(cmds(createNote('New')), { request, originator: AGENT }),
    ).rejects.toBeInstanceOf(ExecuteRequestReusedError);

    expect(await nodesNow()).toHaveLength(6);
    expect(events).toHaveLength(1);
  });

  it('replays a batch that changed nothing, without bumping the version', async () => {
    seed();
    const request = requestOf();
    const command = cmds({ type: 'DELETE_NODES', nodeIds: ['ghost'] });

    const first = await run(command, { request });
    expect(first.toVersion).toBe(first.fromVersion);
    expect(first.results[0]?.applied).toBe(false);
    expect(await versionNow()).toBe(1);

    // The Space moves on; the same request would now delete something.
    await run(cmds(createNote('Ghost', 'ghost')));
    const second = await run(command, { request });

    expect(second).toEqual({ ...first, replayed: true });
    expect((await nodesNow()).map((node) => node.id)).toContain('ghost');
    expect(await versionNow()).toBe(2);
    expect(events).toHaveLength(1);
  });

  it('replays a content conflict', async () => {
    seed();
    const request = requestOf();
    const command = cmds({
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: 'a', patch: { content: 'rewritten' } }],
    });

    const first = await run(command, { request, originator: AGENT });
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts?.[0]).toMatchObject({
      nodeId: 'a',
      reason: 'not-read',
      currentContent: 'a body',
    });

    const second = await run(command, { request, originator: AGENT });
    expect(second).toEqual({ ...first, replayed: true });
    expect(await versionNow()).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('stores nothing and adds nothing when no request id is given', async () => {
    seed();
    const out = await run(cmds(createNote('New')));
    const noop = await run(cmds({ type: 'DELETE_NODES', nodeIds: ['ghost'] }));

    for (const output of [out, noop]) {
      expect(output).not.toHaveProperty('operationId');
      expect(output).not.toHaveProperty('basis');
      expect(output).not.toHaveProperty('runId');
      expect(output).not.toHaveProperty('replayed');
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.data).not.toHaveProperty('operationId');
    expect(deltaRows()[0]).not.toHaveProperty('runId');
    expect(resultFiles()).toEqual([]);
    expect(existsSync(join(tmp, CANVAS, '.history', 'save'))).toBe(false);
  });

  it('runs concurrent duplicates once', async () => {
    seed();
    const request = requestOf();
    const input = { request, originator: AGENT };

    const outputs = await Promise.all([
      run(cmds(createNote('New')), input),
      run(cmds(createNote('New')), input),
      run(cmds(createNote('New')), input),
    ]);

    expect(outputs.filter((output) => output.replayed)).toHaveLength(2);
    const [original] = outputs.filter((output) => !output.replayed);
    for (const output of outputs) {
      expect(output).toEqual({ ...original, replayed: output.replayed });
    }
    expect(await nodesNow()).toHaveLength(6);
    expect(deltaRows()).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(importForeignNodeSources).toHaveBeenCalledTimes(1);
    expect(resultFiles()).toHaveLength(1);
  });

  it('lets a retry run when the first attempt threw without saving', async () => {
    seed();
    const request = requestOf();
    await expect(
      run(cmds(createNote('New')), { request, basis: 'not-a-basis' }),
    ).rejects.toBeInstanceOf(ExecuteBasisError);
    expect(resultFiles()).toEqual([]);

    faults.write = () => {
      throw new Error('disk full');
    };
    await expect(run(cmds(createNote('New')), { request })).rejects.toThrow(
      'disk full',
    );
    faults.write = null;

    const retry = await run(cmds(createNote('New')), { request });
    expect(retry.replayed).toBeUndefined();
    expect(retry.toVersion).toBe(2);
    expect(await nodesNow()).toHaveLength(6);
  });

  it('saves without a result record when the response is too large', async () => {
    seed();
    const request = requestOf();
    const big = {
      type: 'MERGE_NODE_DATA',
      patches: [
        { nodeId: 'a', patch: { content: 'x'.repeat(3 * 1024 * 1024) } },
      ],
    };

    const out = await run(cmds(big), { request });

    expect(out.toVersion).toBe(2);
    expect(out.operationId).toBe(request.operationId);
    expect(await space(CANVAS).save.lookup(request)).toBeNull();
    expect(resultFiles()).toEqual([]);
  });
});

describe('storage failures with a request id', () => {
  it('rethrows the original error when nothing was saved', async () => {
    seed();
    const request = requestOf();
    faults.write = () => {
      throw new Error('disk full');
    };

    await expect(run(cmds(createNote('New')), { request })).rejects.toThrow(
      'disk full',
    );
    expect(await versionNow()).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('reports an unknown outcome when the result cannot be looked up either', async () => {
    seed();
    const request = requestOf();
    let lookups = 0;
    faults.write = () => {
      throw new Error('connection lost');
    };
    faults.lookup = (real) => {
      lookups += 1;
      // Entry point and in-mutex lookups succeed; the one after the failed
      // write does not.
      if (lookups <= 2) return real();
      throw new Error('connection still lost');
    };

    const failure = await run(cmds(createNote('New')), { request }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ExecuteOutcomeUnknownError);
    expect((failure as ExecuteOutcomeUnknownError).cause).toMatchObject({
      message: 'connection lost',
    });
    expect(events).toHaveLength(0);
  });

  it('finishes as a success when the write landed but its reply was lost', async () => {
    seed();
    const request = requestOf();
    faults.write = async (real, input) => {
      await real(input);
      throw new Error('reply lost');
    };

    const first = await run(cmds(createNote('New')), { request });
    faults.write = null;

    expect(first.replayed).toBeUndefined();
    expect(first.toVersion).toBe(2);
    expect(await versionNow()).toBe(2);
    expect(events).toHaveLength(1);

    const second = await run(cmds(createNote('New')), { request });
    expect(second).toEqual({ ...first, replayed: true });
    expect(await nodesNow()).toHaveLength(6);
    expect(events).toHaveLength(1);
  });

  it('keeps today’s error for a failed write without a request id', async () => {
    seed();
    faults.write = () => {
      throw new Error('disk full');
    };
    faults.lookup = () => {
      throw new Error('lookup must not be called');
    };

    await expect(run(cmds(createNote('New')))).rejects.toThrow('disk full');
  });

  it('settles a failed record of an unchanged batch the same way', async () => {
    seed();
    const ghost = cmds({ type: 'DELETE_NODES', nodeIds: ['ghost'] });

    // Not stored: the original error.
    faults.record = () => {
      throw new Error('disk full');
    };
    await expect(run(ghost, { request: requestOf() })).rejects.toThrow(
      'disk full',
    );

    // Stored, reply lost: the outcome it was.
    const request = requestOf();
    faults.record = async (real, input) => {
      await real(input);
      throw new Error('reply lost');
    };
    const first = await run(ghost, { request });
    expect(first.replayed).toBeUndefined();
    expect(first.results).toMatchObject([{ applied: false }]);
    faults.record = null;
    expect(await run(ghost, { request })).toEqual({ ...first, replayed: true });

    // Cannot tell: unknown.
    faults.record = () => {
      throw new Error('connection lost');
    };
    let lookups = 0;
    faults.lookup = (real) => {
      lookups += 1;
      if (lookups <= 2) return real();
      throw new Error('connection still lost');
    };
    await expect(run(ghost, { request: requestOf() })).rejects.toBeInstanceOf(
      ExecuteOutcomeUnknownError,
    );
    expect(await versionNow()).toBe(1);
  });
});

describe('read version', () => {
  const reparentA = () =>
    run(cmds({ type: 'SET_NODE_PARENT', nodeIds: ['a'], parentId: 'f1' }));

  it('issues the read version of the state a call leaves behind', async () => {
    seed();
    const written = await run(cmds(createNote('New')), { issueBasis: true });
    expect(written.basis).toBe(await basisNow());
    expect(written).not.toHaveProperty('operationId');

    const unchanged = await run(
      cmds({ type: 'DELETE_NODES', nodeIds: ['ghost'] }),
      { issueBasis: true },
    );
    expect(unchanged.basis).toBe(written.basis);
  });

  it('refuses a read version this Space did not issue', async () => {
    seed();
    const basis = await basisNow();
    const [, lineage, version] = basis.split('.');
    const command = cmds(createNote('New'));

    for (const unknown of [
      'garbage',
      encodeBasis(randomUUID(), Number(version)),
      encodeBasis(lineage as string, Number(version) + 1),
    ]) {
      await expect(run(command, { basis: unknown })).rejects.toBeInstanceOf(
        ExecuteBasisError,
      );
    }
    expect(await versionNow()).toBe(1);
  });

  it('rejects a command whose target was deleted', async () => {
    seed();
    const basis = await basisNow();
    await run(cmds({ type: 'DELETE_NODES', nodeIds: ['a'] }));

    const out = await run(
      cmds({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'a', patch: { label: 'Renamed' } }],
      }),
      { basis },
    );

    expect(out.results).toMatchObject([
      { applied: false, reason: 'stale-target' },
    ]);
    expect(out.toVersion).toBe(out.fromVersion);
  });

  it('rejects a command whose target id was deleted and created again', async () => {
    seed();
    const basis = await basisNow();
    await run(cmds({ type: 'DELETE_NODES', nodeIds: ['a'] }));
    await run(cmds(createNote('Impostor', 'a')));

    const out = await run(
      cmds({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'a', patch: { label: 'Renamed' } }],
      }),
      { basis },
    );

    expect(out.results).toMatchObject([
      { applied: false, reason: 'stale-target' },
    ]);
    // Read again and the same command applies.
    const again = await run(
      cmds({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'a', patch: { label: 'Renamed' } }],
      }),
      { basis: await basisNow() },
    );
    expect(again.results[0]?.applied).toBe(true);
  });

  it.each([
    [
      'SET_NODE_GEOMETRY',
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'a', position: { x: 50, y: 50 } }],
      },
    ],
    [
      'SET_NODE_PARENT',
      { type: 'SET_NODE_PARENT', nodeIds: ['a'], parentId: 'f2' },
    ],
    ['REORDER_NODES', { type: 'REORDER_NODES', nodeIds: ['a'], to: 'top' }],
    [
      'REORDER_NODES relative to a moved node',
      { type: 'REORDER_NODES', nodeIds: ['b'], to: { before: 'a' } },
    ],
    [
      'ALIGN_NODES',
      { type: 'ALIGN_NODES', nodeIds: ['a', 'b'], direction: 'top' },
    ],
    [
      'DISTRIBUTE_NODES',
      { type: 'DISTRIBUTE_NODES', nodeIds: ['a', 'b', 'c'] },
    ],
  ])(
    'rejects %s after a target was moved to another parent',
    async (_name, command) => {
      seed();
      const basis = await basisNow();
      expect((await reparentA()).results[0]?.applied).toBe(true);
      const before = await nodesNow();

      const stale = await run(cmds(command), { basis });

      expect(stale.results).toMatchObject([
        { applied: false, reason: 'stale-parent' },
      ]);
      expect(stale.toVersion).toBe(stale.fromVersion);
      expect(await nodesNow()).toEqual(before);

      // The check is on the read version, not on the command.
      const fresh = await run(cmds(command), { basis: await basisNow() });
      expect(fresh.results[0]?.reason).not.toBe('stale-parent');
      expect(fresh.results[0]?.reason).not.toBe('stale-target');
    },
  );

  it('applies geometry when others changed the node but not its parent', async () => {
    seed();
    const basis = await basisNow();
    await run(
      cmds({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'a', patch: { label: 'Renamed by another' } }],
      }),
    );
    await run(
      cmds({
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'b', position: { x: 777, y: 0 } }],
      }),
    );

    const out = await run(
      cmds({
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'a', position: { x: 50, y: 60 } }],
      }),
      { basis },
    );

    expect(out.results).toMatchObject([{ applied: true }]);
    expect(out.toVersion).toBe(4);
    expect(
      (await nodesNow()).find((node) => node.id === 'a')?.position,
    ).toEqual({ x: 50, y: 60 });
  });

  it('applies a data merge after the node was moved to another parent', async () => {
    seed();
    const basis = await basisNow();
    await reparentA();

    const out = await run(
      cmds({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'a', patch: { label: 'Still mine' } }],
      }),
      { basis },
    );

    expect(out.results).toMatchObject([{ applied: true }]);
    expect((await nodesNow()).find((node) => node.id === 'a')?.parentId).toBe(
      'f1',
    );
  });

  it('keeps the content revision check independent of the read version', async () => {
    seed();
    const basis = await basisNow();
    const rev = nodeRevisionOf({ content: 'a body', src: undefined });
    await reparentA();

    const out = await run(
      cmds({
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: 'a', patch: { content: 'rewritten' }, expectRev: rev },
        ],
      }),
      { basis, originator: AGENT },
    );

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(out.results).toMatchObject([{ applied: true }]);
  });

  it('never checks creating or connecting nodes', async () => {
    seed();
    const basis = await basisNow();
    await reparentA();
    await run(cmds(createNote('Later', 'later')));

    const out = await run(
      cmds(createNote('New', 'fresh'), {
        type: 'CONNECT_NODES',
        edges: [
          { source: 'a', target: 'later' },
          { source: 'fresh', target: 'b' },
        ],
      }),
      { basis },
    );

    expect(out.results).toMatchObject([{ applied: true }, { applied: true }]);
    expect(out.results[1]?.edges).toHaveLength(2);
  });

  it('never treats a node created earlier in the same batch as stale', async () => {
    seed();
    const basis = await basisNow();
    await run(cmds(createNote('Unrelated')));

    const out = await run(
      cmds(
        createNote('New', 'fresh'),
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'fresh', position: { x: 10, y: 950 } }],
        },
        { type: 'SET_NODE_PARENT', nodeIds: ['fresh'], parentId: 'f2' },
        { type: 'REORDER_NODES', nodeIds: ['fresh'], to: 'top' },
      ),
      { basis },
    );

    expect(out.results.map((result) => result.reason)).not.toContain(
      'stale-target',
    );
    expect(out.results.map((result) => result.reason)).not.toContain(
      'stale-parent',
    );
    expect(out.results.slice(0, 3)).toMatchObject([
      { applied: true },
      { applied: true },
      { applied: true },
    ]);
    expect(
      (await nodesNow()).find((node) => node.id === 'fresh')?.parentId,
    ).toBe('f2');
  });

  it('does not count what the batch itself did to a node against it', async () => {
    seed();
    const basis = await basisNow();

    const out = await run(
      cmds(
        { type: 'SET_NODE_PARENT', nodeIds: ['a'], parentId: 'f1' },
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'a', position: { x: 20, y: 20 } }],
        },
      ),
      { basis },
    );

    expect(out.results).toMatchObject([{ applied: true }, { applied: true }]);
  });

  it('commits the accepted commands of a partly stale batch once', async () => {
    seed();
    const basis = await basisNow();
    await reparentA();
    const request = requestOf();

    const out = await run(
      cmds(
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'a', position: { x: 50, y: 50 } }],
        },
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'b', patch: { label: 'Renamed' } }],
        },
        { type: 'DELETE_NODES', nodeIds: ['ghost'] },
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'c', position: { x: 900, y: 10 } }],
        },
      ),
      { basis, request, issueBasis: true },
    );

    expect(out.results).toMatchObject([
      { applied: false, reason: 'stale-parent' },
      { applied: true },
      { applied: false, reason: 'stale-target' },
      { applied: true },
    ]);
    expect(out.fromVersion).toBe(2);
    expect(out.toVersion).toBe(3);
    expect(await versionNow()).toBe(3);
    expect(deltaRows().map((row) => row.version)).toEqual([2, 3]);
    expect(events).toHaveLength(2);
    expect(out.basis).toBe(await basisNow());

    const nodes = await nodesNow();
    expect(nodes.find((node) => node.id === 'c')?.position).toEqual({
      x: 900,
      y: 10,
    });
    expect(nodes.find((node) => node.id === 'a')?.parentId).toBe('f1');
  });

  it('applies the same batch unchecked when no read version is given', async () => {
    seed();
    await reparentA();

    const out = await run(
      cmds({
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'a', position: { x: 50, y: 50 } }],
      }),
    );

    expect(out.results).toMatchObject([{ applied: true }]);
  });
});
