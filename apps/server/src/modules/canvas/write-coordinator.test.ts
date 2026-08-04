/**
 * `updateNode` — the serialized, rev-CAS-guarded node-write primitive.
 *
 * These tests exercise the coordinator's mechanism in isolation with a fake
 * store (no disk): the rev-CAS gate, the `apply` reconciliation, no-op /
 * rejected outcomes, and — crucially — that concurrent updates to the same
 * canvas are serialized (the second sees the first's write).
 */

import { describe, expect, it } from 'vitest';

import { nodeRevisionOf } from '@sediment/shared/canvas-engine';

import { applyNodeUpdate, updateNode } from './write-coordinator.js';

import type {
  CanvasStore,
  NodeContent,
  RenameResult,
} from '../storage/index.js';

/** A minimal in-memory stand-in for the fields `updateNode` touches. */
function fakeStore(canvasId = 'c1') {
  let record: NodeContent | null = null;
  let suppressed = false;
  let writeImpl: (content: NodeContent) => RenameResult = (content) => ({
    ok: true,
    filename: `${content.label ?? 'Untitled'}.md`,
    label: content.label,
  });

  const store = {
    canvasId,
    readNode: () => record,
    isNodeWriteSuppressed: () => suppressed,
    writeNode: (_id: string, content: NodeContent) => {
      const result = writeImpl(content);
      if (result.ok) record = content;
      return result;
    },
  } as unknown as CanvasStore;

  return {
    store,
    get: () => record,
    seed: (r: NodeContent | null) => {
      record = r;
    },
    setSuppressed: (v: boolean) => {
      suppressed = v;
    },
    onWrite: (fn: (content: NodeContent) => RenameResult) => {
      writeImpl = fn;
    },
  };
}

function note(content: string, label: string | null = 'Note'): NodeContent {
  return { nodeId: 'n1', type: 'note', label, content };
}

describe('updateNode — serialized rev-CAS node write', () => {
  it('writes and returns the new rev + persisted label on success', async () => {
    const s = fakeStore();
    const out = await updateNode(s.store, 'n1', { apply: () => note('hello') });

    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('unreachable');
    expect(out.rev).toBe(nodeRevisionOf({ content: 'hello' }));
    expect(out.label).toBe('Note');
    expect(s.get()?.content).toBe('hello');
  });

  it('refuses a stale expectRev without writing (rev-conflict, no clobber)', async () => {
    const s = fakeStore();
    s.seed(note('disk-newer'));

    const out = await updateNode(s.store, 'n1', {
      expectRev: nodeRevisionOf({ content: 'stale' }),
      apply: () => note('would-clobber'),
    });

    expect(out.status).toBe('rev-conflict');
    if (out.status !== 'rev-conflict') throw new Error('unreachable');
    expect(out.currentRev).toBe(nodeRevisionOf({ content: 'disk-newer' }));
    // The newer on-disk record is preserved.
    expect(s.get()?.content).toBe('disk-newer');
  });

  it('writes when expectRev matches the current on-disk rev', async () => {
    const s = fakeStore();
    s.seed(note('v1'));

    const out = await updateNode(s.store, 'n1', {
      expectRev: nodeRevisionOf({ content: 'v1' }),
      apply: (cur) => note((cur?.content ?? '') + '+v2'),
    });

    expect(out.status).toBe('ok');
    expect(s.get()?.content).toBe('v1+v2');
  });

  it('is a no-op when apply returns null', async () => {
    const s = fakeStore();
    s.seed(note('unchanged'));

    const out = await updateNode(s.store, 'n1', { apply: () => null });

    expect(out.status).toBe('noop');
    expect(s.get()?.content).toBe('unchanged');
  });

  it('surfaces a writeNode rejection verbatim', async () => {
    const s = fakeStore();
    s.onWrite(() => ({
      ok: false,
      reason: 'conflict',
      conflictWith: { id: 'other', filename: 'Taken.md' },
    }));

    const out = await updateNode(s.store, 'n1', {
      apply: () => note('x', 'Taken'),
    });

    expect(out.status).toBe('rejected');
    if (out.status !== 'rejected') throw new Error('unreachable');
    expect(out.result.reason).toBe('conflict');
  });

  it('drops a write for a tombstoned node without invoking apply', async () => {
    const s = fakeStore();
    s.seed(note('on-disk'));
    s.setSuppressed(true);
    let applyCalled = false;

    const out = await updateNode(s.store, 'n1', {
      apply: () => {
        applyCalled = true;
        return note('late-resurrection');
      },
    });

    expect(out.status).toBe('skipped-deleted');
    // `apply` must not run — callers derive their result from its side
    // effects, so a suppressed write has to be a true no-op.
    expect(applyCalled).toBe(false);
    // Nothing was written; the on-disk record is untouched.
    expect(s.get()?.content).toBe('on-disk');
  });

  it('serializes concurrent updates — the second sees the first write', async () => {
    const s = fakeStore();

    const a = updateNode(s.store, 'n1', { apply: () => note('A') });
    const b = updateNode(s.store, 'n1', {
      apply: (cur) => note((cur?.content ?? '') + 'B'),
    });
    await Promise.all([a, b]);

    // If the two interleaved, B would have read `null` and written just 'B'.
    expect(s.get()?.content).toBe('AB');
  });
});

describe('applyNodeUpdate — non-locking core (caller holds the lock)', () => {
  it('runs the read → CAS → apply → write synchronously', () => {
    const s = fakeStore();
    s.seed(note('v1'));

    const out = applyNodeUpdate(s.store, 'n1', {
      expectRev: nodeRevisionOf({ content: 'v1' }),
      apply: (cur) => note((cur?.content ?? '') + '+v2'),
    });

    expect(out.status).toBe('ok');
    expect(s.get()?.content).toBe('v1+v2');
  });

  it('refuses a stale expectRev (rev-conflict) without writing', () => {
    const s = fakeStore();
    s.seed(note('disk'));

    const out = applyNodeUpdate(s.store, 'n1', {
      expectRev: nodeRevisionOf({ content: 'stale' }),
      apply: () => note('would-clobber'),
    });

    expect(out.status).toBe('rev-conflict');
    expect(s.get()?.content).toBe('disk');
  });
});
