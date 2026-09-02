// M5.6/C3 acceptance — the Tier-2 folded-turn store (README I9.8).
//
// The Tier-2 store is the coarse, append-only log of folded AgentTurns.
// These tests exercise both store backings (in-memory + on-disk), fold
// order preservation, the `fence` (the last turn's seqEnd that a live tail
// resumes from), on-disk round-trip + tolerance (a corrupt tail line never
// bricks a read), and per-`(namespace, threadId)` isolation.

import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileTurnStore,
  InMemoryTurnStore,
  type PersistedTurn,
  type TurnStore,
} from './index.js';

import type { AgentTurn, Namespace } from '@agenetes/protocol';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agenetes-turnstore-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ns = (name: string): Namespace => ({
  name,
  storage: { root: path.join(tmp, name) },
});

const turn = (text: string): AgentTurn => ({
  request: { type: 'user_text', content: `q:${text}` },
  transcript: [{ type: 'text', data: { content: text } }],
});

const persisted = (
  text: string,
  seqStart: number,
  seqEnd: number,
): PersistedTurn => ({ turn: turn(text), seqStart, seqEnd });

const turnFilePath = (namespace: Namespace, threadId: string): string =>
  path.join(namespace.storage!.root!, 'chat_v2', `${threadId}.turns.jsonl`);

// Run the shared store contract against both backings so the on-disk store
// stays a faithful twin of the in-memory default.
describe.each<[string, () => TurnStore]>([
  ['InMemoryTurnStore', () => new InMemoryTurnStore()],
  ['FileTurnStore', () => new FileTurnStore()],
])('%s — TurnStore contract', (_name, make) => {
  it('appends and lists folded turns in fold order', () => {
    const store = make();
    const n = ns('canvas-1');
    store.append(n, 'thread-1', persisted('a', 1, 3));
    store.append(n, 'thread-1', persisted('b', 4, 7));

    const list = store.list(n, 'thread-1');
    expect(list.map((p) => p.turn.transcript[0]!.data)).toEqual([
      { content: 'a' },
      { content: 'b' },
    ]);
    expect(list.map((p) => [p.seqStart, p.seqEnd])).toEqual([
      [1, 3],
      [4, 7],
    ]);
  });

  it('fence() returns the last turn seqEnd, or 0 when empty', () => {
    const store = make();
    const n = ns('canvas-1');
    expect(store.fence(n, 'thread-1')).toBe(0);
    store.append(n, 'thread-1', persisted('a', 1, 3));
    expect(store.fence(n, 'thread-1')).toBe(3);
    store.append(n, 'thread-1', persisted('b', 4, 7));
    expect(store.fence(n, 'thread-1')).toBe(7);
  });

  it('count() returns the number of folded turns without loading them', () => {
    const store = make();
    const n = ns('canvas-1');
    expect(store.count(n, 'thread-1')).toBe(0);
    store.append(n, 'thread-1', persisted('a', 1, 3));
    store.append(n, 'thread-1', persisted('b', 4, 7));
    expect(store.count(n, 'thread-1')).toBe(2);
  });

  it('isolates turns per (namespace, threadId)', () => {
    const store = make();
    const a = ns('canvas-a');
    const b = ns('canvas-b');
    store.append(a, 'thread-1', persisted('a1', 1, 1));
    store.append(b, 'thread-1', persisted('b1', 1, 1));
    store.append(a, 'thread-2', persisted('a2', 1, 1));

    expect(store.list(a, 'thread-1').length).toBe(1);
    expect(store.list(b, 'thread-1')[0]!.turn.transcript[0]!.data).toEqual({
      content: 'b1',
    });
    expect(store.list(a, 'thread-2')[0]!.turn.transcript[0]!.data).toEqual({
      content: 'a2',
    });
    expect(store.list(a, 'missing')).toEqual([]);
    expect(store.fence(a, 'missing')).toBe(0);
  });

  it('replace() overwrites the whole log and reseeds count()/fence() (the rehome() move primitive)', () => {
    const store = make();
    const source = ns('canvas-1');
    const target = ns('canvas-2');
    store.append(source, 'thread-1', persisted('a', 1, 3));
    store.append(source, 'thread-1', persisted('b', 4, 7));
    const snapshot = store.list(source, 'thread-1');

    store.replace(target, 'thread-1', snapshot);
    expect(store.list(target, 'thread-1')).toEqual(snapshot);
    expect(store.count(target, 'thread-1')).toBe(2);
    expect(store.fence(target, 'thread-1')).toBe(7);

    // A second replace() overwrites in full rather than appending.
    store.replace(target, 'thread-1', [snapshot[0]!]);
    expect(store.list(target, 'thread-1')).toEqual([snapshot[0]]);
    expect(store.count(target, 'thread-1')).toBe(1);
    expect(store.fence(target, 'thread-1')).toBe(3);
  });

  it('delete() removes a log entirely and idempotently', () => {
    const store = make();
    const n = ns('canvas-1');
    store.append(n, 'thread-1', persisted('a', 1, 3));
    store.delete(n, 'thread-1');
    expect(store.list(n, 'thread-1')).toEqual([]);
    expect(store.count(n, 'thread-1')).toBe(0);
    expect(store.fence(n, 'thread-1')).toBe(0);
    // Deleting an already-missing log is a no-op, not an error.
    expect(() => store.delete(n, 'thread-1')).not.toThrow();
    // A fresh append after delete starts a clean log, not one that merges
    // with stale cached metadata for the deleted path.
    store.append(n, 'thread-1', persisted('fresh', 1, 1));
    expect(store.count(n, 'thread-1')).toBe(1);
  });
});

describe('FileTurnStore — on-disk specifics', () => {
  it('persists to <root>/chat_v2/<threadId>.turns.jsonl and survives a restart', () => {
    const n = ns('canvas-1');
    const first = new FileTurnStore();
    first.append(n, 'thread-1', persisted('a', 1, 3));
    first.append(n, 'thread-1', persisted('b', 4, 7));

    // A fresh store reads the same on-disk log (restart-surviving).
    const restarted = new FileTurnStore();
    expect(restarted.list(n, 'thread-1').map((p) => p.seqEnd)).toEqual([3, 7]);
    expect(restarted.count(n, 'thread-1')).toBe(2);
    expect(restarted.fence(n, 'thread-1')).toBe(7);
  });

  it('tolerates a corrupt tail line without bricking the read', () => {
    const n = ns('canvas-1');
    const store = new FileTurnStore();
    store.append(n, 'thread-1', persisted('a', 1, 3));
    // Append a malformed line directly, as a torn write would leave behind.
    appendFileSync(turnFilePath(n, 'thread-1'), '{ not json\n');
    store.append(n, 'thread-1', persisted('b', 4, 7));

    const list = store.list(n, 'thread-1');
    expect(list.map((p) => p.seqEnd)).toEqual([3, 7]);
    expect(store.fence(n, 'thread-1')).toBe(7);
  });

  it('replace() writes the target file and a fresh store instance reads it back', () => {
    const source = ns('canvas-1');
    const target = ns('canvas-2');
    const writer = new FileTurnStore();
    writer.append(source, 'thread-1', persisted('a', 1, 3));
    writer.append(source, 'thread-1', persisted('b', 4, 7));
    const snapshot = writer.list(source, 'thread-1');

    writer.replace(target, 'thread-1', snapshot);
    expect(existsSync(turnFilePath(target, 'thread-1'))).toBe(true);

    const restarted = new FileTurnStore();
    expect(restarted.list(target, 'thread-1')).toEqual(snapshot);
    expect(restarted.fence(target, 'thread-1')).toBe(7);
  });

  it('delete() removes the on-disk file so a fresh store observes an empty log', () => {
    const n = ns('canvas-1');
    const writer = new FileTurnStore();
    writer.append(n, 'thread-1', persisted('a', 1, 3));
    expect(existsSync(turnFilePath(n, 'thread-1'))).toBe(true);

    writer.delete(n, 'thread-1');
    expect(existsSync(turnFilePath(n, 'thread-1'))).toBe(false);

    const restarted = new FileTurnStore();
    expect(restarted.list(n, 'thread-1')).toEqual([]);
    expect(restarted.count(n, 'thread-1')).toBe(0);
  });
});
