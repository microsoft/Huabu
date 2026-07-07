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

import type { AgentHandle, AgentRuntime } from '@agenetes/runtime';
import type {
  AgentMetadata,
  AgentStateSnapshot,
  Namespace,
  WorkloadType,
} from '@agenetes/protocol';

import { type ThreadRecord, type ThreadStore } from './thread-store.js';
import { ThreadNotificationBus } from './notifications.js';

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
  record(namespace: Namespace, threadId: string): ThreadRecord<TSpec> | undefined;
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
}

/**
 * Construct the instance over an already-populated {@link AgentRuntime}
 * (the driver registry + live-handle table) and a {@link ThreadStore} (the
 * durable thread table). Callers normally reach this through the
 * `mountAgenetes` builder (I9.5), which assembles the runtime from the
 * driver-factory dictionary; it is exported for hosts that already own a
 * runtime.
 */
export function createAgenetesInstance<
  TSpec extends WorkloadSpecShape = WorkloadSpecShape,
  THandle extends AgentHandle = AgentHandle,
>(runtime: AgentRuntime, threadStore: ThreadStore): Agenetes<TSpec, THandle> {
  // The instance is the SOLE ThreadStore writer and the owner of the
  // per-thread notification fan-out (I9.7). It registers ONE up-report
  // listener per live Deployment handle (keyed by threadId) and tears it
  // down at close; the handle is the sole folder, the instance the sole
  // persister + re-emitter.
  const bus = new ThreadNotificationBus();
  const unsubscribers = new Map<string, () => void>();

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

  return {
    create(spec: TSpec): THandle {
      const driver = runtime.resolve(spec.kind);
      if (!driver) {
        throw new Error(`no agent driver registered for kind '${spec.kind}'`);
      }
      // Down-feed (I9.7): read the durable snapshot last persisted for this
      // thread and hand it to the driver at create time, so a returning
      // handle resumes/rehydrates from it instead of reading a store. A
      // fresh thread has no record → `undefined`. `state: {}` (a live but
      // never-up-reported thread) also feeds through as an empty snapshot.
      const prior = spec.threadId
        ? threadStore.get<TSpec>(spec.namespace, spec.threadId)
        : undefined;
      const priorState = prior?.state;
      // Dispatch the lifecycle axis (I3.2) off the control-plane
      // `workloadType`, orthogonal to the driver route (`kind`): a Job is
      // minted fresh per turn and never enters the live-handle table (so
      // `get(threadId)` stays undefined and `close()` is a no-op for it),
      // while a Deployment get-or-creates + caches the long-lived handle
      // keyed by `threadId` (reuse ignores spec — no reconcile).
      let handle: AgentHandle;
      if (spec.workloadType === 'Job') {
        handle = driver.create(spec, priorState);
      } else {
        // Detect a *fresh* create vs a get-or-create reuse so the up-report
        // listener is wired exactly once per handle (reuse ignores spec).
        const wasLive = runtime.get(spec.threadId) !== undefined;
        handle = runtime.create(spec.threadId, () =>
          driver.create(spec, priorState),
        );
        if (!wasLive) wireUpReport(spec, handle);
      }
      // Persist a durable record only when the workload has a real thread
      // identity. A Deployment always does (its `threadId` is also the
      // live-table cache key). A Job usually carries a thread too, but a
      // *transient* Job — a stateless one-shot invoked with an empty
      // `threadId` (e.g. the host's memory / sketch / reachback turns) —
      // has no durable identity to key on, so it writes nothing: an empty
      // key would otherwise collide across every transient Job in the same
      // namespace and accumulate junk records nobody reads.
      const isTransientJob = spec.workloadType === 'Job' && !spec.threadId;
      if (!isTransientJob) {
        // Refresh the spec (recipe rides it, L1-baked) but PRESERVE the
        // durable state: create must never clobber a thread's up-reported
        // sessionId/metadata back to empty. A brand-new thread seeds `{}`.
        threadStore.upsert(spec.namespace, spec.threadId, {
          spec,
          state: priorState ?? {},
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
  };
}
