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
import { copyHostMetadata } from './host-metadata.js';
import {
  firstUncoveredSeq,
  materializeHistory,
} from './materialize-history.js';
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
  create(spec: WorkloadSpec): Promise<AgentHandle>;
  /** Fork source turns with fresh driver state and deep-copied host metadata. */
  fork(source: ThreadIdentity, targetSpec: WorkloadSpec): Promise<AgentHandle>;
  /**
   * The destructive counterpart to {@link Agenetes.fork}: relocate a
   * durable thread's complete conversation ownership — its thread record,
   * Tier-1 event log, and Tier-2 turn log — from `source` to the namespace
   * and host-owned spec context in `targetSpec`, preserving `threadId`,
   * driver kind, workload type, and driver state unchanged (I9.4 / I9.8).
   * Unlike `fork`, this MUTATES the source: on success the source record
   * and both source logs no longer exist and the target is the sole
   * durable owner of the thread's history.
   *
   * Preconditions (both checked before any write): `source` has no live
   * handle (the host must have closed/never spawned it), and the target
   * `(namespace, threadId)` holds no thread record and no Tier-1/Tier-2 log
   * — a rehome never overwrites an existing target.
   *
   * Durable ordering: the target Tier-1 log, then the target Tier-2 log,
   * then the target thread record are written FIRST — the target record
   * write is the destination visibility point, the first moment `record` /
   * `records` observe the thread under `targetSpec.namespace`. Only once
   * the target is completely durable are the source record and then the
   * source logs removed, so a reader never observes the thread missing
   * from both sides at once.
   *
   * On a determinate failure at any step, `rehome` restores the source to
   * its pre-call snapshot and removes every target record/log it wrote,
   * then re-throws the original error — the source is left unchanged
   * from the caller's perspective. If that restoration itself fails, the
   * unresolved outcome is reported as a distinct
   * `rehome_unknown_outcome` {@link AgenetesError}, which wraps the
   * original failure and the rollback failure; a caller must treat this as
   * "unknown, do not assume the source is intact" rather than a normal
   * determinate failure.
   */
  rehome(source: ThreadIdentity, targetSpec: WorkloadSpec): Promise<void>;
  /**
   * Pure lookup of the live handle for `threadId` — **never spawns**
   * (I9.3). A missing handle is a precondition failure (e.g. a control
   * write on a dead thread), not a lazy spawn.
   */
  get(threadId: string): AgentHandle | undefined;
  /**
   * Tear the live handle down and evict it from the live table (I9.3).
   * A driver teardown failure keeps the handle and its persistence/notification
   * wiring intact for retry. Durable records and conversation logs are retained.
   * Queued state writes are drained before the call settles, so a `record`
   * read after it observes every report the closed handle made.
   */
  close(threadId: string): Promise<void>;
  /**
   * Read one durable thread record by `(namespace, threadId)` (I9.4),
   * independent of whether a handle is live.
   */
  record(
    namespace: Namespace,
    threadId: string,
  ): Promise<ThreadRecord | undefined>;
  /** Enumerate a namespace's persisted thread records (I9.4). */
  records(namespace: Namespace): Promise<ThreadRecord[]>;
  /**
   * Shallow-merge host metadata keys into an existing record, without
   * spawning or changing spec/state. Values must be JSON-compatible;
   * null is a stored value, not deletion. Throws `thread_not_found` when absent
   * or `invalid_host_metadata` for a non-JSON patch. Does not emit driver metadata.
   */
  updateHostMetadata(
    namespace: Namespace,
    threadId: string,
    patch: Record<string, unknown>,
  ): Promise<ThreadRecord>;
  /**
   * The notification surface (I9.7): subscribe to a thread's driver-agnostic
   * `AgentMetadata` as it changes. The instance persists each up-reported
   * snapshot into the {@link ThreadStore} FIRST, then re-emits its
   * `metadata` here (persist-then-notify), so a `record` read after a
   * notification always observes the latest state. With a namespace, only
   * that namespace's reports are delivered (identity is namespace.name).
   * Omitting it retains the global per-thread stream. The stream ends when
   * its matching handle is `close`d or the consumer breaks out of the loop.
   */
  notifications(
    threadId: string,
    namespace?: Namespace,
  ): AsyncIterable<AgentMetadata>;
  /**
   * Read lightweight metadata about the two-tier conversation log without
   * loading its events or folded turns.
   */
  logMetadata(
    namespace: Namespace,
    threadId: string,
  ): Promise<ThreadLogMetadata>;
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
  ): Promise<ThreadHistory>;
  /** Read a bounded page of display-turn groups without loading full history. */
  historyPage(
    namespace: Namespace,
    threadId: string,
    options: HistoryPageOptions,
  ): Promise<ThreadHistoryPage>;
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

export interface HistoryPageOptions {
  readonly limit: number;
  readonly before?: string;
  /** Only applies to the newest page; older pages never include the tail. */
  readonly withTail?: boolean;
}

export interface ThreadHistoryGroup {
  readonly id: string;
  readonly turns: ObservedAgentTurn[];
  readonly isActive?: true;
  /** Index of the first Tier-1 turn within an active display group. */
  readonly activeTurnIndex?: number;
}

export interface ThreadHistoryPage {
  readonly groups: ThreadHistoryGroup[];
  readonly before?: string;
  readonly hasMore: boolean;
}

/** Lightweight counts for one thread's two-tier conversation log. */
export interface ThreadLogMetadata {
  /** Tier-1 record high-water mark, including internal turn starts. */
  readonly eventCount: number;
  /** Number of durable Tier-2 folded AgentTurns. */
  readonly turnCount: number;
}

/**
 * How many times a history page is reassembled when a turn folds mid-read.
 *
 * Each attempt costs one extra fence read, and a fold is a once-per-turn
 * event, so a handful of attempts covers a real collision; the count exists
 * so a thread folding continuously still gets an answer.
 */
const MAX_HISTORY_PAGE_ATTEMPTS = 3;

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
  readFence: () => number | Promise<number>,
): AsyncIterable<AgentStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
      const live: EventLogEntry[] = [];
      let waiting: ((r: IteratorResult<AgentStreamEvent>) => void) | null =
        null;
      let finished = false;
      // The highest seq already delivered; the dedup / resume watermark.
      let lastSeq = 0;

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
      let backfill: EventLogEntry[] = [];
      const readyBackfill = (async () => {
        const fence = await readFence();
        const persisted = await eventLog.read(namespace, threadId, fence);
        // A turn can finish while a remote fence read is in flight. Keep
        // events observed live even if that fence now includes their turn.
        backfill = [...persisted, ...live.splice(0)].sort(
          (a, b) => a.seq - b.seq,
        );
      })();
      void readyBackfill.catch(() => finish());
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
        async next(): Promise<IteratorResult<AgentStreamEvent>> {
          await readyBackfill;
          if (finished) return { value: undefined, done: true };
          const ready = pump();
          if (ready) return ready;
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
      ...(record.hostMetadata !== undefined
        ? {
            hostMetadata: copyHostMetadata(
              record.hostMetadata,
              'invalid_persisted_record',
            ),
          }
        : {}),
    };
  };

  const readHistory = async (
    namespace: Namespace,
    threadId: string,
    withTail: boolean,
  ): Promise<ObservedAgentTurn[]> => {
    const persisted = await turnStore.list(namespace, threadId);
    if (!withTail) return persisted.map(({ turn }) => turn);
    // Read from the first seq no folded turn accounts for, which the ranges
    // alone answer. With nothing interrupted that is the last turn's `seqEnd`
    // — the suffix read, unchanged — and when a turn died before committing
    // it reaches back far enough to find it again.
    const fence = firstUncoveredSeq(persisted) - 1;
    return materializeHistory(
      persisted,
      await eventLog.readRecords(namespace, threadId, fence),
    );
  };

  // Register the handle's up-report listener: persist the full snapshot
  // FIRST (sole writer), then re-emit its metadata (persist-then-notify).
  // A handle without `onState` (a driver that reports no out-of-turn meta)
  // wires nothing and its notification stream stays empty.
  /**
   * Each thread's queued state writes, and the namespace they belong to.
   *
   * Keyed by the globally unique `threadId` (I4.2), like every other
   * per-thread table here, so `close` / `record` / `run` reach a thread's
   * queue by the only identity they are given. The namespace rides alongside
   * because the durable thread table is namespace-partitioned (I4.1):
   * enumerating one namespace must not wait behind a write queued for a
   * thread in another, which shares nothing with it.
   */
  const pendingReports = new Map<
    string,
    { readonly namespace: string; readonly promise: Promise<void> }
  >();
  /**
   * The last up-report failure a thread has not yet reported to anyone.
   *
   * Held beside the queue rather than left in it. A rejected promise in
   * `pendingReports` would do two things at once: stop every later report
   * being attempted, because `.then` on a rejection forwards it without
   * running the callback, and answer every later `record` / `run` / `close`
   * with a write from minutes ago. Keeping the queue always-settled separates
   * those — the chain carries on, and the failure is surfaced once, to
   * whoever next asks about the thread.
   */
  const reportFailures = new Map<string, unknown>();
  /**
   * Threads with a turn streaming right now.
   *
   * `rehome` refuses a thread whose handle is live, because relocating a
   * conversation out from under a running turn would drop whatever that turn
   * appends between the read of the source log and the write of the target.
   * A **threaded Job** never enters the live-handle table, though its `run()`
   * is logged like any other — so the live table alone does not answer the
   * question the precondition is asking, and this does.
   */
  const activeRuns = new Set<string>();

  /**
   * Drain a thread's queued state writes, then surface one failure if the
   * queue produced one. Clearing it as it is thrown is what keeps a single
   * transient write failure from becoming the permanent answer.
   */
  const drainReports = async (threadId: string): Promise<void> => {
    await pendingReports.get(threadId)?.promise;
    if (!reportFailures.has(threadId)) return;
    const failure = reportFailures.get(threadId);
    reportFailures.delete(threadId);
    throw failure;
  };

  const wireUpReport = (
    spec: WorkloadSpec,
    driver: MountedAgentDriver,
    handle: AgentHandle,
  ): void => {
    const unsub = handle.onState?.((snapshot: AgentStateSnapshot) => {
      // The queue is kept always-settled so the next report is attempted
      // whatever this one does; the failure itself moves to `reportFailures`,
      // where `record` / `run` / `close` pick it up exactly once.
      const pending = (
        pendingReports.get(spec.threadId)?.promise ?? Promise.resolve()
      )
        .then(async () => {
          await threadStore.upsert(spec.namespace, spec.threadId, {
            ...(await threadStore.get(spec.namespace, spec.threadId)),
            driverSchemaVersion: driver.schemaVersion,
            spec,
            state: snapshot,
          });
          if (snapshot.metadata !== undefined) {
            bus.publish(spec.threadId, snapshot.metadata, spec.namespace.name);
            bus.publish(spec.threadId, snapshot.metadata);
          }
        })
        .catch((error: unknown) => {
          reportFailures.set(spec.threadId, error);
        });
      pendingReports.set(spec.threadId, {
        namespace: spec.namespace.name,
        promise: pending,
      });
    });
    // Register cleanup even for silent handles, whose scoped streams must end.
    unsubscribers.set(spec.threadId, () => {
      unsub?.();
      bus.closeThread(spec.threadId, spec.namespace.name);
    });
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
      let completed = false;
      activeRuns.add(threadId);
      try {
        let step = await source.next();
        while (!step.done) {
          await drainReports(threadId);
          const event = step.value;
          await eventLog.append(namespace, threadId, event);
          folder.fold(event);
          if (event.type === AGENT_STREAM_EVENTS.Done) meta = event.data.meta;
          yield event;
          step = await source.next();
        }
        // The generator returned. Commit the Tier-2 turn pinned to its Tier-1
        // range, then pass the raw return value through UNCHANGED so the host's
        // own consumer still sees whatever `TResult` the driver produced.
        await drainReports(threadId);
        const seqEnd = await eventLog.maxSeq(namespace, threadId);
        const turn: AgentTurn = {
          request: start.request,
          transcript: folder.result(),
          ...(meta ? { meta } : {}),
        };
        await turnStore.append(namespace, threadId, { turn, seqStart, seqEnd });
        completed = true;
        return step.value;
      } finally {
        activeRuns.delete(threadId);
        if (!completed) await source.return(undefined);
      }
    }

    return new Proxy(inner, {
      get(target, prop) {
        if (prop === 'run') {
          return (
            submission: unknown,
            ctx: unknown,
          ): AsyncGenerator<AgentStreamEvent, unknown> => {
            // Starting run() records the boundary immediately, even before the
            // generator is pulled; recovery can observe an empty in-flight turn.
            const start = eventLog.beginTurn(
              namespace,
              threadId,
              coerceSubmission(submission),
            );
            void start.catch(() => {});
            return (async function* () {
              await drainReports(threadId);
              const boundary = await start;
              const source = (
                target.run as (
                  s: unknown,
                  c: unknown,
                ) => AsyncGenerator<AgentStreamEvent, unknown>
              )(submission, ctx);
              return yield* loggingRun(source, boundary);
            })();
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

  const realize = async (
    targetSpec: WorkloadSpec,
    driver: MountedAgentDriver,
    context: AgentCreateContext,
    initialState: AgentStateSnapshot,
    hostMetadata?: Record<string, unknown>,
  ): Promise<AgentHandle> => {
    // Persist the initial record before the handle exists: realization now
    // awaits, and an up-report must never overwrite initialization.
    const isTransientJob =
      targetSpec.workloadType === 'Job' && !targetSpec.threadId;
    if (!isTransientJob) {
      const latest = await threadStore.get(
        targetSpec.namespace,
        targetSpec.threadId,
      );
      await threadStore.upsert(targetSpec.namespace, targetSpec.threadId, {
        ...(hostMetadata !== undefined ? { hostMetadata } : {}),
        ...latest,
        driverSchemaVersion: driver.schemaVersion,
        spec: targetSpec,
        state: latest?.state ?? initialState,
      });
    }
    let handle: AgentHandle;
    let needsUpReport = false;
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
      needsUpReport = !wasLive;
    }

    if (needsUpReport) wireUpReport(targetSpec, driver, handle);
    return handle;
  };

  const api: Agenetes = {
    async create(rawSpec: WorkloadSpec): Promise<AgentHandle> {
      const incoming = validateSpec(rawSpec);
      // A persisted same-thread spec is authoritative across restart,
      // preserving reuse-ignores-spec semantics when no live handle exists.
      const rawPrior = incoming.spec.threadId
        ? await threadStore.get(incoming.spec.namespace, incoming.spec.threadId)
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
              turns: await readHistory(
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
      return await realize(target.spec, target.driver, context, initialState);
    },
    async fork(
      source: ThreadIdentity,
      rawTargetSpec: WorkloadSpec,
    ): Promise<AgentHandle> {
      const sourceRecord = await threadStore.get(
        source.namespace,
        source.threadId,
      );
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
        (await threadStore.get(targetSpec.namespace, targetSpec.threadId)) !==
          undefined ||
        (await turnStore.list(targetSpec.namespace, targetSpec.threadId))
          .length > 0
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
      return await realize(
        targetSpec,
        target.driver,
        {
          recovery,
          forkInput: {
            source,
            turns: await readHistory(source.namespace, source.threadId, true),
          },
        },
        { driverState: target.driver.initialState() },
        sourceRecord.hostMetadata !== undefined
          ? copyHostMetadata(
              sourceRecord.hostMetadata,
              'invalid_persisted_record',
            )
          : undefined,
      );
    },
    async rehome(
      source: ThreadIdentity,
      rawTargetSpec: WorkloadSpec,
    ): Promise<void> {
      if (runtime.get(source.threadId) !== undefined) {
        throw new AgenetesError(
          'rehome_conflict',
          `cannot rehome thread '${source.namespace.name}/${source.threadId}' with a live handle`,
        );
      }
      if (activeRuns.has(source.threadId)) {
        throw new AgenetesError(
          'rehome_conflict',
          `cannot rehome thread '${source.namespace.name}/${source.threadId}' while a turn is streaming`,
        );
      }
      const sourceRecord = await threadStore.get(
        source.namespace,
        source.threadId,
      );
      if (!sourceRecord) {
        throw new AgenetesError(
          'invalid_workload',
          `cannot rehome missing source thread '${source.namespace.name}/${source.threadId}'`,
        );
      }
      const validatedSource = validateRecord(sourceRecord);
      const target = validateSpec(rawTargetSpec);
      const targetSpec = target.spec;
      if (targetSpec.threadId !== source.threadId) {
        throw new AgenetesError(
          'invalid_workload',
          'rehome target threadId must equal source threadId',
        );
      }
      if (targetSpec.namespace.name === source.namespace.name) {
        throw new AgenetesError(
          'invalid_workload',
          'rehome target namespace must differ from source',
        );
      }
      if (targetSpec.kind !== validatedSource.spec.kind) {
        throw new AgenetesError(
          'invalid_workload',
          `rehome target driver kind must match source '${validatedSource.spec.kind}'`,
        );
      }
      if (targetSpec.workloadType !== validatedSource.spec.workloadType) {
        throw new AgenetesError(
          'invalid_workload',
          `rehome target workload type must match source '${validatedSource.spec.workloadType}'`,
        );
      }
      const targetHasRecord =
        (await threadStore.get(targetSpec.namespace, targetSpec.threadId)) !==
        undefined;
      const targetHasTurns =
        (await turnStore.list(targetSpec.namespace, targetSpec.threadId))
          .length > 0;
      const targetHasEvents =
        (await eventLog.readRecords(targetSpec.namespace, targetSpec.threadId))
          .length > 0;
      if (targetHasRecord || targetHasTurns || targetHasEvents) {
        throw new AgenetesError(
          'rehome_conflict',
          `rehome target thread already exists '${targetSpec.namespace.name}/${targetSpec.threadId}'`,
        );
      }

      // Snapshot the complete source BEFORE any write, so a determinate
      // failure at any later step can restore it byte-for-byte regardless
      // of which step failed.
      const sourceEvents = await eventLog.readRecords(
        source.namespace,
        source.threadId,
      );
      const sourceTurns = await turnStore.list(
        source.namespace,
        source.threadId,
      );
      const targetRecord: ThreadRecord = {
        ...validatedSource,
        spec: targetSpec,
      };

      // Each step's compensation is pushed ONLY once the step itself
      // durably succeeds, so a mid-sequence failure unwinds exactly the
      // completed prefix — never more, never less.
      const undo: Array<() => void | Promise<void>> = [];
      const step = async (
        write: () => void | Promise<void>,
        compensate: () => void | Promise<void>,
      ): Promise<void> => {
        await write();
        undo.push(compensate);
      };

      try {
        // Target Tier-1 log, then target Tier-2 log, then the target
        // thread record LAST — the record write is the destination
        // visibility point (I9.4): the first moment a reader can observe
        // the thread under `targetSpec.namespace`.
        await step(
          async () =>
            await eventLog.replace(
              targetSpec.namespace,
              targetSpec.threadId,
              sourceEvents,
            ),
          async () =>
            await eventLog.delete(targetSpec.namespace, targetSpec.threadId),
        );
        await step(
          async () =>
            await turnStore.replace(
              targetSpec.namespace,
              targetSpec.threadId,
              sourceTurns,
            ),
          async () =>
            await turnStore.delete(targetSpec.namespace, targetSpec.threadId),
        );
        await step(
          async () =>
            await threadStore.upsert(
              targetSpec.namespace,
              targetSpec.threadId,
              targetRecord,
            ),
          async () =>
            await threadStore.delete(targetSpec.namespace, targetSpec.threadId),
        );
        // Only once the target is completely durable: remove the source
        // record (its own visibility point) before its now-orphaned logs.
        await step(
          async () =>
            await threadStore.delete(source.namespace, source.threadId),
          async () =>
            await threadStore.upsert(
              source.namespace,
              source.threadId,
              sourceRecord,
            ),
        );
        await step(
          async () => await eventLog.delete(source.namespace, source.threadId),
          async () =>
            await eventLog.replace(
              source.namespace,
              source.threadId,
              sourceEvents,
            ),
        );
        await step(
          async () => await turnStore.delete(source.namespace, source.threadId),
          async () =>
            await turnStore.replace(
              source.namespace,
              source.threadId,
              sourceTurns,
            ),
        );
      } catch (error) {
        // Unwind the completed prefix in reverse (LIFO) order, restoring
        // the source snapshot and removing every target record/log this
        // call wrote. Each store primitive either durably succeeds or
        // throws with no partial effect, so a compensation failure here
        // means the true state is genuinely unknown, not just "source
        // unchanged" — that becomes its own distinct error rather than a
        // silently swallowed best-effort cleanup.
        const rollbackErrors: unknown[] = [];
        for (const compensate of undo.reverse()) {
          try {
            await compensate();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AgenetesError(
            'rehome_unknown_outcome',
            `rehome for '${source.namespace.name}/${source.threadId}' failed and rollback could not fully restore the source; the outcome is unknown and requires manual recovery`,
            { cause: error, rollbackErrors },
          );
        }
        throw error;
      }
    },
    get(threadId: string): AgentHandle | undefined {
      return runtime.get(threadId);
    },
    async close(threadId: string): Promise<void> {
      // Keep persistence and notifications wired if driver teardown fails.
      runtime.close(threadId);
      try {
        // A snapshot reported during teardown is still this thread's. Persist
        // and deliver it before either notification scope ends — tearing the
        // listener down first would drop the driver's last word.
        await drainReports(threadId);
      } finally {
        pendingReports.delete(threadId);
        // A failure `drainReports` did not get to report belongs to the
        // handle being torn down, not to whatever spawns this thread next.
        reportFailures.delete(threadId);
        const unsub = unsubscribers.get(threadId);
        if (unsub) {
          unsub();
          unsubscribers.delete(threadId);
        }
        bus.closeThread(threadId);
      }
    },
    async record(
      namespace: Namespace,
      threadId: string,
    ): Promise<ThreadRecord | undefined> {
      await drainReports(threadId);
      const record = await threadStore.get(namespace, threadId);
      return record ? validateRecord(record) : undefined;
    },
    async records(namespace: Namespace): Promise<ThreadRecord[]> {
      // Only this namespace's queued writes are waited for. A thread in
      // another namespace writes to another partition of the thread table, so
      // its queue cannot change the answer — and a write parked in it must not
      // hold this enumeration open.
      await Promise.all(
        [...pendingReports.values()]
          .filter((queued) => queued.namespace === namespace.name)
          .map((queued) => queued.promise),
      );
      return (await threadStore.list(namespace)).map(validateRecord);
    },
    async updateHostMetadata(
      namespace,
      threadId,
      patch,
    ): Promise<ThreadRecord> {
      // The merge now spans awaits, so it shares the thread's up-report queue:
      // every writer of one record reads what the previous writer persisted.
      // A rejected patch is reported to this caller alone and never queued, so
      // a refused merge cannot fail a later `record` read.
      const merged = (
        pendingReports.get(threadId)?.promise ?? Promise.resolve()
      ).then(async () => {
        const record = await threadStore.get(namespace, threadId);
        if (!record) {
          throw new AgenetesError(
            'thread_not_found',
            `cannot update host metadata for missing thread '${namespace.name}/${threadId}'`,
            { namespace: namespace.name, threadId },
          );
        }
        const hostMetadata = copyHostMetadata(
          {
            ...record.hostMetadata,
            ...copyHostMetadata(patch, 'invalid_host_metadata'),
          },
          'invalid_host_metadata',
        );
        const updated = { ...record, hostMetadata };
        await threadStore.upsert(namespace, threadId, updated);
        return updated;
      });
      pendingReports.set(threadId, {
        namespace: namespace.name,
        promise: merged.then(
          () => undefined,
          () => undefined,
        ),
      });
      const updated = await merged;
      return {
        ...updated,
        hostMetadata: copyHostMetadata(
          updated.hostMetadata ?? {},
          'invalid_host_metadata',
        ),
      };
    },
    notifications(
      threadId: string,
      namespace?: Namespace,
    ): AsyncIterable<AgentMetadata> {
      return bus.subscribe(threadId, namespace?.name);
    },
    async logMetadata(
      namespace: Namespace,
      threadId: string,
    ): Promise<ThreadLogMetadata> {
      return {
        eventCount: await eventLog.maxSeq(namespace, threadId),
        turnCount: await turnStore.count(namespace, threadId),
      };
    },
    async history(
      namespace: Namespace,
      threadId: string,
      options?: HistoryOptions,
    ): Promise<ThreadHistory> {
      return {
        turns: await readHistory(
          namespace,
          threadId,
          options?.withTail === true,
        ),
      };
    },
    async historyPage(
      namespace: Namespace,
      threadId: string,
      options: HistoryPageOptions,
    ): Promise<ThreadHistoryPage> {
      const includeTail =
        options.before === undefined && options.withTail === true;
      // The fence, the tail events and the page are three reads of a log that
      // a running turn is still writing. A turn that folds between the first
      // and the last lands in both halves of the answer: `page` returns it as
      // a persisted turn while the tail still projects its events as the
      // active one, and the caller sees one turn twice. So the fold boundary
      // is read again after paging, and a page assembled across a fold is
      // discarded and rebuilt against the settled layout. A boundary that
      // keeps moving under repeated attempts answers from the persisted page
      // alone — a turn behind, rather than self-contradictory.
      let wantTail = includeTail;
      for (let attempt = 1; ; attempt += 1) {
        const fence = await turnStore.fence(namespace, threadId);
        const tail = wantTail
          ? materializeHistory(
              [],
              await eventLog.readRecords(namespace, threadId, fence),
            )[0]
          : undefined;
        const tailStartsGroup = tail !== undefined && tail.request !== null;
        const persistedLimit =
          tailStartsGroup && options.limit > 1
            ? options.limit - 1
            : options.limit;
        const page = await turnStore.page(namespace, threadId, {
          limit: persistedLimit,
          ...(options.before ? { before: options.before } : {}),
        });
        if (
          wantTail &&
          (await turnStore.fence(namespace, threadId)) !== fence
        ) {
          wantTail = attempt < MAX_HISTORY_PAGE_ATTEMPTS;
          continue;
        }
        let groups: ThreadHistoryGroup[] = page.groups.map((group) => ({
          id: group.id,
          turns: group.turns.map(({ turn }) => turn),
        }));
        let before = page.before;
        let hasMore = page.hasMore;

        if (tail) {
          if (tailStartsGroup) {
            if (options.limit === 1) {
              hasMore = page.groups.length > 0;
              before = hasMore ? page.next : undefined;
              groups = [];
            } else {
              groups = groups.slice(-(options.limit - 1));
            }
            groups.push({
              id: page.next,
              turns: [tail],
              isActive: true,
              activeTurnIndex: 0,
            });
          } else if (groups.length > 0) {
            const latest = groups[groups.length - 1]!;
            groups[groups.length - 1] = {
              ...latest,
              turns: [...latest.turns, tail],
              isActive: true,
              activeTurnIndex: latest.turns.length,
            };
          } else {
            groups = [
              {
                id: page.next,
                turns: [tail],
                isActive: true,
                activeTurnIndex: 0,
              },
            ];
          }
        }

        return {
          groups,
          ...(before ? { before } : {}),
          hasMore,
        };
      }
    },
    tail(
      namespace: Namespace,
      threadId: string,
    ): AsyncIterable<AgentStreamEvent> {
      return createTail(eventLog, namespace, threadId, () =>
        turnStore.fence(namespace, threadId),
      );
    },
  };
  // Async persistence adds scheduling points to the former synchronous
  // lifecycle. Keep create/fork/rehome/close mutually exclusive so a move
  // cannot race a spawn or a second move across its compensation boundary.
  let lifecycle: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycle.catch(() => {}).then(operation);
    lifecycle = result;
    return result;
  };
  return {
    ...api,
    create: (spec) => serialize(() => api.create(spec)),
    fork: (source, target) => serialize(() => api.fork(source, target)),
    rehome: (source, target) => serialize(() => api.rehome(source, target)),
    close: (threadId) => serialize(() => api.close(threadId)),
  };
}
