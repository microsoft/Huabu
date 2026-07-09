// M5.5/A2 acceptance — the durable FileThreadStore.
//
// FileThreadStore is the restart-surviving twin of InMemoryThreadStore: it
// persists (namespace, threadId) -> ThreadRecord as
// `<namespace.storage.root>/threads.json`, one file per namespace, in the
// current `{ spec, state }` shape only (no legacy reader). These tests
// exercise round-trip fidelity, tolerant reads (a corrupt file / bad
// metadata never bricks the store), and per-namespace isolation.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileThreadStore,
  type ThreadRecord,
  type WorkloadSpecShape,
} from './index.js';

import type {
  AgentMetadata,
  AgentStateSnapshot,
  Namespace,
  SessionId,
} from '@agenetes/protocol';

interface Spec extends WorkloadSpecShape {
  readonly note?: string;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agenetes-threadstore-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ns = (name: string): Namespace => ({
  name,
  storage: { root: path.join(tmp, name) },
});

const spec = (threadId: string, note?: string): Spec => ({
  threadId,
  kind: 'internal',
  workloadType: 'Job',
  namespace: ns('canvas-1'),
  ...(note ? { note } : {}),
});

const meta: AgentMetadata = {
  currentModeId: 'ask',
  metaUpdatedAt: 1704067200000,
};

/** Brand a raw string as a low-level driver session id for test data. */
const sid = (s: string): SessionId => s as SessionId;

const state = (
  sessionId?: string,
  metadata?: AgentMetadata,
): AgentStateSnapshot => ({
  ...(sessionId ? { sessionId: sid(sessionId) } : {}),
  ...(metadata ? { metadata } : {}),
});

describe('FileThreadStore (M5.5/A2 durable backing)', () => {
  it('round-trips spec + state (sessionId, metadata)', () => {
    const store = new FileThreadStore();
    const namespace = ns('canvas-1');
    const record: ThreadRecord<Spec> = {
      spec: spec('t1', 'hello'),
      state: state('sess-abc', meta),
    };
    store.upsert(namespace, 't1', record);

    // A fresh instance reads the same bytes from disk (restart-survival).
    const reread = new FileThreadStore().get<Spec>(namespace, 't1');
    expect(reread).toBeDefined();
    expect(reread!.spec.note).toBe('hello');
    expect(reread!.state.sessionId).toBe('sess-abc');
    expect(reread!.state.metadata).toEqual(meta);
  });

  it('upsert replaces the whole record; delete removes it', () => {
    const store = new FileThreadStore();
    const namespace = ns('canvas-1');
    store.upsert(namespace, 't1', {
      spec: spec('t1'),
      state: state('first'),
    });
    store.upsert(namespace, 't1', {
      spec: spec('t1'),
      state: state('second'),
    });
    expect(store.get(namespace, 't1')!.state.sessionId).toBe('second');

    store.delete(namespace, 't1');
    expect(store.get(namespace, 't1')).toBeUndefined();
  });

  it('lists only the current namespace and isolates across namespaces', () => {
    const store = new FileThreadStore();
    const a = ns('canvas-a');
    const b = ns('canvas-b');
    store.upsert(a, 't1', { spec: spec('t1'), state: state() });
    store.upsert(b, 't2', { spec: spec('t2'), state: state() });
    expect(store.list(a).map((r) => (r.spec as Spec).threadId)).toEqual(['t1']);
    expect(store.list(b).map((r) => (r.spec as Spec).threadId)).toEqual(['t2']);
    expect(store.get(a, 't2')).toBeUndefined();
  });

  it('returns empty for a missing / never-written namespace', () => {
    const store = new FileThreadStore();
    expect(store.list(ns('never'))).toEqual([]);
    expect(store.get(ns('never'), 'x')).toBeUndefined();
  });

  it('tolerates a corrupt file (returns empty, never throws)', () => {
    const namespace = ns('canvas-1');
    mkdirSync(namespace.storage!.root, { recursive: true });
    writeFileSync(
      path.join(namespace.storage!.root, 'threads.json'),
      '{ this is not json',
    );
    const store = new FileThreadStore();
    expect(store.list(namespace)).toEqual([]);
  });

  it('drops a record with a malformed metadata snapshot but keeps spec', () => {
    const namespace = ns('canvas-1');
    mkdirSync(namespace.storage!.root, { recursive: true });
    writeFileSync(
      path.join(namespace.storage!.root, 'threads.json'),
      JSON.stringify({
        schemaVersion: 1,
        records: {
          t1: {
            spec: spec('t1'),
            // metaUpdatedAt must be a number — a string is rejected.
            state: { sessionId: 's', metadata: { metaUpdatedAt: 'nope' } },
          },
        },
      }),
    );
    const store = new FileThreadStore();
    const rec = store.get<Spec>(namespace, 't1');
    expect(rec).toBeDefined();
    expect(rec!.state.sessionId).toBe('s');
    expect(rec!.state.metadata).toBeUndefined();
  });

  it('skips a record whose spec is not a persistable WorkloadSpec', () => {
    const namespace = ns('canvas-1');
    mkdirSync(namespace.storage!.root, { recursive: true });
    writeFileSync(
      path.join(namespace.storage!.root, 'threads.json'),
      JSON.stringify({
        schemaVersion: 1,
        records: {
          bad: { spec: { threadId: 't' }, state: {} },
          good: { spec: spec('good'), state: {} },
        },
      }),
    );
    const store = new FileThreadStore();
    expect(store.list(namespace).map((r) => (r.spec as Spec).threadId)).toEqual(
      ['good'],
    );
  });
});
