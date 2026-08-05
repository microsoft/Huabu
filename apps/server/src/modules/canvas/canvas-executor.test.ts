/**
 * Compare-and-swap (optimistic concurrency) tests for the headless
 * executor's `MERGE_NODE_DATA` content path.
 *
 * Covers the Phase 2 write guard: agent-originated content rewrites must
 * carry an `expectRev` matching the node's current authored-content
 * revision; ui / system writes are unconditional; non-content patches
 * (label only) are never guarded.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@sediment/shared/canvas-engine';

import { applyDeltasOnServer, executeOnServer } from './canvas-executor.js';
import { runCanvasPersistenceTransaction } from './canvas-persistence-transaction.js';
import {
  applyNodeUpdate,
  canvasBlobs,
  getCanvasStore,
} from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand, ExecuteOriginator } from '@sediment/shared';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-cas-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a Space with one note (topology entry + `.md` body). */
function seedNote(canvasId: string, id: string, content: string): void {
  const store = getCanvasStore(canvasId);
  store.write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [
        { id, type: 'note', position: { x: 0, y: 0 }, data: { label: 'A' } },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode(id, { nodeId: id, type: 'note', label: 'A', content });
}

/** Current authored-content rev, computed exactly as the executor does. */
function currentRev(canvasId: string, id: string): string {
  const nc = getCanvasStore(canvasId).readNode(id);
  return nodeRevisionOf({
    content: nc?.content,
    src: typeof nc?.src === 'string' ? nc.src : undefined,
  });
}

function bodyOf(canvasId: string, id: string): string | undefined {
  return getCanvasStore(canvasId).readNode(id)?.content ?? undefined;
}

function imageStyleOf(
  canvasId: string,
  nodeId: string,
): { width?: unknown; height?: unknown } {
  const canvas = getCanvasStore(canvasId).read();
  const nodes = (canvas?.state.nodes ?? []) as Array<{
    id?: unknown;
    style?: unknown;
  }>;
  const node = nodes.find((n) => n.id === nodeId);
  return ((node as { style?: unknown } | undefined)?.style ?? {}) as Record<
    string,
    unknown
  >;
}

function mergeContent(
  nodeId: string,
  content: string,
  expectRev?: string,
): CanvasCommand {
  return {
    type: 'MERGE_NODE_DATA',
    patches: [
      { nodeId, patch: { content }, ...(expectRev ? { expectRev } : {}) },
    ],
  } as unknown as CanvasCommand;
}

const AGENT: ExecuteOriginator = { source: 'agent' };
const UI: ExecuteOriginator = { source: 'ui' };

describe('executeOnServer — MERGE_NODE_DATA CAS', () => {
  it('applies an agent write whose expectRev matches the current rev', async () => {
    seedNote('c1', 'n1', 'hello');
    const rev = currentRev('c1', 'n1');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world', rev)],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(out.toVersion).toBe(out.fromVersion + 1);
    expect(bodyOf('c1', 'n1')).toBe('world');
  });

  it('rejects an agent write with a stale expectRev — nothing mutates', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world', 'staleRev')],
      originator: AGENT,
    });

    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts?.[0]).toMatchObject({
      nodeId: 'n1',
      reason: 'stale',
      expectedRev: 'staleRev',
      currentContent: 'hello',
    });
    expect(out.toVersion).toBe(out.fromVersion); // no version bump
    expect(bodyOf('c1', 'n1')).toBe('hello'); // body untouched
    expect(out.results.every((r) => !r.applied)).toBe(true);
  });

  it('rejects an agent content write with NO expectRev (never read)', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world')],
      originator: AGENT,
    });

    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts?.[0]?.reason).toBe('not-read');
    expect(out.conflicts?.[0]?.expectedRev).toBeUndefined();
    expect(bodyOf('c1', 'n1')).toBe('hello');
  });

  it('allows a ui write with no expectRev (trusted, unconditional)', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world')],
      originator: UI,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(bodyOf('c1', 'n1')).toBe('world');
  });

  it('does not guard a label-only agent patch (outside the rev key set)', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'n1', patch: { label: 'Renamed' } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(bodyOf('c1', 'n1')).toBe('hello');
  });

  it('does not guard a src-only agent write (media pointer, never read)', async () => {
    // A media node's `src` is a short pointer reached via the artifact it
    // points at, never via a `nodes/<label>.md` read — so the read-set never
    // holds its rev. Guarding it would reject every legit `src` rewrite as
    // `not-read`; `src` writes are therefore unconditional, like ui writes.
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'm1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Pic', src: 'artifacts/old.png' },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('m1', {
      nodeId: 'm1',
      type: 'image',
      label: 'Pic',
      src: 'artifacts/old.png',
      content: '',
    });

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'm1', patch: { src: 'artifacts/new.png' } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(out.toVersion).toBe(out.fromVersion + 1);
    expect(getCanvasStore('c1').readNode('m1')?.src).toBe('artifacts/new.png');
  });

  it('auto-updates image height when MERGE_NODE_DATA rewrites src', async () => {
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'm1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Pic', src: 'old.svg' },
            style: { width: 300, height: 300 },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('m1', {
      nodeId: 'm1',
      type: 'image',
      label: 'Pic',
      src: 'old.svg',
      content: '',
    });
    await canvasBlobs('c1').put(
      'new.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>',
      ),
    );

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'm1', patch: { src: 'new.svg' } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(getCanvasStore('c1').readNode('m1')?.src).toBe('new.svg');
    const style = imageStyleOf('c1', 'm1');
    expect(style.width).toBe(300);
    expect(style.height).toBe(150);
    expect(out.results[0]?.nodes).toEqual([
      { nodeId: 'm1', width: 300, height: 150, src: 'new.svg' },
    ]);
  });

  it('recomputes image height when SET_NODE_GEOMETRY pins a mismatched size', async () => {
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'g1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Pic', src: 'pic.svg' },
            style: { width: 400, height: 300 },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('g1', {
      nodeId: 'g1',
      type: 'image',
      label: 'Pic',
      src: 'pic.svg',
      content: '',
    });
    await canvasBlobs('c1').put(
      'pic.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>',
      ),
    );

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'g1', size: { width: 500, height: 500 } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    const style = imageStyleOf('c1', 'g1');
    expect(style.width).toBe(500);
    expect(style.height).toBe(250);
  });
});

describe('executeOnServer — CREATE_NODES id echo', () => {
  it('echoes the server-assigned id and label of every created node', async () => {
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: { nodes: [], edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'note',
              position: { x: 0, y: 0 },
              data: { label: 'Finding A', content: 'a' },
            },
            {
              nodeType: 'note',
              position: { x: 200, y: 0 },
              data: { label: 'Finding B', content: 'b' },
            },
          ],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.results[0]?.applied).toBe(true);
    const echoed = out.results[0]?.nodes ?? [];
    expect(echoed).toHaveLength(2);
    // Ids are server-assigned (agent omitted them) and unique.
    expect(echoed[0]?.nodeId).toMatch(/^node-/);
    expect(echoed[1]?.nodeId).toMatch(/^node-/);
    expect(echoed[0]?.nodeId).not.toBe(echoed[1]?.nodeId);
    // Labels are echoed so the agent can correlate ids to intent.
    expect(echoed.map((n) => n.label)).toEqual(['Finding A', 'Finding B']);
  });
});

describe('executeOnServer — batch node writes route through the non-locking core', () => {
  it('persists every node in a multi-node batch without self-deadlocking on the canvas lock', async () => {
    // The executor holds `withCanvasMutex` for the WHOLE batch and writes each
    // mutated node's `.md` via the NON-locking `applyNodeUpdate`. The
    // promise-chain mutex is not re-entrant, so if any per-node write went
    // through the locking `updateNode` instead, this batch would deadlock and
    // the test would hang until vitest's timeout. Two mutated nodes under one
    // lock is the minimal case that pins that contract.
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'n1',
            type: 'note',
            position: { x: 0, y: 0 },
            data: { label: 'A' },
          },
          {
            id: 'n2',
            type: 'note',
            position: { x: 200, y: 0 },
            data: { label: 'B' },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('n1', {
      nodeId: 'n1',
      type: 'note',
      label: 'A',
      content: 'a1',
    });
    store.writeNode('n2', {
      nodeId: 'n2',
      type: 'note',
      label: 'B',
      content: 'b1',
    });
    const batchGuard = vi.spyOn(store, 'withValidatedNodeMutationTransaction');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            { nodeId: 'n1', patch: { content: 'a2' } },
            { nodeId: 'n2', patch: { content: 'b2' } },
          ],
        } as unknown as CanvasCommand,
      ],
      originator: UI,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    // The aggregate is strictly checked once for the executor's synchronous
    // sidecar section, rather than reparsed once per write (O(nodes²)).
    expect(batchGuard).toHaveBeenCalledTimes(1);
    // Both `.md` sidecars landed — the batch completed, so no deadlock.
    expect(bodyOf('c1', 'n1')).toBe('a2');
    expect(bodyOf('c1', 'n2')).toBe('b2');
  });
});

describe('executor tombstone resurrection', () => {
  function restoredNode(content = 'restored') {
    return {
      id: 'n1',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { label: 'A', content },
    };
  }

  async function deleteSeededNode() {
    seedNote('c1', 'n1', 'before');
    await executeOnServer({
      canvasId: 'c1',
      commands: [
        { type: 'DELETE_NODES', nodeIds: ['n1'] } as unknown as CanvasCommand,
      ],
      originator: UI,
    });
    const store = getCanvasStore('c1');
    expect(store.readNode('n1')).toBeNull();
    expect(store.isNodeWriteSuppressed('n1')).toBe(true);
    return store;
  }

  it('restores a just-deleted sidecar on an INSERT delta revert', async () => {
    const store = await deleteSeededNode();

    const out = await applyDeltasOnServer({
      canvasId: 'c1',
      deltas: [{ type: 'INSERT_NODE', node: restoredNode() }],
      originator: UI,
    });

    expect(out.deltas.map((delta) => delta.type)).toEqual(['INSERT_NODE']);
    expect(store.readNode('n1')?.content).toBe('restored');
    expect(store.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('lets an intentional CREATE_NODES reuse a just-deleted id', async () => {
    const store = await deleteSeededNode();

    await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'n1',
              nodeType: 'note',
              position: { x: 0, y: 0 },
              data: { label: 'A', content: 'created again' },
            },
          ],
        } as unknown as CanvasCommand,
      ],
      originator: UI,
    });

    expect(store.readNode('n1')?.content).toBe('created again');
    expect(store.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('keeps the recreated sidecar for DELETE then CREATE in one batch', async () => {
    seedNote('c1', 'n1', 'before');
    const store = getCanvasStore('c1');

    await executeOnServer({
      canvasId: 'c1',
      commands: [
        { type: 'DELETE_NODES', nodeIds: ['n1'] } as unknown as CanvasCommand,
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'n1',
              nodeType: 'note',
              position: { x: 0, y: 0 },
              data: { label: 'A', content: 'same-batch recreate' },
            },
          ],
        } as unknown as CanvasCommand,
      ],
      originator: UI,
    });

    expect(store.readNode('n1')?.content).toBe('same-batch recreate');
    expect(store.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('rejects a non-ok sidecar outcome and rolls topology back', async () => {
    const store = await deleteSeededNode();
    const originalWriteNode = store.writeNode;
    store.writeNode = () => ({ ok: false, reason: 'not-found' });
    try {
      await expect(
        applyDeltasOnServer({
          canvasId: 'c1',
          deltas: [{ type: 'INSERT_NODE', node: restoredNode() }],
          originator: UI,
        }),
      ).rejects.toThrow(/writeNode rejected n1: not-found/);
    } finally {
      store.writeNode = originalWriteNode;
    }

    expect(store.read()?.state.nodes).toEqual([]);
    expect(store.readNode('n1')).toBeNull();
    expect(store.isNodeWriteSuppressed('n1')).toBe(true);
  });

  it('retains the prior tombstone when delta append fails after resurrection', async () => {
    const store = await deleteSeededNode();
    const originalAppend = store.appendDeltaLogEntry;
    store.appendDeltaLogEntry = (entry) => {
      originalAppend.call(store, entry);
      throw new Error('injected resurrection append failure');
    };
    try {
      await expect(
        applyDeltasOnServer({
          canvasId: 'c1',
          deltas: [{ type: 'INSERT_NODE', node: restoredNode() }],
          originator: UI,
        }),
      ).rejects.toThrow('injected resurrection append failure');
    } finally {
      store.appendDeltaLogEntry = originalAppend;
    }

    expect(store.read()?.state.nodes).toEqual([]);
    expect(store.readNode('n1')).toBeNull();
    expect(store.isNodeWriteSuppressed('n1')).toBe(true);
    expect(store.readDeltaLogSince(0).map((entry) => entry.version)).toEqual([
      2,
    ]);

    await applyDeltasOnServer({
      canvasId: 'c1',
      deltas: [{ type: 'INSERT_NODE', node: restoredNode('retry') }],
      originator: UI,
    });
    expect(store.readNode('n1')?.content).toBe('retry');
    expect(store.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('does not clear a tombstone when an unrelated write retains the node', () => {
    seedNote('c1', 'n1', 'before');
    const store = getCanvasStore('c1');
    expect(store.deleteNode('n1')).toBe('deleted');

    const retained = store.read();
    if (!retained) throw new Error('seeded Space missing');
    store.write({
      ...retained,
      version: retained.version + 1,
      updatedAt: retained.updatedAt + 1,
    });
    store.write({
      ...retained,
      version: retained.version + 2,
      state: { ...retained.state, nodes: [] },
      updatedAt: retained.updatedAt + 2,
    });

    const late = applyNodeUpdate(store, 'n1', {
      apply: () => ({
        nodeId: 'n1',
        type: 'note',
        label: 'A',
        content: 'late',
      }),
    });
    expect(late).toEqual({ status: 'skipped-deleted' });
    expect(store.readNode('n1')).toBeNull();
  });

  it('removes a newly-created delete tombstone when the transaction rolls back', async () => {
    seedNote('c1', 'n1', 'before');
    const store = getCanvasStore('c1');
    const originalAppend = store.appendDeltaLogEntry;
    store.appendDeltaLogEntry = (entry) => {
      originalAppend.call(store, entry);
      throw new Error('injected delete append failure');
    };
    try {
      await expect(
        executeOnServer({
          canvasId: 'c1',
          commands: [
            {
              type: 'DELETE_NODES',
              nodeIds: ['n1'],
            } as unknown as CanvasCommand,
          ],
          originator: UI,
        }),
      ).rejects.toThrow('injected delete append failure');
    } finally {
      store.appendDeltaLogEntry = originalAppend;
    }

    const restored = store.read();
    if (!restored) throw new Error('rolled-back Space missing');
    expect(store.readNode('n1')?.content).toBe('before');
    store.write({
      ...restored,
      version: restored.version + 1,
      state: { ...restored.state, nodes: [] },
      updatedAt: restored.updatedAt + 1,
    });
    expect(store.isNodeWriteSuppressed('n1')).toBe(false);
  });
});

describe('executeOnServer — persistence failure atomicity', () => {
  it('rolls record, affected sidecars, and an appended delta back before a retry', async () => {
    const store = getCanvasStore('c1');
    const before = {
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'n1',
            type: 'note',
            position: { x: 0, y: 0 },
            data: { label: 'A' },
          },
          {
            id: 'n2',
            type: 'note',
            position: { x: 200, y: 0 },
            data: { label: 'B' },
          },
        ],
        edges: [],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    store.write(before);
    store.writeNode('n1', {
      nodeId: 'n1',
      type: 'note',
      label: 'A',
      content: 'a1',
    });
    store.writeNode('n2', {
      nodeId: 'n2',
      type: 'note',
      label: 'B',
      content: 'b1',
    });
    store.appendDeltaLogEntry({
      version: 1,
      ts: 1,
      commands: [],
      deltas: [],
      originator: UI,
    });
    const logPath = join(tmp, 'c1', '.history', 'delta-log.jsonl');
    appendFileSync(logPath, '{"crash-tail":', 'utf8');

    const commands = [
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: 'n1', patch: { label: 'Renamed A', content: 'a2' } },
        ],
      },
      { type: 'DELETE_NODES', nodeIds: ['n2'] },
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'n3',
            nodeType: 'note',
            position: { x: 400, y: 0 },
            data: { label: 'C', content: 'c1' },
          },
        ],
      },
    ] as unknown as CanvasCommand[];

    // Simulate the worst useful append failure: the complete row reached disk
    // and then the adapter reported failure. Rollback must truncate that row,
    // not merely repair topology and sidecars.
    const originalAppend = store.appendDeltaLogEntry;
    let failOnce = true;
    store.appendDeltaLogEntry = (entry) => {
      originalAppend.call(store, entry);
      if (failOnce) {
        failOnce = false;
        // Model an unrelated external editor landing a sidecar during the
        // failed commit. Rollback owns only ids in this transaction.
        writeFileSync(
          join(tmp, 'c1', 'nodes', 'External.md'),
          '---\nid: external-concurrent\ntype: note\nlabel: External\n---\noutside\n',
          'utf8',
        );
        throw new Error('injected delta append failure');
      }
    };

    try {
      await expect(
        executeOnServer({ canvasId: 'c1', commands, originator: UI }),
      ).rejects.toThrow('injected delta append failure');

      expect(store.read()).toEqual(before);
      expect(store.readNode('n1')).toMatchObject({
        nodeId: 'n1',
        label: 'A',
        content: 'a1',
      });
      expect(store.readNode('n2')).toMatchObject({
        nodeId: 'n2',
        label: 'B',
        content: 'b1',
      });
      expect(store.readNode('n3')).toBeNull();
      expect(readdirSync(join(tmp, 'c1', 'nodes')).sort()).toEqual([
        'A.md',
        'B.md',
        'External.md',
      ]);
      expect(store.readNode('external-concurrent')).toMatchObject({
        label: 'External',
        content: 'outside\n',
      });
      expect(store.readDeltaLogSince(0).map((entry) => entry.version)).toEqual([
        1,
      ]);
      const repairedLog = readFileSync(logPath, 'utf8');
      expect(repairedLog).not.toContain('crash-tail');
      expect(repairedLog.endsWith('\n')).toBe(true);

      const retried = await executeOnServer({
        canvasId: 'c1',
        commands,
        originator: UI,
      });

      expect(retried.fromVersion).toBe(1);
      expect(retried.toVersion).toBe(2);
      expect(store.read()?.version).toBe(2);
      expect(store.readNode('n1')).toMatchObject({
        label: 'Renamed A',
        content: 'a2',
      });
      expect(store.readNode('n2')).toBeNull();
      expect(store.readNode('n3')).toMatchObject({ label: 'C', content: 'c1' });
      expect(store.readDeltaLogSince(0).map((entry) => entry.version)).toEqual([
        1, 2,
      ]);
    } finally {
      store.appendDeltaLogEntry = originalAppend;
    }
  });

  it('rejects a directory at delta-log.jsonl before mutation and retries at v2', async () => {
    seedNote('c1', 'n1', 'before');
    const store = getCanvasStore('c1');
    const before = store.read();
    if (!before) throw new Error('seeded canvas is missing');
    const logPath = join(tmp, 'c1', '.history', 'delta-log.jsonl');
    mkdirSync(logPath, { recursive: true });

    const command = mergeContent('n1', 'after');
    await expect(
      executeOnServer({ canvasId: 'c1', commands: [command], originator: UI }),
    ).rejects.toThrow('Delta log path is not a file');

    // Snapshot validation happens before the commit callback: no sidecar,
    // topology, or version mutation needs rollback.
    expect(store.read()).toEqual(before);
    expect(bodyOf('c1', 'n1')).toBe('before');
    expect(readdirSync(join(tmp, 'c1', 'nodes'))).toEqual(['A.md']);

    rmSync(logPath, { recursive: true });
    const retried = await executeOnServer({
      canvasId: 'c1',
      commands: [command],
      originator: UI,
    });

    expect(retried.fromVersion).toBe(1);
    expect(retried.toVersion).toBe(2);
    expect(bodyOf('c1', 'n1')).toBe('after');
    expect(store.readDeltaLogSince(0).map((entry) => entry.version)).toEqual([
      2,
    ]);
  });

  it('removes a transaction-created empty history directory after append failure', async () => {
    seedNote('c1', 'n1', 'before');
    const store = getCanvasStore('c1');
    const historyPath = join(tmp, 'c1', '.history');
    const originalAppend = store.appendDeltaLogEntry;
    store.appendDeltaLogEntry = (entry) => {
      originalAppend.call(store, entry);
      throw new Error('first append failed after write');
    };

    try {
      await expect(
        executeOnServer({
          canvasId: 'c1',
          commands: [mergeContent('n1', 'after')],
          originator: UI,
        }),
      ).rejects.toThrow('first append failed after write');
    } finally {
      store.appendDeltaLogEntry = originalAppend;
    }

    expect(store.read()?.version).toBe(1);
    expect(bodyOf('c1', 'n1')).toBe('before');
    expect(existsSync(historyPath)).toBe(false);

    const retried = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'after')],
      originator: UI,
    });
    expect(retried.toVersion).toBe(2);
    expect(store.readDeltaLogSince(0).map((entry) => entry.version)).toEqual([
      2,
    ]);
  });

  it('preserves unrelated history content created during a failed first append', async () => {
    seedNote('c1', 'n1', 'before');
    const store = getCanvasStore('c1');
    const historyPath = join(tmp, 'c1', '.history');
    const unrelatedPath = join(historyPath, 'external.keep');
    const logPath = join(historyPath, 'delta-log.jsonl');
    const originalAppend = store.appendDeltaLogEntry;
    store.appendDeltaLogEntry = (entry) => {
      originalAppend.call(store, entry);
      writeFileSync(unrelatedPath, 'unrelated', 'utf8');
      throw new Error('first append failed with unrelated history content');
    };

    try {
      await expect(
        executeOnServer({
          canvasId: 'c1',
          commands: [mergeContent('n1', 'after')],
          originator: UI,
        }),
      ).rejects.toThrow('first append failed with unrelated history content');
    } finally {
      store.appendDeltaLogEntry = originalAppend;
    }

    expect(store.read()?.version).toBe(1);
    expect(bodyOf('c1', 'n1')).toBe('before');
    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(unrelatedPath, 'utf8')).toBe('unrelated');
    expect(readdirSync(historyPath)).toEqual(['external.keep']);

    const retried = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'after')],
      originator: UI,
    });
    expect(retried.toVersion).toBe(2);
    expect(readFileSync(unrelatedPath, 'utf8')).toBe('unrelated');
    expect(store.readDeltaLogSince(0).map((entry) => entry.version)).toEqual([
      2,
    ]);
  });

  it('captures an affected sidecar missed by a stale same-count filename index', () => {
    seedNote('c1', 'n1', 'before');
    const store = getCanvasStore('c1');
    const before = store.read();
    if (!before) throw new Error('seeded canvas is missing');
    const nodesPath = join(tmp, 'c1', 'nodes');
    renameSync(join(nodesPath, 'A.md'), join(nodesPath, 'Finder rename.md'));

    // The warm index still points at A.md: a pure rename preserves the file
    // count, so the cheap count probe alone cannot discover the new name.
    expect(store.nodeIdForFilename('Finder rename.md')).toBeNull();

    expect(() =>
      runCanvasPersistenceTransaction({
        canvasId: 'c1',
        affectedNodeIds: new Set(['n1']),
        nodeIdForFilename: (filename) => store.nodeIdForFilename(filename),
        resetRecordState: () => store.write(before),
        commit: () => {
          store.writeNode('n1', {
            nodeId: 'n1',
            type: 'note',
            label: 'Changed',
            content: 'after',
          });
          throw new Error('injected after stale-index rename');
        },
      }),
    ).toThrow('injected after stale-index rename');

    expect(readdirSync(nodesPath)).toEqual(['Finder rename.md']);
    expect(store.readNode('n1')).toMatchObject({
      label: 'A',
      content: 'before',
    });
  });
});
