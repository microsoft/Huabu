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
  agentRequestBaseSchema,
} from '@agenetes/protocol';

import {
  EventLog,
  InMemoryEventLogStore,
  type EventLogEntry,
} from './event-log.js';
import { createTranscriptFolder } from './fold.js';
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
  AgentRequest,
  AgentStateSnapshot,
  AgentStreamEvent,
  AgentTurn,
  AgentTurnMeta,
  Namespace,
  WorkloadType,
} from '@agenetes/protocol';
import type {
  AgentCreateContext,
  AgentHandle,
  AgentRuntime,
} from '@agenetes/runtime';

/**
 * The minimal shape the instance reads off a `WorkloadSpec` (I9.6). The
 * host composes the concrete closed union from the `@agenetes/protocol`
 * building blocks; the instance stays generic over it and only needs the
 * identity/dispatch fields — `threadId` (I4.2), the driver route `kind`
 * (I5), the lifecycle axis `workloadType` (I3.2, orthogonal to `kind`),
 * and the `namespace` (I4.1) it persists the durable record under.
 */
export interface WorkloadSpecShape {
  readonly threadId: string;
  readonly kind: string;
  readonly workloadType: WorkloadType;
  readonly namespace: Namespace;
}

/**
 * The runtime + query surface the host drives (I9.3 / I9.4). Generic over
 * the host's concrete `WorkloadSpec` (`TSpec`) and the handle I/O types the
 * host's drivers produce; both default to the widest shape so a caller can
 * bind only what it needs.
 */
export interface Agenetes<
  TSpec extends WorkloadSpecShape = WorkloadSpecShape,
  THandle extends AgentHandle = AgentHandle,
> {
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
  create(spec: TSpec): THandle;
  /**
   * Pure lookup of the live handle for `threadId` — **never spawns**
   * (I9.3). A missing handle is a precondition failure (e.g. a control
   * write on a dead thread), not a lazy spawn.
   */
  get(threadId: string): THandle | undefined;
  /** Tear the live handle down and evict it from the live table (I9.3). */
  close(threadId: string): void;
  /**
   * Read one durable thread record by `(namespace, threadId)` (I9.4),
   * independent of whether a handle is live.
   */
  record(
    namespace: Namespace,
    threadId: string,
  ): ThreadRecord<TSpec> | undefined;
  /** Enumerate a namespace's persisted thread records (I9.4). */
  records(namespace: Namespace): ThreadRecord<TSpec>[];
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
   * Read a thread's durable conversation as folded {@link AgentTurn}s
   * (Tier 2 of the two-tier log, README I9.8) — the driver-agnostic,
   * seq-free replay view. With `withTail`, also returns a live `tail`
   * fenced to just after the last folded turn, so a caller can render the
   * committed history AND follow the in-flight turn from one call without
   * ever seeing a sequence number (the fence stays L2-internal).
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
   * Also return a live `tail` fenced to just after the last folded turn.
   * The fence (a Tier-1 `seq`) is composed and consumed entirely inside
   * L2; it never appears in the returned value (I9.8).
   */
  readonly withTail?: boolean;
}

/** The result of {@link Agenetes.history}. */
export interface ThreadHistory {
  /** The folded conversation, in turn order (Tier 2). */
  readonly turns: AgentTurn[];
  /** Present only when `withTail` was set: the fenced live tail. */
  readonly tail?: AsyncIterable<AgentStreamEvent>;
}

/** Stream frames that terminate a run's live tail (README I8 run contract). */
const TERMINAL_EVENT_TYPES = new Set<string>([
  AGENT_STREAM_EVENTS.End,
  AGENT_STREAM_EVENTS.Error,
]);

/**
 * Coerce a `run(request, …)` argument into the persisted, driver-agnostic
 * {@link AgentRequest} for a folded turn. A logged handle binds `TRequest`
 * to `AgentRequest` (README I8/I9.8 convention), so this normally validates
 * as-is; a `null` request (a resume turn) persists as `null`; anything that
 * does not match the contract degrades to `null` (tolerant — the driver
 * owns returning the protocol shape, the log never throws on it).
 */
function coerceRequest(request: unknown): AgentRequest | null {
  if (request == null) return null;
  const parsed = agentRequestBaseSchema.safeParse(request);
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
 * normally reach this through the `mountAgenetes` builder (I9.5), which
 * assembles the runtime from the driver-factory dictionary and defaults the
 * log backings; it is exported for hosts that already own a runtime. The
 * log backings default to their in-memory variants so a direct caller can
 * omit them.
 */
export function createAgenetesInstance<
  TSpec extends WorkloadSpecShape = WorkloadSpecShape,
  THandle extends AgentHandle = AgentHandle,
>(
  runtime: AgentRuntime,
  threadStore: ThreadStore,
  eventLog: EventLog = new EventLog(new InMemoryEventLogStore()),
  turnStore: TurnStore = new InMemoryTurnStore(),
  autoRecoverPolicy: AutoRecoverPolicy = DEFAULT_AUTO_RECOVER_POLICY,
): Agenetes<TSpec, THandle> {
  // The instance is the SOLE ThreadStore writer and the owner of the
  // per-thread notification fan-out (I9.7). It registers ONE up-report
  // listener per live Deployment handle (keyed by threadId) and tears it
  // down at close; the handle is the sole folder, the instance the sole
  // persister + re-emitter.
  const bus = new ThreadNotificationBus();
  const unsubscribers = new Map<string, () => void>();
  const recovery = createAgentRecoveryContext(autoRecoverPolicy);

  // Register the handle's up-report listener: persist the full snapshot
  // FIRST (sole writer), then re-emit its metadata (persist-then-notify).
  // A handle without `onState` (a driver that reports no out-of-turn meta)
  // wires nothing and its notification stream stays empty.
  const wireUpReport = (spec: TSpec, handle: AgentHandle): void => {
    const unsub = handle.onState?.((snapshot: AgentStateSnapshot) => {
      threadStore.upsert(spec.namespace, spec.threadId, {
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
      request: unknown,
    ): AsyncGenerator<AgentStreamEvent, unknown> {
      const seqStart = eventLog.maxSeq(namespace, threadId) + 1;
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
        request: coerceRequest(request),
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
            request: unknown,
            render: unknown,
            ctx: unknown,
          ): AsyncGenerator<AgentStreamEvent, unknown> =>
            loggingRun(
              (
                target.run as (
                  r: unknown,
                  rn: unknown,
                  c: unknown,
                ) => AsyncGenerator<AgentStreamEvent, unknown>
              )(request, render, ctx),
              request,
            );
        }
        // Forward every other member to the backing handle. Bind methods to
        // the target so private state / getters resolve against the real
        // instance, not the proxy.
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  return {
    create(spec: TSpec): THandle {
      // A persisted same-thread spec is authoritative across restart,
      // preserving reuse-ignores-spec semantics when no live handle exists.
      const prior = spec.threadId
        ? threadStore.get<TSpec>(spec.namespace, spec.threadId)
        : undefined;
      const targetSpec =
        prior?.spec.workloadType === 'Deployment' ? prior.spec : spec;
      const driver = runtime.resolve<TSpec>(targetSpec.kind);
      if (!driver) {
        throw new Error(
          `no agent driver registered for kind '${targetSpec.kind}'`,
        );
      }
      const context: AgentCreateContext<TSpec> = {
        ...(prior
          ? {
              durableInput: {
                source: {
                  namespace: spec.namespace,
                  threadId: spec.threadId,
                },
                record: prior,
                turns: turnStore
                  .list(spec.namespace, spec.threadId)
                  .map(({ turn }) => turn),
              },
            }
          : {}),
        recovery,
      };
      // Dispatch the lifecycle axis (I3.2) off the control-plane
      // `workloadType`, orthogonal to the driver route (`kind`): a Job is
      // minted fresh per turn and never enters the live-handle table (so
      // `get(threadId)` stays undefined and `close()` is a no-op for it),
      // while a Deployment get-or-creates + caches the long-lived handle
      // keyed by `threadId` (reuse ignores spec — no reconcile).
      let handle: AgentHandle;
      if (targetSpec.workloadType === 'Job') {
        // A Job is minted fresh per turn and never enters the live-handle
        // table (so `get(threadId)` stays undefined and `close()` is a no-op
        // for it). It is still LOGGED when it carries a durable `threadId` —
        // a threaded Job (e.g. the host's built-in chat) is a multi-turn
        // conversation whose transcript must persist, so we decorate it
        // per-turn to feed the two-tier log (I9.8). A *transient* Job (empty
        // `threadId` — a stateless one-shot) has no thread to log against and
        // runs raw.
        const raw = driver.create(targetSpec, context);
        handle =
          targetSpec.threadId.length > 0
            ? decorateForLogging(raw, targetSpec.namespace, targetSpec.threadId)
            : raw;
      } else {
        // Detect a *fresh* create vs a get-or-create reuse so the up-report
        // listener is wired exactly once per handle (reuse ignores spec).
        const wasLive = runtime.get(targetSpec.threadId) !== undefined;
        // Decorate INSIDE the factory so the live-handle table caches the
        // logging handle: both this `create` return and every later
        // `get(threadId)` yield the same log-feeding handle.
        handle = runtime.create(targetSpec.threadId, () =>
          decorateForLogging(
            driver.create(targetSpec, context),
            targetSpec.namespace,
            targetSpec.threadId,
          ),
        );
        if (!wasLive) wireUpReport(targetSpec, handle);
      }
      // Persist a durable record only when the workload has a real thread
      // identity. A Deployment always does (its `threadId` is also the
      // live-table cache key). A Job usually carries a thread too, but a
      // *transient* Job — a stateless one-shot invoked with an empty
      // `threadId` (e.g. the host's memory / sketch / reachback turns) —
      // has no durable identity to key on, so it writes nothing: an empty
      // key would otherwise collide across every transient Job in the same
      // namespace and accumulate junk records nobody reads.
      const isTransientJob =
        targetSpec.workloadType === 'Job' && !targetSpec.threadId;
      if (!isTransientJob) {
        // Preserve both the authoritative durable spec and up-reported
        // state. A brand-new thread seeds its target spec with empty state.
        threadStore.upsert(targetSpec.namespace, targetSpec.threadId, {
          spec: targetSpec,
          state: prior?.state ?? {},
        });
      }
      return handle as THandle;
    },
    get(threadId: string): THandle | undefined {
      return runtime.get(threadId) as THandle | undefined;
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
    record(
      namespace: Namespace,
      threadId: string,
    ): ThreadRecord<TSpec> | undefined {
      return threadStore.get<TSpec>(namespace, threadId);
    },
    records(namespace: Namespace): ThreadRecord<TSpec>[] {
      return threadStore.list<TSpec>(namespace);
    },
    notifications(threadId: string): AsyncIterable<AgentMetadata> {
      return bus.subscribe(threadId);
    },
    history(
      namespace: Namespace,
      threadId: string,
      options?: HistoryOptions,
    ): ThreadHistory {
      const turns = turnStore
        .list(namespace, threadId)
        .map((persisted) => persisted.turn);
      if (!options?.withTail) return { turns };
      // Fence the live tail to just after the last folded turn and compose
      // it internally — the seq never surfaces to L1 (I9.8).
      const fence = turnStore.fence(namespace, threadId);
      return { turns, tail: createTail(eventLog, namespace, threadId, fence) };
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
