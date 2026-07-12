// M5.6/C2 acceptance — the Tier-1 event log (README I9.8).
//
// The Tier-1 log is the fine, append-only, monotonically-sequenced
// AgentStreamEvent log. These tests exercise both store backings
// (in-memory + on-disk), sequence monotonicity, the fence read
// (`read(sinceSeq)` / `maxSeq`), on-disk round-trip + tolerance (a corrupt
// tail line never bricks a read), per-`(namespace, threadId)` isolation,
// and the EventLog live pub/sub (append fans out to subscribers; read is
// the caller's backfill).

import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EventLog,
  FileEventLogStore,
  InMemoryEventLogStore,
  type EventLogEntry,
  type EventLogStore,
} from './index.js';

import type {
  AgentSubmission,
  AgentStreamEvent,
  Namespace,
} from '@agenetes/protocol';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agenetes-eventlog-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ns = (name: string): Namespace => ({
  name,
  storage: { root: path.join(tmp, name) },
});

const text = (content: string): AgentStreamEvent => ({
  type: 'text_delta',
  data: { content },
});
const request: AgentSubmission = {
  type: 'user_text',
  content: 'hello',
  rendered: [{ type: 'text', text: 'hello' }],
};

const eventFilePath = (namespace: Namespace, threadId: string): string =>
  path.join(namespace.storage!.root!, 'chat_v2', `${threadId}.events.jsonl`);

// Run the shared store contract against both backings so the on-disk store
// stays a faithful twin of the in-memory default.
describe.each<[string, () => EventLogStore]>([
  ['InMemoryEventLogStore', () => new InMemoryEventLogStore()],
  ['FileEventLogStore', () => new FileEventLogStore()],
])('%s — EventLogStore contract', (_name, make) => {
  it('assigns monotonic 1-based seq per (namespace, threadId)', () => {
    const store = make();
    const n = ns('canvas-1');
    const a = store.append(n, 'thread-1', text('a'));
    const b = store.append(n, 'thread-1', text('b'));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(store.maxSeq(n, 'thread-1')).toBe(2);
  });

  it('sequences internal turn starts but keeps them out of event reads', () => {
    const store = make();
    const n = ns('canvas-1');
    const start = store.appendTurnStart(n, 'thread-1', request);
    const event = store.append(n, 'thread-1', text('a'));

    expect(start.seq).toBe(1);
    expect(event.seq).toBe(2);
    expect(store.read(n, 'thread-1')).toEqual([event]);
    expect(store.readRecords(n, 'thread-1')).toEqual([start, event]);
    expect(store.maxSeq(n, 'thread-1')).toBe(2);
  });

  it('reads the whole log, then only entries past a fence', () => {
    const store = make();
    const n = ns('canvas-1');
    store.append(n, 'thread-1', text('a'));
    store.append(n, 'thread-1', text('b'));
    store.append(n, 'thread-1', text('c'));

    const all = store.read(n, 'thread-1');
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);

    const past1 = store.read(n, 'thread-1', 1);
    expect(past1.map((e) => e.seq)).toEqual([2, 3]);
    expect(
      (past1[0]!.event as { data: { content: string } }).data.content,
    ).toBe('b');

    expect(store.read(n, 'thread-1', 3)).toEqual([]);
  });

  it('isolates logs by threadId and by namespace', () => {
    const store = make();
    const n1 = ns('canvas-1');
    const n2 = ns('canvas-2');
    store.append(n1, 'thread-1', text('a'));
    store.append(n1, 'thread-2', text('b'));
    store.append(n2, 'thread-1', text('c'));

    expect(store.maxSeq(n1, 'thread-1')).toBe(1);
    expect(store.maxSeq(n1, 'thread-2')).toBe(1);
    expect(store.maxSeq(n2, 'thread-1')).toBe(1);
    // Same threadId in a different namespace is a separate log.
    expect(store.read(n2, 'thread-1')[0]!.event).toEqual(text('c'));
  });

  it('reports maxSeq 0 and an empty read for an unknown thread', () => {
    const store = make();
    const n = ns('canvas-1');
    expect(store.maxSeq(n, 'nope')).toBe(0);
    expect(store.read(n, 'nope')).toEqual([]);
  });
});

describe('FileEventLogStore — on-disk specifics', () => {
  it('writes an append-only JSONL file under chat_v2/ and survives a fresh store', () => {
    const n = ns('canvas-1');
    const first = new FileEventLogStore();
    first.append(n, 'thread-1', text('a'));
    first.append(n, 'thread-1', text('b'));

    // A brand-new store instance (simulating a restart) reads the same log
    // and continues the sequence from the persisted max.
    const restarted = new FileEventLogStore();
    expect(restarted.maxSeq(n, 'thread-1')).toBe(2);
    const next = restarted.append(n, 'thread-1', text('c'));
    expect(next.seq).toBe(3);
    expect(restarted.read(n, 'thread-1').map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('skips a corrupt trailing line instead of bricking the read', () => {
    const n = ns('canvas-1');
    const store = new FileEventLogStore();
    store.append(n, 'thread-1', text('a'));
    // Simulate a partially-written trailing line after a crash.
    appendFileSync(eventFilePath(n, 'thread-1'), '{ "seq": 2, "event": ');

    const fresh = new FileEventLogStore();
    const entries = fresh.read(n, 'thread-1');
    expect(entries.map((e) => e.seq)).toEqual([1]);
  });
});

describe('EventLog — durable append + live pub/sub', () => {
  it('persists via the store and fans out live entries to subscribers', () => {
    const log = new EventLog(new InMemoryEventLogStore());
    const n = ns('canvas-1');

    // A pre-existing entry the subscriber must NOT receive (backfill is the
    // caller's read concern, not the live tail).
    log.append(n, 'thread-1', text('before'));

    const seen: EventLogEntry[] = [];
    const unsub = log.subscribe('thread-1', (e) => seen.push(e));

    log.beginTurn(n, 'thread-1', request);
    log.append(n, 'thread-1', text('live-1'));
    log.append(n, 'thread-1', text('live-2'));

    expect(seen.map((e) => e.seq)).toEqual([3, 4]);
    // Backfill is served by read, gap-free with the live tail.
    expect(log.read(n, 'thread-1').map((e) => e.seq)).toEqual([1, 3, 4]);
    expect(log.readRecords(n, 'thread-1').map((e) => e.seq)).toEqual([
      1, 2, 3, 4,
    ]);

    unsub();
    log.append(n, 'thread-1', text('after-unsub'));
    expect(seen.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('only notifies subscribers of the matching threadId', () => {
    const log = new EventLog(new InMemoryEventLogStore());
    const n = ns('canvas-1');
    const seen: number[] = [];
    log.subscribe('thread-1', (e) => seen.push(e.seq));

    log.append(n, 'thread-2', text('other'));
    expect(seen).toEqual([]);

    log.append(n, 'thread-1', text('mine'));
    expect(seen).toEqual([1]);
  });
});
