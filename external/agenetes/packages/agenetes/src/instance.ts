// The mounted Agenetes instance (README I9) — the single object the host
// faces, the way a user faces one Kubernetes cluster / API server rather
// than a kubelet or a container runtime (I9.1). It owns two orthogonal
// surfaces over two `threadId`-addressed tables:
//
//   - the RUNTIME surface (I9.3) — `create` / `get` / `close` — over the
//     GLOBAL in-memory live-handle table (the `@agenetes/runtime`
//     lifecycle registry); and
//   - the QUERY surface (I9.4) — `record` / `records` — over the
//     per-namespace PERSISTENT thread table (the {@link ThreadStore}).
//
// `run` / `control` / `capabilities` live on the {@link AgentHandle} (I8),
// never on the instance (I9.2), so the host composes them off the handle
// `create` / `get` return.

import {
  AGENT_STREAM_EVENTS,
  agentSubmissionSchema,
  workloadSpecSchema,
} from '@agenetes/protocol';
import { AgenetesError } from '@agenetes/runtime';

import {
  EventLog,
  InMemoryEventLogStore,
  type EventLogEntry,
  type TurnStartLogEntry,
} from './event-log.js';
import { createTranscriptFolder } from './fold.js';
import { materializeHistory } from './materialize-history.js';
import { ThreadNotificationBus } from './notifications.js';
import {
  createAgentRecoveryContext,
  DEFAULT_AUTO_RECOVER_POLICY,
  type AutoRecoverPolicy,
} from './recovery.js';
import { type ThreadRecord, type ThreadStore } from './thread-store.js';
import { InMemoryTurnStore, type TurnStore } from './turn-store.js';

import type {
  AgentMetadata,
  AgentSubmission,
  AgentStateSnapshot,
  AgentStreamEvent,
  AgentTurn,
  AgentTurnMeta,
  Namespace,
  ObservedAgentTurn,
  WorkloadSpec,
} from '@agenetes/protocol';
import type {
  AgentCreateContext,
  AgentHandle,
  AgentRuntime,
  MountedAgentDriver,
  ThreadIdentity,
} from '@agenetes/runtime';

/** The runtime + query surface the host drives (I9.3 / I9.4). */
export interface Agenetes {
  /**
   * Realise the workload for `spec`, dispatching the driver on `spec.kind`
   * and the lifecycle on `spec.workloadType` (I3.2 / I9.3):
   *
   *   - a **`Deployment`** get-or-creates by `spec.threadId` — an existing
   *     live handle is returned as-is (**reuse ignores spec**, no reconcile;
   *     changing a spec is an explicit `close()` + `create()` the caller
   *     decides), and it is cached in the live-handle table so `get` can
   *     find it;
   *   - a **`Job`** is minted fresh every call (`driver.create(spec)`
   *     directly) and **never** enters the live-handle table, so
   *     `get(threadId)` stays `undefined` and `close()` is a no-op for it.
   *
   * Either way the durable thread record is upserted so the query surface
   * can read it independent of handle liveness (I9.4).
   */
  create(spec: WorkloadSpec): AgentHandle;
  /**
   * Realise a fresh target thread from a durable source thread. The host
   * supplies the complete target spec; Agenetes performs no field-level
   * merge. The target receives the source record and folded turns but
   * starts with an empty target state.
   */
  fork(source: ThreadIdentity, targetSpec: WorkloadSpec): AgentHandle;
  /**
   * Pure lookup of the live handle for `threadId` — **never spawns**
   * (I9.3). A missing handle is a precondition failure (e.g. a control
   * write on a dead thread), not a lazy spawn.
   */
  get(threadId: string): AgentHandle | undefined;
  /** Tear the live handle down and evict it from the live table (I9.3). */
  close(threadId: string): void;
  /**
   * Read one durable thread record by `(namespace, threadId)` (I9.4),
   * independent of whether a handle is live.
   */
  record(namespace: Namespace, threadId: string): ThreadRecord | undefined;
  /** Enumerate a namespace's persisted thread records (I9.4). */
  records(namespace: Namespace): ThreadRecord[];
  /**
   * The notification surface (I9.7): subscribe to a thread's driver-agnostic
   * `AgentMetadata` as it changes. The instance persists each up-reported
   * snapshot into the {@link ThreadStore} FIRST, then re-emits its
   * `metadata` here (persist-then-notify), so a `record` read after a
   * notification always observes the latest state. The stream ends when the
   * thread's handle is `close`d or the consumer breaks out of the loop.
   */
  notifications(threadId: string): AsyncIterable<AgentMetadata>;
  /**
   * Read lightweight metadata about the two-tier conversation log without
   * loading its events or folded turns.
   */
  logMetadata(namespace: Namespace, threadId: string): ThreadLogMetadata;
  /**
   * Read a thread's durable conversation as folded {@link AgentTurn}s
   * (Tier 2 of the two-tier log, README I9.8). With `withTail`, the
   * uncovered Tier-1 suffix is folded into one read-time incomplete turn;
   * the persistent stores remain unchanged.
   */
  history(
    namespace: Namespace,
    threadId: string,
    options?: HistoryOptions,
  ): ThreadHistory;
  /**
   * Follow a thread's LIVE tail: the Tier-1 events appended after the last
   * folded turn (the uncommitted in-flight turn, replayed on connect) plus
   * every event appended thereafter, ending when the run's terminal
   * (`end` / `error`) frame is observed or the consumer breaks. This is the
   * reconnect / crash-recovery primitive; it takes no cursor — L2 composes
   * the fence internally from the Tier-2 log (I9.8).
   */
  tail(namespace: Namespace, threadId: string): AsyncIterable<AgentStreamEvent>;
}

/** Options for {@link Agenetes.history}. */
export interface HistoryOptions {
  /**
   * Project the uncovered Tier-1 suffix as an incomplete final turn.
   */
  readonly withTail?: boolean;
}

/** The result of {@link Agenetes.history}. */
export interface ThreadHistory {
  /** Completed turns plus the optional read-time incomplete projection. */
  readonly turns: ObservedAgentTurn[];
}

/** Lightweight counts for one thread's two-tier conversation log. */
export interface ThreadLogMetadata {
  /** Tier-1 record high-water mark, including internal turn starts. */
  readonly eventCount: number;
  /** Number of durable Tier-2 folded AgentTurns. */
  readonly turnCount: number;
}

/** Stream frames that terminate a run's live tail (README I8 run contract). */
const TERMINAL_EVENT_TYPES = new Set<string>([
  AGENT_STREAM_EVENTS.End,
  AGENT_STREAM_EVENTS.Error,
]);

/**
 * Coerce a run argument into the persisted driver-agnostic
 * {@link AgentSubmission}. A null submission persists as a resume turn;
 * malformed values degrade to null so logging cannot break execution.
 */
function coerceSubmission(request: unknown): AgentSubmission | null {
  if (request == null) return null;
  const parsed = agentSubmissionSchema.safeParse(request);
  return parsed.success ? parsed.data : null;
}

/**
 * Compose a thread's live tail: replay the Tier-1 events after `sinceSeq`
 * (the fence — the uncommitted in-flight turn) and then follow every event
 * appended thereafter, ending when a terminal (`end` / `error`) frame is
 * observed or the consumer breaks. Subscribes to the live fan-out BEFORE
 * reading the backfill so no event slips through the gap, and dedups on
 * `seq` so an event captured by both never doubles. All of this is
 * L2-internal — `seq` never leaves this iterator (I9.8).
 */
function createTail(
  eventLog: EventLog,
  namespace: Namespace,
  threadId: string,
  sinceSeq: number,
): AsyncIterable<AgentStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
      const live: EventLogEntry[] = [];
      let waiting: ((r: IteratorResult<AgentStreamEvent>) => void) | null =
        null;
      let finished = false;
      // The highest seq already delivered; the dedup / resume watermark.
      let lastSeq = sinceSeq;

      let unsub: () => void = () => {};
      const finish = (): void => {
        if (finished) return;
        finished = true;
        unsub();
      };

      // Subscribe FIRST so an event appended during backfill is buffered
      // (deduped later on seq), never lost between read and subscribe.
      unsub = eventLog.subscribe(threadId, (entry) => {
        if (finished || entry.seq <= lastSeq) return;
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          lastSeq = entry.seq;
          if (TERMINAL_EVENT_TYPES.has(entry.event.type)) finish();
          resolve({ value: entry.event, done: false });
        } else {
          live.push(entry);
        }
      });

      // Snapshot the already-persisted tail (entries after the fence).
      const backfill = eventLog.read(namespace, threadId, sinceSeq);
      let backfillIdx = 0;

      // Pull the next not-yet-delivered entry: backfill first (ascending
      // seq), then the buffered live entries; skip anything already sent.
      const nextEntry = (): EventLogEntry | undefined => {
        while (backfillIdx < backfill.length) {
          const entry = backfill[backfillIdx++]!;
          if (entry.seq > lastSeq) return entry;
        }
        while (live.length > 0) {
          const entry = live.shift()!;
          if (entry.seq > lastSeq) return entry;
        }
        return undefined;
      };

      const pump = (): IteratorResult<AgentStreamEvent> | undefined => {
        const entry = nextEntry();
        if (!entry) return undefined;
        lastSeq = entry.seq;
        if (TERMINAL_EVENT_TYPES.has(entry.event.type)) finish();
        return { value: entry.event, done: false };
      };

      return {
        next(): Promise<IteratorResult<AgentStreamEvent>> {
          const ready = pump();
          if (ready) return Promise.resolve(ready);
          if (finished) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
        return(): Promise<IteratorResult<AgentStreamEvent>> {
          finish();
          if (waiting) {
            const resolve = waiting;
            waiting = null;
            resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * Construct the instance over an already-populated {@link AgentRuntime}
 * (the driver registry + live-handle table), a {@link ThreadStore} (the
 * durable thread table), and the two-tier conversation log backings (the
 * {@link EventLog} Tier 1 + {@link TurnStore} Tier 2, I9.8). Callers
 * normally reach this through `mountAgenetes(...)` (I9.5), which constructs
 * the runtime from a complete static DriverMap and defaults the log backings;
 * it is exported for hosts that already own a runtime. The log backings
 * default to their in-memory variants so a direct caller can omit them.
 */
export function createAgenetesInstance(
  runtime: AgentRuntime,
  threadStore: ThreadStore,
  eventLog: EventLog = new EventLog(new InMemoryEventLogStore()),
  turnStore: TurnStore = new InMemoryTurnStore(),
  autoRecoverPolicy: AutoRecoverPolicy = DEFAULT_AUTO_RECOVER_POLICY,
): Agenetes {
  // The instance is the SOLE ThreadStore writer and the owner of the
  // per-thread notification fan-out (I9.7). It registers ONE up-report
  // listener per live Deployment handle (keyed by threadId) and tears it
  // down at close; the handle is the sole folder, the instance the sole
  // persister + re-emitter.
  const bus = new ThreadNotificationBus();
  const unsubscribers = new Map<string, () => void>();
  const recovery = createAgentRecoveryContext(autoRecoverPolicy);

  const resolveDriver = (spec: WorkloadSpec): MountedAgentDriver => {
    const driver = runtime.resolve(spec.kind);
    if (!driver) {
      throw new AgenetesError(
        'unknown_driver_kind',
        `no agent driver mounted for kind '${spec.kind}'`,
        { kind: spec.kind },
      );
    }
    if (!driver.workloadTypes.includes(spec.workloadType)) {
      throw new AgenetesError(
        'unsupported_workload_type',
        `driver '${spec.kind}' does not support ${spec.workloadType}`,
        { kind: spec.kind, workloadType: spec.workloadType },
      );
    }
    return driver;
  };

  const validateSpec = (
    raw: WorkloadSpec,
  ): { spec: WorkloadSpec; driver: MountedAgentDriver } => {
    const parsed = workloadSpecSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgenetesError(
        'invalid_workload',
        'invalid workload envelope',
        parsed.error,
      );
    }
    const driver = resolveDriver(parsed.data);
    return {
      spec: { ...parsed.data, spec: driver.validateSpec(parsed.data.spec) },
      driver,
    };
  };

  const validateRecord = (record: ThreadRecord): ThreadRecord => {
    const { spec, driver } = validateSpec(record.spec);
    if (record.driverSchemaVersion !== driver.schemaVersion) {
      throw new AgenetesError(
        'invalid_persisted_record',
        `driver schema version mismatch for '${spec.kind}'`,
        {
          kind: spec.kind,
          expected: driver.schemaVersion,
          actual: record.driverSchemaVersion,
        },
      );
    }
    return {
      driverSchemaVersion: record.driverSchemaVersion,
      spec,
      state: {
        ...record.state,
        driverState: driver.validateState(record.state.driverState),
      },
    };
  };

  const readHistory = (
    namespace: Namespace,
    threadId: string,
    withTail: boolean,
  ): ObservedAgentTurn[] => {
    const persisted = turnStore.list(namespace, threadId);
    if (!withTail) return persisted.map(({ turn }) => turn);
    const fence = persisted[persisted.length - 1]?.seqEnd ?? 0;
    return materializeHistory(
      persisted,
      eventLog.readRecords(namespace, threadId, fence),
    );
  };

  // Register the handle's up-report listener: persist the full snapshot
  // FIRST (sole writer), then re-emit its metadata (persist-then-notify).
  // A handle without `onState` (a driver that reports no out-of-turn meta)
  // wires nothing and its notification stream stays empty.
  const wireUpReport = (
    spec: WorkloadSpec,
    driver: MountedAgentDriver,
    handle: AgentHandle,
  ): void => {
    const unsub = handle.onState?.((snapshot: AgentStateSnapshot) => {
      threadStore.upsert(spec.namespace, spec.threadId, {
        driverSchemaVersion: driver.schemaVersion,
        spec,
        state: snapshot,
      });
      if (snapshot.metadata !== undefined) {
        bus.publish(spec.threadId, snapshot.metadata);
      }
    });
    if (unsub) unsubscribers.set(spec.threadId, unsub);
  };

  // Wrap a handle so every `run()` transparently feeds the two-tier
  // conversation log (I9.8): each yielded frame is teed into the Tier-1
  // EventLog as it streams (making the stream durable + live-tailable
  // without the host's fragile draft slot), and on return the turn's Tier-1
  // range is FOLDED into one immutable Tier-2 AgentTurn. The fold reads only
  // the yielded event stream — never the run's return value — so a driver's
  // `TResult` is free (need not equal `FoldedMessage[]`). Transparent to L1:
  // the caller still holds an AgentHandle and calls `run(...)` exactly as
  // before. For a Deployment the decoration is applied INSIDE the runtime
  // factory so the live-handle table caches the decorated handle and
  // `get(threadId)` returns the same logging handle every turn; a threaded
  // Job is decorated per-turn (it never enters the live table).
  //
  // A `Proxy` intercepts ONLY `run`; every other access (control / close /
  // onState / capabilities, and any driver-native surface) forwards to the
  // backing handle untouched, so decoration never hides the handle's shape.
  const decorateForLogging = (
    inner: AgentHandle,
    namespace: Namespace,
    threadId: string,
  ): AgentHandle => {
    async function* loggingRun(
      source: AsyncGenerator<AgentStreamEvent, unknown>,
      start: TurnStartLogEntry,
    ): AsyncGenerator<AgentStreamEvent, unknown> {
      const seqStart = start.seq;
      // Fold Tier-2 from the LIVE Tier-1 stream, not from the run's return
      // value (README I9.8): the folded transcript is fully derivable from
      // the deltas the driver already yields, so `TResult` stays free.
      const folder = createTranscriptFolder();
      let meta: AgentTurnMeta | undefined;
      let step = await source.next();
      while (!step.done) {
        const event = step.value;
        eventLog.append(namespace, threadId, event);
        folder.fold(event);
        if (event.type === AGENT_STREAM_EVENTS.Done) meta = event.data.meta;
        yield event;
        step = await source.next();
      }
      // The generator returned. Commit the Tier-2 turn pinned to its Tier-1
      // range, then pass the raw return value through UNCHANGED so the host's
      // own consumer still sees whatever `TResult` the driver produced.
      const seqEnd = eventLog.maxSeq(namespace, threadId);
      const turn: AgentTurn = {
        request: start.request,
        transcript: folder.result(),
        ...(meta ? { meta } : {}),
      };
      turnStore.append(namespace, threadId, { turn, seqStart, seqEnd });
      return step.value;
    }

    return new Proxy(inner, {
      get(target, prop) {
        if (prop === 'run') {
          return (
            submission: unknown,
            ctx: unknown,
          ): AsyncGenerator<AgentStreamEvent, unknown> => {
            const start = eventLog.beginTurn(
              namespace,
              threadId,
              coerceSubmission(submission),
            );
            return loggingRun(
              (
                target.run as (
                  s: unknown,
                  c: unknown,
                ) => AsyncGenerator<AgentStreamEvent, unknown>
              )(submission, ctx),
              start,
            );
          };
        }
        // Forward every other member to the backing handle. Bind methods to
        // the target so private state / getters resolve against the real
        // instance, not the proxy.
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const realize = (
    targetSpec: WorkloadSpec,
    driver: MountedAgentDriver,
    context: AgentCreateContext,
    initialState: AgentStateSnapshot,
  ): AgentHandle => {
    let handle: AgentHandle;
    if (targetSpec.workloadType === 'Job') {
      const raw = driver.create(targetSpec, context);
      handle =
        targetSpec.threadId.length > 0
          ? decorateForLogging(raw, targetSpec.namespace, targetSpec.threadId)
          : raw;
    } else {
      const wasLive = runtime.get(targetSpec.threadId) !== undefined;
      handle = runtime.getOrCreate(targetSpec.threadId, () =>
        decorateForLogging(
          driver.create(targetSpec, context),
          targetSpec.namespace,
          targetSpec.threadId,
        ),
      );
      if (!wasLive) wireUpReport(targetSpec, driver, handle);
    }

    const isTransientJob =
      targetSpec.workloadType === 'Job' && !targetSpec.threadId;
    if (!isTransientJob) {
      threadStore.upsert(targetSpec.namespace, targetSpec.threadId, {
        driverSchemaVersion: driver.schemaVersion,
        spec: targetSpec,
        state: initialState,
      });
    }
    return handle;
  };

  return {
    create(rawSpec: WorkloadSpec): AgentHandle {
      const incoming = validateSpec(rawSpec);
      // A persisted same-thread spec is authoritative across restart,
      // preserving reuse-ignores-spec semantics when no live handle exists.
      const rawPrior = incoming.spec.threadId
        ? threadStore.get(incoming.spec.namespace, incoming.spec.threadId)
        : undefined;
      const prior = rawPrior ? validateRecord(rawPrior) : undefined;
      if (prior && prior.spec.kind !== incoming.spec.kind) {
        throw new AgenetesError(
          'invalid_workload',
          `thread '${incoming.spec.threadId}' cannot change driver kind`,
          { priorKind: prior.spec.kind, targetKind: incoming.spec.kind },
        );
      }
      const target =
        prior?.spec.workloadType === 'Deployment'
          ? {
              spec: prior.spec,
              driver: resolveDriver(prior.spec),
            }
          : incoming;
      const context: AgentCreateContext = prior
        ? {
            recovery,
            recoveryInput: {
              state: prior.state,
              turns: readHistory(
                incoming.spec.namespace,
                incoming.spec.threadId,
                true,
              ),
            },
          }
        : { recovery };
      const initialState =
        prior?.state ??
        ({
          driverState: target.driver.initialState(),
        } satisfies AgentStateSnapshot);
      return realize(target.spec, target.driver, context, initialState);
    },
    fork(source: ThreadIdentity, rawTargetSpec: WorkloadSpec): AgentHandle {
      const sourceRecord = threadStore.get(source.namespace, source.threadId);
      if (!sourceRecord) {
        throw new AgenetesError(
          'invalid_workload',
          `cannot fork missing source thread '${source.namespace.name}/${source.threadId}'`,
        );
      }
      validateRecord(sourceRecord);
      const target = validateSpec(rawTargetSpec);
      const targetSpec = target.spec;
      if (source.threadId === targetSpec.threadId) {
        throw new AgenetesError(
          'invalid_workload',
          'fork target threadId must differ from source',
        );
      }
      if (
        runtime.get(targetSpec.threadId) !== undefined ||
        threadStore.get(targetSpec.namespace, targetSpec.threadId) !==
          undefined ||
        turnStore.list(targetSpec.namespace, targetSpec.threadId).length > 0
      ) {
        throw new AgenetesError(
          'invalid_workload',
          `fork target thread already exists '${targetSpec.namespace.name}/${targetSpec.threadId}'`,
        );
      }
      if (!targetSpec.threadId) {
        throw new AgenetesError(
          'invalid_workload',
          'fork target threadId must not be empty',
        );
      }
      return realize(
        targetSpec,
        target.driver,
        {
          recovery,
          forkInput: {
            source,
            turns: readHistory(source.namespace, source.threadId, true),
          },
        },
        { driverState: target.driver.initialState() },
      );
    },
    get(threadId: string): AgentHandle | undefined {
      return runtime.get(threadId);
    },
    close(threadId: string): void {
      // Tear down the up-report listener + end any open notification streams
      // before evicting the live handle.
      const unsub = unsubscribers.get(threadId);
      if (unsub) {
        unsub();
        unsubscribers.delete(threadId);
      }
      bus.closeThread(threadId);
      runtime.close(threadId);
    },
    record(namespace: Namespace, threadId: string): ThreadRecord | undefined {
      const record = threadStore.get(namespace, threadId);
      return record ? validateRecord(record) : undefined;
    },
    records(namespace: Namespace): ThreadRecord[] {
      return threadStore.list(namespace).map(validateRecord);
    },
    notifications(threadId: string): AsyncIterable<AgentMetadata> {
      return bus.subscribe(threadId);
    },
    logMetadata(namespace: Namespace, threadId: string): ThreadLogMetadata {
      return {
        eventCount: eventLog.maxSeq(namespace, threadId),
        turnCount: turnStore.count(namespace, threadId),
      };
    },
    history(
      namespace: Namespace,
      threadId: string,
      options?: HistoryOptions,
    ): ThreadHistory {
      return {
        turns: readHistory(namespace, threadId, options?.withTail === true),
      };
    },
    tail(
      namespace: Namespace,
      threadId: string,
    ): AsyncIterable<AgentStreamEvent> {
      const fence = turnStore.fence(namespace, threadId);
      return createTail(eventLog, namespace, threadId, fence);
    },
  };
}
