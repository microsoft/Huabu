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
import type { Namespace } from '@agenetes/protocol';

import {
  AgentPersistentState,
  type ThreadRecord,
  type ThreadStore,
} from './thread-store.js';

/**
 * The minimal shape the instance reads off a `WorkloadSpec` (I9.6). The
 * host composes the concrete closed union from the `@agenetes/protocol`
 * building blocks; the instance stays generic over it and only needs the
 * three identity/dispatch fields — `threadId` (I4.2), `kind` (I5), and the
 * `namespace` (I4.1) it persists the durable record under.
 */
export interface WorkloadSpecShape {
  readonly threadId: string;
  readonly kind: string;
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
   * Get-or-create by `spec.threadId`, dispatching on `spec.kind` (I9.3):
   * `resolve(spec.kind).create(spec)` internally. An existing live handle
   * is returned as-is — **reuse ignores spec**, no reconcile (changing a
   * spec is an explicit `close()` + `create()` the caller decides). Also
   * upserts the durable thread record so the query surface can read it
   * independent of handle liveness (I9.4).
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
  return {
    create(spec: TSpec): THandle {
      const handle = runtime.create(spec.threadId, () => {
        const driver = runtime.resolve(spec.kind);
        if (!driver) {
          throw new Error(`no agent driver registered for kind '${spec.kind}'`);
        }
        // End-state dispatch (I9.3): the driver's factory takes the spec.
        // Drivers still on object-injection inputs conform at M5 C4b/E2.
        return driver.create(spec);
      });
      threadStore.upsert(spec.namespace, spec.threadId, {
        spec,
        state: new AgentPersistentState(spec.namespace.storage?.root),
      });
      return handle as THandle;
    },
    get(threadId: string): THandle | undefined {
      return runtime.get(threadId) as THandle | undefined;
    },
    close(threadId: string): void {
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
  };
}
