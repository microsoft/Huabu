import { AgenetesError } from './errors.js';

import type { AgentHandle } from './handle.js';
import type { AgentCreateContext } from './realization.js';
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
  get(threadId: string, namespace?: Namespace): AgentHandle | undefined;
  getOrCreate(
    threadId: string,
    createHandle: () => AgentHandle,
    namespace?: Namespace,
  ): AgentHandle;
  close(threadId: string, namespace?: Namespace): Promise<void>;
}

export function createAgentRuntime(drivers: DriverMap): AgentRuntime {
  // Namespace ownership lives with the cached handle. Lifecycle callers check
  // it before persisting a new thread record as well as when reusing a handle.
  const handles = new Map<
    string,
    { handle: AgentHandle; namespace?: Namespace }
  >();
  const lookup = (threadId: string, namespace?: Namespace) => {
    const entry = handles.get(threadId);
    if (
      entry &&
      namespace &&
      entry.namespace &&
      (entry.namespace.name !== namespace.name ||
        entry.namespace.ownerId !== namespace.ownerId ||
        (!namespace.ownerId &&
          entry.namespace.storage?.root !== namespace.storage?.root))
    )
      throw new AgenetesError(
        'invalid_workload',
        'Thread is live in another namespace',
      );
    return entry?.handle;
  };
  const kinds = Object.keys(drivers);
  return {
    resolve: (kind) => drivers[kind],
    kinds,
    get: lookup,
    getOrCreate(threadId, createHandle, namespace) {
      const existing = lookup(threadId, namespace);
      if (existing) return existing;
      const created = createHandle();
      handles.set(threadId, { handle: created, namespace });
      return created;
    },
    async close(threadId, namespace) {
      const handle = lookup(threadId, namespace);
      if (!handle) return;
      await handle.close();
      handles.delete(threadId);
    },
  };
}
