// M5.7 acceptance — `Agenetes.rehome()`, the destructive counterpart to
// `fork()` (docs/proposals/move-selected-nodes-between-spaces.md §11).
//
// Exercises the durable thread-relocation primitive end-to-end with a stub
// driver (no ACP / no host): a successful move preserving threadId, driver
// kind, workload type, driver state, Tier-1 events, and Tier-2 turns while
// rewriting the namespace/spec; the source-live-handle and target-collision
// preconditions; and determinate-failure rollback plus the explicit
// unknown-outcome path when the rollback itself cannot fully restore the
// source.

import { AgenetesError, defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { InMemoryEventLogStore, type EventLogStore } from './event-log.js';
import { InMemoryThreadStore, type ThreadStore } from './thread-store.js';
import {
  InMemoryTurnStore,
  type PersistedTurn,
  type TurnStore,
} from './turn-store.js';

import { mountAgenetes } from './index.js';

import type {
  AgentSpec,
  AgentStateSnapshot,
  Namespace,
} from '@agenetes/protocol';
import type {
  AgentCreateContext,
  AgentHandle,
  TypedWorkloadSpec,
} from '@agenetes/runtime';

interface StubDriverSpec extends AgentSpec {
  readonly note?: string;
}
type StubSpec = TypedWorkloadSpec<StubDriverSpec>;
interface StubDriverState {
  readonly sessionId?: string;
}

/** A stub handle recording its close() so live-handle checks are observable. */
class StubHandle {
  closed = false;
  constructor(
    readonly spec: StubSpec,
    readonly createContext: AgentCreateContext<StubDriverState>,
  ) {}
  close(): void {
    this.closed = true;
  }
}

const stubSpecSchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as StubDriverSpec }
      : { success: false as const, error: new Error('expected object') };
  },
};

const stubStateSchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as StubDriverState }
      : { success: false as const, error: new Error('expected object') };
  },
};

function stubDriver() {
  return defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Job', 'Deployment'],
    specSchema: stubSpecSchema,
    stateSchema: stubStateSchema,
    initialState: () => ({}),
    create: (spec, context) =>
      new StubHandle(spec, context) as unknown as AgentHandle,
  });
}

const ns = (name: string, root?: string): Namespace => ({
  name,
  storage: root ? { root } : undefined,
});

/** Seed a durable source thread (record + Tier-1 events + Tier-2 turns). */
function seedSource(
  threadStore: ThreadStore,
  eventLogStore: EventLogStore,
  turnStore: TurnStore,
  sourceNamespace: Namespace,
  threadId: string,
): { record: ReturnType<ThreadStore['get']>; sourceNamespace: Namespace } {
  const spec: StubSpec = {
    threadId,
    kind: 'external',
    workloadType: 'Deployment',
    namespace: sourceNamespace,
    spec: { note: 'source context' },
  };
  const state: AgentStateSnapshot<StubDriverState> = {
    driverState: { sessionId: 'source_session' },
  };
  threadStore.upsert(sourceNamespace, threadId, {
    driverSchemaVersion: 1,
    spec,
    state,
  });
  eventLogStore.appendTurnStart(sourceNamespace, threadId, {
    type: 'user_text',
    content: 'hello',
  });
  eventLogStore.append(sourceNamespace, threadId, {
    type: 'text_delta',
    data: { content: 'hi there' },
  });
  eventLogStore.append(sourceNamespace, threadId, { type: 'end', data: {} });
  turnStore.append(sourceNamespace, threadId, {
    turn: {
      request: { type: 'user_text', content: 'hello' },
      transcript: [{ type: 'text', data: { content: 'hi there' } }],
    },
    seqStart: 1,
    seqEnd: 3,
  });
  return {
    record: threadStore.get(sourceNamespace, threadId),
    sourceNamespace,
  };
}

const targetSpecFor = (
  sourceSpec: StubSpec,
  targetNamespace: Namespace,
): StubSpec => ({
  ...sourceSpec,
  namespace: targetNamespace,
  spec: { note: 'destination context' },
});

describe('Agenetes.rehome() — the destructive counterpart to fork()', () => {
  it('relocates the thread record, Tier-1 events, and Tier-2 turns to the target namespace', () => {
    const threadStore = new InMemoryThreadStore();
    const eventLogStore = new InMemoryEventLogStore();
    const turnStore = new InMemoryTurnStore();
    const sourceNamespace = ns('canvas_1', '/data/c1');
    const targetNamespace = ns('canvas_2', '/data/c2');
    const threadId = 'thread_1';
    seedSource(
      threadStore,
      eventLogStore,
      turnStore,
      sourceNamespace,
      threadId,
    );
    const sourceRecord = threadStore.get(sourceNamespace, threadId)!;
    const sourceEvents = eventLogStore.readRecords(sourceNamespace, threadId);
    const sourceTurns = turnStore.list(sourceNamespace, threadId);

    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore,
      eventLogStore,
      turnStore,
    });

    const targetSpec = targetSpecFor(
      sourceRecord.spec as StubSpec,
      targetNamespace,
    );
    inst.rehome({ namespace: sourceNamespace, threadId }, targetSpec);

    // Target: the visible durable owner with the rewritten namespace/spec,
    // preserved threadId, driver kind, workload type, and driver state.
    expect(inst.record(targetNamespace, threadId)).toEqual({
      driverSchemaVersion: 1,
      spec: targetSpec,
      state: sourceRecord.state,
    });
    expect(eventLogStore.readRecords(targetNamespace, threadId)).toEqual(
      sourceEvents,
    );
    expect(turnStore.list(targetNamespace, threadId)).toEqual(sourceTurns);
    expect(inst.history(targetNamespace, threadId).turns).toEqual(
      sourceTurns.map((p) => p.turn),
    );

    // Source: fully removed — record, Tier-1 log, and Tier-2 log.
    expect(inst.record(sourceNamespace, threadId)).toBeUndefined();
    expect(eventLogStore.readRecords(sourceNamespace, threadId)).toEqual([]);
    expect(turnStore.list(sourceNamespace, threadId)).toEqual([]);

    // rehome() never spawns/enters the live-handle table.
    expect(inst.get(threadId)).toBeUndefined();
  });

  it('rejects a source thread with a live handle, leaving source and target untouched', () => {
    const threadStore = new InMemoryThreadStore();
    const eventLogStore = new InMemoryEventLogStore();
    const turnStore = new InMemoryTurnStore();
    const sourceNamespace = ns('canvas_1');
    const targetNamespace = ns('canvas_2');
    const threadId = 'thread_1';
    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore,
      eventLogStore,
      turnStore,
    });
    const sourceSpec: StubSpec = {
      threadId,
      kind: 'external',
      workloadType: 'Deployment',
      namespace: sourceNamespace,
      spec: {},
    };
    // create() spawns a live Deployment handle and upserts the record.
    inst.create(sourceSpec);

    const targetSpec = targetSpecFor(sourceSpec, targetNamespace);
    expect(() =>
      inst.rehome({ namespace: sourceNamespace, threadId }, targetSpec),
    ).toThrow(/live handle/);
    expect(inst.record(targetNamespace, threadId)).toBeUndefined();
    expect(inst.record(sourceNamespace, threadId)).toBeDefined();
    expect(inst.get(threadId)).toBeDefined();
  });

  it('rejects a missing source thread', () => {
    const inst = mountAgenetes({ drivers: { external: stubDriver() } });
    const namespace = ns('canvas_1');
    const targetSpec: StubSpec = {
      threadId: 'missing',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_2'),
      spec: {},
    };
    expect(() =>
      inst.rehome({ namespace, threadId: 'missing' }, targetSpec),
    ).toThrow(/missing source thread/);
  });

  it.each([
    ['a conflicting thread record', 'record'],
    ['conflicting Tier-2 turns', 'turns'],
    ['conflicting Tier-1 events', 'events'],
  ] as const)(
    'rejects a target namespace with %s, leaving source untouched',
    (_label, conflictKind) => {
      const threadStore = new InMemoryThreadStore();
      const eventLogStore = new InMemoryEventLogStore();
      const turnStore = new InMemoryTurnStore();
      const sourceNamespace = ns('canvas_1');
      const targetNamespace = ns('canvas_2');
      const threadId = 'thread_1';
      seedSource(
        threadStore,
        eventLogStore,
        turnStore,
        sourceNamespace,
        threadId,
      );
      const sourceRecord = threadStore.get(sourceNamespace, threadId)!;

      if (conflictKind === 'record') {
        threadStore.upsert(targetNamespace, threadId, sourceRecord);
      } else if (conflictKind === 'turns') {
        turnStore.append(targetNamespace, threadId, {
          turn: {
            request: { type: 'user_text', content: 'stale' },
            transcript: [],
          },
          seqStart: 1,
          seqEnd: 1,
        });
      } else {
        eventLogStore.append(targetNamespace, threadId, {
          type: 'end',
          data: {},
        });
      }

      const inst = mountAgenetes({
        drivers: { external: stubDriver() },
        threadStore,
        eventLogStore,
        turnStore,
      });
      const targetSpec = targetSpecFor(
        sourceRecord.spec as StubSpec,
        targetNamespace,
      );
      expect(() =>
        inst.rehome({ namespace: sourceNamespace, threadId }, targetSpec),
      ).toThrow(/already exists/);
      // The source is completely untouched by a rejected precondition.
      expect(inst.record(sourceNamespace, threadId)).toEqual(sourceRecord);
      expect(eventLogStore.readRecords(sourceNamespace, threadId).length).toBe(
        3,
      );
      expect(turnStore.list(sourceNamespace, threadId).length).toBe(1);
    },
  );

  it('rejects a target threadId, driver kind, or workload type that differs from the source', () => {
    const threadStore = new InMemoryThreadStore();
    const eventLogStore = new InMemoryEventLogStore();
    const turnStore = new InMemoryTurnStore();
    const sourceNamespace = ns('canvas_1');
    const targetNamespace = ns('canvas_2');
    const threadId = 'thread_1';
    seedSource(
      threadStore,
      eventLogStore,
      turnStore,
      sourceNamespace,
      threadId,
    );
    const sourceRecord = threadStore.get(sourceNamespace, threadId)!;
    const inst = mountAgenetes({
      drivers: { external: stubDriver(), internal: stubDriver() },
      threadStore,
      eventLogStore,
      turnStore,
    });
    const base = targetSpecFor(sourceRecord.spec as StubSpec, targetNamespace);

    expect(() =>
      inst.rehome(
        { namespace: sourceNamespace, threadId },
        { ...base, threadId: 'renamed' },
      ),
    ).toThrow(/threadId must equal source/);
    expect(() =>
      inst.rehome(
        { namespace: sourceNamespace, threadId },
        { ...base, kind: 'internal' },
      ),
    ).toThrow(/driver kind must match source/);
    expect(() =>
      inst.rehome(
        { namespace: sourceNamespace, threadId },
        { ...base, workloadType: 'Job' },
      ),
    ).toThrow(/workload type must match source/);
    expect(() =>
      inst.rehome(
        { namespace: sourceNamespace, threadId },
        { ...base, namespace: sourceNamespace },
      ),
    ).toThrow(/namespace must differ from source/);
  });

  it('restores the source and removes every target write on a determinate failure', () => {
    const threadStore = new InMemoryThreadStore();
    const eventLogStore = new InMemoryEventLogStore();
    const turnStore = new InMemoryTurnStore();
    const sourceNamespace = ns('canvas_1');
    const targetNamespace = ns('canvas_2');
    const threadId = 'thread_1';
    seedSource(
      threadStore,
      eventLogStore,
      turnStore,
      sourceNamespace,
      threadId,
    );
    const sourceRecord = threadStore.get(sourceNamespace, threadId)!;
    const sourceEvents = eventLogStore.readRecords(sourceNamespace, threadId);
    const sourceTurns = turnStore.list(sourceNamespace, threadId);

    // The target thread-record write (step 3 — the destination visibility
    // point) rejects AFTER both target logs (steps 1-2) already succeeded,
    // so rollback must undo those two log writes and leave the source
    // completely untouched.
    let upsertCalls = 0;
    const failingThreadStore: ThreadStore = {
      upsert(namespace, id, record) {
        if (namespace.name === targetNamespace.name) {
          upsertCalls += 1;
          throw new Error('simulated target record write failure');
        }
        threadStore.upsert(namespace, id, record);
      },
      get: (namespace, id) => threadStore.get(namespace, id),
      list: (namespace) => threadStore.list(namespace),
      delete: (namespace, id) => threadStore.delete(namespace, id),
    };

    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore: failingThreadStore,
      eventLogStore,
      turnStore,
    });
    const targetSpec = targetSpecFor(
      sourceRecord.spec as StubSpec,
      targetNamespace,
    );

    expect(() =>
      inst.rehome({ namespace: sourceNamespace, threadId }, targetSpec),
    ).toThrow(/simulated target record write failure/);
    expect(upsertCalls).toBe(1);

    // Target logs written during the attempt are fully rolled back.
    expect(eventLogStore.readRecords(targetNamespace, threadId)).toEqual([]);
    expect(turnStore.list(targetNamespace, threadId)).toEqual([]);
    expect(threadStore.get(targetNamespace, threadId)).toBeUndefined();

    // Source is byte-for-byte unchanged.
    expect(threadStore.get(sourceNamespace, threadId)).toEqual(sourceRecord);
    expect(eventLogStore.readRecords(sourceNamespace, threadId)).toEqual(
      sourceEvents,
    );
    expect(turnStore.list(sourceNamespace, threadId)).toEqual(sourceTurns);
  });

  it('reports a distinct unknown-outcome error when the rollback itself fails', () => {
    const threadStore = new InMemoryThreadStore();
    const eventLogStore = new InMemoryEventLogStore();
    const realTurnStore = new InMemoryTurnStore();
    const sourceNamespace = ns('canvas_1');
    const targetNamespace = ns('canvas_2');
    const threadId = 'thread_1';
    seedSource(
      threadStore,
      eventLogStore,
      realTurnStore,
      sourceNamespace,
      threadId,
    );
    const sourceRecord = threadStore.get(sourceNamespace, threadId)!;
    const sourceEvents = eventLogStore.readRecords(sourceNamespace, threadId);
    const sourceTurns = realTurnStore.list(sourceNamespace, threadId);

    // `delete()` always rejects: this fails the source Tier-2 removal
    // (the last forward step, after everything else already succeeded) AND
    // fails the compensation that would otherwise undo the target Tier-2
    // write (step 2's rollback), so the rollback itself cannot fully
    // restore the pre-call state and rehome() must report the distinct
    // unknown-outcome error rather than silently claiming success.
    const flakyTurnStore: TurnStore = {
      append: (namespace, id, persisted) =>
        realTurnStore.append(namespace, id, persisted),
      list: (namespace, id) => realTurnStore.list(namespace, id),
      count: (namespace, id) => realTurnStore.count(namespace, id),
      fence: (namespace, id) => realTurnStore.fence(namespace, id),
      replace: (namespace, id, persisted: readonly PersistedTurn[]) =>
        realTurnStore.replace(namespace, id, persisted),
      delete() {
        throw new Error('simulated turn log delete failure');
      },
    };

    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore,
      eventLogStore,
      turnStore: flakyTurnStore,
    });
    const targetSpec = targetSpecFor(
      sourceRecord.spec as StubSpec,
      targetNamespace,
    );

    let caught: unknown;
    try {
      inst.rehome({ namespace: sourceNamespace, threadId }, targetSpec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgenetesError);
    expect((caught as InstanceType<typeof AgenetesError>).code).toBe(
      'rehome_unknown_outcome',
    );
    expect((caught as Error).message).toMatch(/unknown/);

    // The source record and Tier-1 log — the steps whose compensations DID
    // succeed — are restored; the Tier-2 log is left in a genuinely
    // unresolved state: the source copy was never actually removed (its
    // own forward `delete()` is what failed), but the leftover TARGET
    // Tier-2 write from step 2 could not be cleaned up because its
    // compensation is the very call that keeps throwing.
    expect(threadStore.get(sourceNamespace, threadId)).toEqual(sourceRecord);
    expect(eventLogStore.readRecords(sourceNamespace, threadId)).toEqual(
      sourceEvents,
    );
    expect(realTurnStore.list(sourceNamespace, threadId)).toEqual(sourceTurns);
    expect(realTurnStore.list(targetNamespace, threadId)).toEqual(sourceTurns);
  });
});
