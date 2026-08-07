import { createAgentRuntime } from '@agenetes/runtime';

import {
  EventLog,
  InMemoryEventLogStore,
  type EventLogStore,
} from './event-log.js';
import { createAgenetesInstance, type Agenetes } from './instance.js';
import {
  DEFAULT_AUTO_RECOVER_POLICY,
  type AutoRecoverPolicy,
} from './recovery.js';
import { InMemoryThreadStore, type ThreadStore } from './thread-store.js';
import { InMemoryTurnStore, type TurnStore } from './turn-store.js';

import type { DriverMap } from '@agenetes/runtime';

/** Static composition-root options for one mounted Agenetes instance. */
export interface MountAgenetesOptions {
  readonly drivers: DriverMap;
  readonly autoRecoverPolicy?: AutoRecoverPolicy;
  readonly threadStore?: ThreadStore;
  readonly eventLogStore?: EventLogStore;
  readonly turnStore?: TurnStore;
}

/** Mount Agenetes over a complete immutable host-constructed DriverMap. */
export function mountAgenetes(options: MountAgenetesOptions): Agenetes {
  return createAgenetesInstance(
    createAgentRuntime(options.drivers),
    options.threadStore ?? new InMemoryThreadStore(),
    new EventLog(options.eventLogStore ?? new InMemoryEventLogStore()),
    options.turnStore ?? new InMemoryTurnStore(),
    options.autoRecoverPolicy ?? DEFAULT_AUTO_RECOVER_POLICY,
  );
}
