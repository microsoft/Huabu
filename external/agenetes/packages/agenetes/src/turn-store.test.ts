// M5.6/C3 acceptance — the Tier-2 folded-turn store (README I9.8).
//
// The Tier-2 store is the coarse, append-only log of folded AgentTurns.
// These tests exercise both store backings (in-memory + on-disk), fold
// order preservation, the `fence` (the last turn's seqEnd that a live tail
// resumes from), on-disk round-trip + tolerance (a corrupt tail line never
// bricks a read), and per-`(namespace, threadId)` isolation.

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
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
});
