// The bootstrap surface (README I9.5) — a driver-factory dictionary that
// fixes drivers as static wiring at mount time. `mountAgenetes()` returns
// an accumulating, type-safe builder:
//
//   - standard ACP and pi factories are present from the start;
//   - `.addFactory(factoryName, factory)` grows the factory dictionary,
//     threading a
//     `factoryName → cfg` type map through the builder generics so a later
//     `.register` is checked against the named factory (no `unknown`, no
//     hand-written registry interface);
//   - `.register(driverName, factoryName, factoryArgs)` instantiates a
//     driver: which factory builds which contract `kind`, with what args.
//     `driverName` IS the dispatch `kind` (I5) — the I5.1 alias between the
//     implementation identity (`factoryName`, e.g. `acp`) and the contract
//     `kind` (`driverName`, e.g. `external`); and
//   - `.build()` runs every registration and returns the mounted
//     {@link Agenetes} instance.
//
// All `factoryArgs` are bootstrap-time DI below the handle I/O seam, so
// (unlike per-turn handle inputs, I8.5) they may carry live objects / the
// logger. This module fixes only the mechanism; whether a factory mounts
// its own transport or receives a shared reference is an impl choice.

import {
  acpDriverFactory,
  type AcpDriverFactoryConfig,
} from '@agenetes/acp-driver';
import {
  piDriverFactory,
  type PiDriverFactoryConfig,
} from '@agenetes/pi-driver';
import { createAgentRuntime } from '@agenetes/runtime';

import {
  EventLog,
  InMemoryEventLogStore,
  type EventLogStore,
} from './event-log.js';
import {
  createAgenetesInstance,
  type Agenetes,
  type WorkloadSpecShape,
} from './instance.js';
import {
  DEFAULT_AUTO_RECOVER_POLICY,
  type AutoRecoverPolicy,
} from './recovery.js';
import { InMemoryThreadStore, type ThreadStore } from './thread-store.js';
import { InMemoryTurnStore, type TurnStore } from './turn-store.js';

import type { AgentDriver, AgentHandle } from '@agenetes/runtime';

/**
 * A driver factory: constructs one {@link AgentDriver} from its
 * bootstrap-time config `cfg`. A factory with no config uses `void`.
 */
export type DriverFactory<TCfg = void> = (cfg: TCfg) => AgentDriver;

/** Standard factories available on every newly mounted builder. */
export interface StandardDriverFactoryMap {
  readonly acp: DriverFactory<AcpDriverFactoryConfig>;
  readonly pi: DriverFactory<PiDriverFactoryConfig>;
}

/** The config type a registered factory named `FN` expects. */
type CfgOf<FMap, FN extends keyof FMap> =
  FMap[FN] extends DriverFactory<infer TCfg> ? TCfg : never;

/**
 * `.register`'s third parameter is required only when the named factory
 * declares a non-`void` config, so a config-less factory registers with
 * just `(driverName, factoryName)`.
 */
type RegisterArgs<FMap, FN extends keyof FMap> =
  CfgOf<FMap, FN> extends void ? [] : [factoryArgs: CfgOf<FMap, FN>];

/**
 * The accumulating I9.5 builder. `FMap` is the `factoryName → factory`
 * type map grown by `.addFactory`; it is what makes `.register`'s args
 * type-safe against the named factory.
 */
export interface AgenetesBuilder<FMap = Record<never, never>> {
  /**
   * Append a driver factory under `factoryName`, widening the builder's
   * factory-type map. Re-adding a name replaces its factory.
   */
  addFactory<FN extends string, TCfg>(
    factoryName: FN,
    factory: DriverFactory<TCfg>,
  ): AgenetesBuilder<FMap & Record<FN, DriverFactory<TCfg>>>;
  /**
   * Instantiate a driver: `factoryName` builds the contract `kind`
   * `driverName` with `factoryArgs` (checked against the named factory).
   */
  register<FN extends keyof FMap & string>(
    driverName: string,
    factoryName: FN,
    ...factoryArgs: RegisterArgs<FMap, FN>
  ): AgenetesBuilder<FMap>;
  /** Run every registration and return the mounted instance. */
  build<
    TSpec extends WorkloadSpecShape = WorkloadSpecShape,
    THandle extends AgentHandle = AgentHandle,
  >(): Agenetes<TSpec, THandle>;
}

interface Registration {
  readonly driverName: string;
  readonly factoryName: string;
  readonly factoryArgs: unknown;
}

/** Options for {@link mountAgenetes}. */
export interface MountAgenetesOptions {
  /**
   * Instance-wide gate for driver-requested folded-history loading.
   * Defaults to automatic recovery up to 10,000 estimated tokens and deny
   * above the threshold.
   */
  autoRecoverPolicy?: AutoRecoverPolicy;
  /**
   * The durable thread-record backing for the query surface (I9.4).
   * Defaults to an in-memory store; a host wires an ACP-session-store
   * adapter here at M5 E2 for restart-surviving records.
   */
  threadStore?: ThreadStore;
  /**
   * The Tier-1 event-log backing for the two-tier conversation log (I9.8).
   * Defaults to an in-memory store; a host wires {@link FileEventLogStore}
   * for a restart-surviving `<ns.root>/chat_v2/<threadId>.events.jsonl`. The
   * instance wraps it in an {@link EventLog} for the live-tail pub/sub.
   */
  eventLogStore?: EventLogStore;
  /**
   * The Tier-2 folded-turn backing for the two-tier conversation log
   * (I9.8). Defaults to an in-memory store; a host wires
   * {@link FileTurnStore} for a restart-surviving
   * `<ns.root>/chat_v2/<threadId>.turns.jsonl`.
   */
  turnStore?: TurnStore;
}

/**
 * Open an {@link AgenetesBuilder} (README I9.5) with the standard ACP and
 * pi factories already available for registration.
 */
export function mountAgenetes(
  options: MountAgenetesOptions = {},
): AgenetesBuilder<StandardDriverFactoryMap> {
  const factories = new Map<string, DriverFactory<never>>([
    ['acp', acpDriverFactory as DriverFactory<never>],
    ['pi', piDriverFactory as DriverFactory<never>],
  ]);
  const registrations: Registration[] = [];
  const threadStore = options.threadStore ?? new InMemoryThreadStore();
  const eventLog = new EventLog(
    options.eventLogStore ?? new InMemoryEventLogStore(),
  );
  const turnStore = options.turnStore ?? new InMemoryTurnStore();
  const autoRecoverPolicy =
    options.autoRecoverPolicy ?? DEFAULT_AUTO_RECOVER_POLICY;

  const builder: AgenetesBuilder<StandardDriverFactoryMap> = {
    addFactory(factoryName, factory) {
      factories.set(factoryName, factory as DriverFactory<never>);
      return builder as never;
    },
    register(driverName, factoryName, ...factoryArgs) {
      registrations.push({
        driverName,
        factoryName: factoryName as string,
        factoryArgs: (factoryArgs as unknown[])[0],
      });
      return builder as never;
    },
    build<
      TSpec extends WorkloadSpecShape = WorkloadSpecShape,
      THandle extends AgentHandle = AgentHandle,
    >() {
      const runtime = createAgentRuntime();
      for (const { driverName, factoryName, factoryArgs } of registrations) {
        const factory = factories.get(factoryName);
        if (!factory) {
          throw new Error(
            `no driver factory named '${factoryName}' for driver '${driverName}'`,
          );
        }
        const driver = factory(factoryArgs as never);
        // `driverName` is the dispatch `kind` (I5.1 alias): register under
        // the contract kind. The driver carries no `kind` of its own —
        // dispatch is external, supplied here as the first `register` arg.
        runtime.register(driverName, driver);
      }
      return createAgenetesInstance<TSpec, THandle>(
        runtime,
        threadStore,
        eventLog,
        turnStore,
        autoRecoverPolicy,
      );
    },
  };

  return builder;
}
