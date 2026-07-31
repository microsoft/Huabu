import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileThreadStore,
  THREAD_STORE_SCHEMA_VERSION,
  type ThreadRecord,
} from './index.js';

import type {
  AgentMetadata,
  AgentStateSnapshot,
  Namespace,
  WorkloadSpec,
} from '@agenetes/protocol';

interface DriverState {
  readonly sessionId?: string;
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(process.cwd(), '.agenetes-threadstore-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ns = (name: string): Namespace => ({
  name,
  storage: { root: path.join(scratch, name) },
});

const spec = (threadId: string, note?: string): WorkloadSpec => ({
  threadId,
  kind: 'internal',
  workloadType: 'Job',
  namespace: ns('canvas-1'),
  spec: note ? { note } : {},
});

const meta: AgentMetadata = {
  currentModeId: 'ask',
  metaUpdatedAt: 1704067200000,
};

const state = (
  sessionId?: string,
  metadata?: AgentMetadata,
): AgentStateSnapshot<DriverState> => ({
  driverState: sessionId ? { sessionId } : {},
  ...(metadata ? { metadata } : {}),
});

const record = (
  threadId: string,
  sessionId?: string,
  metadata?: AgentMetadata,
): ThreadRecord => ({
  driverSchemaVersion: 1,
  spec: spec(threadId),
  state: state(sessionId, metadata),
});

const writeStore = (namespace: Namespace, value: unknown): void => {
  mkdirSync(namespace.storage!.root, { recursive: true });
  writeFileSync(
    path.join(namespace.storage!.root, 'threads.json'),
    JSON.stringify(value),
  );
};

describe('FileThreadStore agenetes-v2 durable backing', () => {
  it('round-trips the strict versioned record envelope', () => {
    const store = new FileThreadStore();
    const namespace = ns('canvas-1');
    store.upsert(namespace, 't1', {
      driverSchemaVersion: 3,
      spec: spec('t1', 'hello'),
      state: state('sess-abc', meta),
    });

    const reread = new FileThreadStore().get(namespace, 't1');
    expect(reread).toEqual({
      driverSchemaVersion: 3,
      spec: expect.objectContaining({
        threadId: 't1',
        spec: { note: 'hello' },
      }),
      state: {
        driverState: { sessionId: 'sess-abc' },
        metadata: meta,
      },
    });
    expect(
      JSON.parse(
        readFileSync(
          path.join(namespace.storage!.root, 'threads.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: THREAD_STORE_SCHEMA_VERSION,
      records: {
        t1: { spec: { namespace: { name: 'canvas-1' } } },
      },
    });
  });

  it('rebinds a persisted machine-specific storage root to the current namespace', () => {
    const namespace = ns('canvas-1');
    const staleRoot = '/Users/christy/Library/CloudStorage/Huabu/.history';
    writeStore(namespace, {
      schemaVersion: THREAD_STORE_SCHEMA_VERSION,
      records: {
        t1: {
          ...record('t1'),
          spec: {
            ...spec('t1'),
            namespace: {
              name: 'canvas-1',
              storage: { root: staleRoot },
            },
          },
        },
      },
    });

    const store = new FileThreadStore();
    const reread = store.get(namespace, 't1');
    expect(reread?.spec.namespace).toEqual(namespace);

    store.upsert(namespace, 't1', reread!);
    const persisted = JSON.parse(
      readFileSync(path.join(namespace.storage!.root, 'threads.json'), 'utf8'),
    ) as { records: { t1: ThreadRecord } };
    expect(persisted.records.t1.spec.namespace).toEqual({ name: 'canvas-1' });
  });

  it('upsert replaces the whole record; delete removes it', () => {
    const store = new FileThreadStore();
    const namespace = ns('canvas-1');
    store.upsert(namespace, 't1', record('t1', 'first'));
    store.upsert(namespace, 't1', {
      ...record('t1', 'second'),
      driverSchemaVersion: 2,
    });
    expect(store.get(namespace, 't1')).toMatchObject({
      driverSchemaVersion: 2,
      state: { driverState: { sessionId: 'second' } },
    });

    store.delete(namespace, 't1');
    expect(store.get(namespace, 't1')).toBeUndefined();
  });

  it('lists only the current namespace and isolates across namespaces', () => {
    const store = new FileThreadStore();
    const a = ns('canvas-a');
    const b = ns('canvas-b');
    store.upsert(a, 't1', record('t1'));
    store.upsert(b, 't2', record('t2'));
    expect(store.list(a).map((item) => item.spec.threadId)).toEqual(['t1']);
    expect(store.list(b).map((item) => item.spec.threadId)).toEqual(['t2']);
    expect(store.get(a, 't2')).toBeUndefined();
  });

  it('returns empty for a missing namespace', () => {
    const store = new FileThreadStore();
    expect(store.list(ns('never'))).toEqual([]);
    expect(store.get(ns('never'), 'x')).toBeUndefined();
  });

  it('fails fast on corrupt JSON', () => {
    const namespace = ns('canvas-1');
    mkdirSync(namespace.storage!.root, { recursive: true });
    writeFileSync(
      path.join(namespace.storage!.root, 'threads.json'),
      '{ this is not json',
    );
    expect(() => new FileThreadStore().list(namespace)).toThrow(
      /cannot read .*threads\.json/,
    );
  });

  it('fails fast on non-v2 store schemas', () => {
    const namespace = ns('canvas-1');
    writeStore(namespace, { schemaVersion: 1, records: {} });
    expect(() => new FileThreadStore().list(namespace)).toThrow(
      /unsupported thread store schema '1'/,
    );
  });

  it.each([
    [
      'missing driver schema version',
      () => ({ spec: spec('t1'), state: state() }),
      /invalid driver schema version/,
    ],
    [
      'invalid workload envelope',
      () => ({
        driverSchemaVersion: 1,
        spec: { threadId: 't1' },
        state: state(),
      }),
      /invalid workload spec/,
    ],
    [
      'invalid state envelope',
      () => ({
        driverSchemaVersion: 1,
        spec: spec('t1'),
        state: { metadata: { metaUpdatedAt: 'nope' } },
      }),
      /invalid state envelope/,
    ],
  ])('fails fast on %s', (_name, createPersistedRecord, expected) => {
    const namespace = ns('canvas-1');
    writeStore(namespace, {
      schemaVersion: THREAD_STORE_SCHEMA_VERSION,
      records: { t1: createPersistedRecord() },
    });
    expect(() => new FileThreadStore().get(namespace, 't1')).toThrow(expected);
  });

  it('fails the whole read when any record is invalid', () => {
    const namespace = ns('canvas-1');
    writeStore(namespace, {
      schemaVersion: THREAD_STORE_SCHEMA_VERSION,
      records: {
        good: record('good'),
        bad: {
          driverSchemaVersion: 1,
          spec: spec('different-id'),
          state: state(),
        },
      },
    });
    expect(() => new FileThreadStore().list(namespace)).toThrow(
      /record key 'bad' does not match spec threadId 'different-id'/,
    );
  });
});
