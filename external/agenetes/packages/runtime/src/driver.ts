import { AgenetesError } from './errors.js';
import { threadIdentityKey } from './realization.js';

import type { AgentHandle } from './handle.js';
import type { AgentCreateContext, ThreadIdentity } from './realization.js';
import type {
  AgentSpec,
  AgentStateSnapshot,
  AgentStreamEvent,
  AgentSubmission,
  Namespace,
  WorkloadSpec,
  WorkloadType,
} from '@agenetes/protocol';

/** Runtime-schema subset implemented by Zod schemas without coupling runtime to Zod. */
export interface RuntimeSchema<T> {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: unknown };
}

export type TypedWorkloadSpec<TSpec> = Omit<WorkloadSpec, 'spec'> & {
  readonly spec: TSpec;
};

/** A strongly typed driver implementation before heterogeneous-map erasure. */
export interface AgentDriver<
  TSpec extends AgentSpec = AgentSpec,
  TDriverState = unknown,
  TSubmission extends AgentSubmission = AgentSubmission,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
> {
  create(
    workload: TypedWorkloadSpec<TSpec>,
    context: AgentCreateContext<TDriverState>,
  ): AgentHandle<TSubmission, TResult, TEvent, TTurnCtx, TDriverState>;
}

export interface DriverDefinition<
  TSpec extends AgentSpec,
  TDriverState,
  TSubmission extends AgentSubmission = AgentSubmission,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
> {
  readonly schemaVersion: number;
  readonly workloadTypes: readonly WorkloadType[];
  readonly specSchema: RuntimeSchema<TSpec>;
  readonly stateSchema: RuntimeSchema<TDriverState>;
  readonly initialState: () => TDriverState;
  readonly create: AgentDriver<
    TSpec,
    TDriverState,
    TSubmission,
    TResult,
    TEvent,
    TTurnCtx
  >['create'];
}

/** Type-erased driver stored in the static heterogeneous DriverMap. */
export interface MountedAgentDriver {
  readonly schemaVersion: number;
  readonly workloadTypes: readonly WorkloadType[];
  validateSpec(raw: unknown): unknown;
  validateState(raw: unknown): unknown;
  initialState(): unknown;
  create(workload: WorkloadSpec, context: AgentCreateContext): AgentHandle;
}

export type DriverMap = Readonly<Record<string, MountedAgentDriver>>;

function parseOrThrow<T>(
  schema: RuntimeSchema<T>,
  raw: unknown,
  code: 'invalid_driver_spec' | 'invalid_driver_state',
): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new AgenetesError(code, code.replaceAll('_', ' '), parsed.error);
}

/**
 * Bind one driver's schemas to its typed implementation, then erase its
 * generics for storage in the mounted heterogeneous DriverMap.
 */
export function defineDriver<
  TSpec extends AgentSpec,
  TDriverState,
  TSubmission extends AgentSubmission = AgentSubmission,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
>(
  definition: DriverDefinition<
    TSpec,
    TDriverState,
    TSubmission,
    TResult,
    TEvent,
    TTurnCtx
  >,
): MountedAgentDriver {
  if (
    !Number.isSafeInteger(definition.schemaVersion) ||
    definition.schemaVersion < 1 ||
    definition.workloadTypes.length === 0
  ) {
    throw new AgenetesError(
      'invalid_driver_definition',
      'driver definition requires a positive schemaVersion and workload type',
    );
  }

  const validateSpec = (raw: unknown): TSpec =>
    parseOrThrow(definition.specSchema, raw, 'invalid_driver_spec');
  const validateState = (raw: unknown): TDriverState =>
    parseOrThrow(definition.stateSchema, raw, 'invalid_driver_state');

  return {
    schemaVersion: definition.schemaVersion,
    workloadTypes: [...definition.workloadTypes],
    validateSpec,
    validateState,
    initialState: () => validateState(definition.initialState()),
    create(workload, context) {
      const spec = validateSpec(workload.spec);
      const recoveryInput = context.recoveryInput
        ? {
            ...context.recoveryInput,
            state: {
              ...context.recoveryInput.state,
              driverState: validateState(
                context.recoveryInput.state.driverState,
              ),
            },
          }
        : undefined;
      const handle = definition.create(
        { ...workload, spec },
        {
          recovery: context.recovery,
          ...(recoveryInput ? { recoveryInput } : {}),
          ...(context.forkInput ? { forkInput: context.forkInput } : {}),
        },
      );

      if (!handle.onState) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'onState') {
            return (
              listener: (snapshot: AgentStateSnapshot) => void,
            ): (() => void) =>
              target.onState!((snapshot) => {
                listener({
                  ...snapshot,
                  driverState: validateState(snapshot.driverState),
                });
              });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

/**
 * Runtime registry for the static driver map plus live Deployment handles.
 * Driver entries cannot be mutated after construction.
 */
export interface AgentRuntime {
  resolve(kind: string): MountedAgentDriver | undefined;
  readonly kinds: readonly string[];
  /** Unqualified compatibility resolves only one live handle; ambiguity throws. */
  get(threadId: string, namespace?: Namespace): AgentHandle | undefined;
  /** Resolve a live handle's captured identity; unqualified ambiguity refuses. */
  getIdentity(
    threadId: string,
    namespace?: Namespace,
  ): ThreadIdentity | undefined;
  getOrCreate(
    threadId: string,
    createHandle: () => AgentHandle,
    namespace?: Namespace,
  ): AgentHandle;
  close(threadId: string, namespace?: Namespace): Promise<void>;
}

export function createAgentRuntime(drivers: DriverMap): AgentRuntime {
  // A logical thread ID may exist in several namespace partitions. The
  // captured identity is the one owner of each live handle's process key.
  const handles = new Map<
    string,
    {
      handle: AgentHandle;
      identity: { threadId: string; namespace?: Namespace };
    }
  >();
  const lookup = (threadId: string, namespace?: Namespace) => {
    if (namespace)
      return handles.get(threadIdentityKey({ threadId, namespace }));
    const matches = [...handles.values()].filter(
      (entry) => entry.identity.threadId === threadId,
    );
    if (matches.length > 1)
      throw new AgenetesError(
        'invalid_workload',
        'Thread ID is ambiguous without its namespace',
        { reason: 'ambiguous_thread', threadId },
      );
    return matches[0];
  };
  const kinds = Object.keys(drivers);
  return {
    resolve: (kind) => drivers[kind],
    kinds,
    get: (threadId, namespace) => lookup(threadId, namespace)?.handle,
    getIdentity(threadId, namespace) {
      const identity = lookup(threadId, namespace)?.identity;
      return identity?.namespace
        ? { threadId, namespace: identity.namespace }
        : undefined;
    },
    getOrCreate(threadId, createHandle, namespace) {
      const existing = lookup(threadId, namespace);
      if (existing) return existing.handle;
      const created = createHandle();
      // Namespace is caller-owned data. Capture its identity fields so a later
      // mutation or storage relocation cannot strand this registry entry.
      const identity = {
        threadId,
        namespace: namespace
          ? Object.freeze({
              ...namespace,
              ...(namespace.storage
                ? { storage: Object.freeze({ ...namespace.storage }) }
                : {}),
            })
          : undefined,
      };
      handles.set(threadIdentityKey(identity), { handle: created, identity });
      return created;
    },
    async close(threadId, namespace) {
      const entry = lookup(threadId, namespace);
      if (!entry) return;
      await entry.handle.close();
      const key = threadIdentityKey(entry.identity);
      if (handles.get(key) === entry) handles.delete(key);
    },
  };
}
