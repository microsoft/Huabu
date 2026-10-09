// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Which Agenetes conversation stores this deployment runs on.
 *
 * Agenetes takes its three storage ports at mount, once, while the storage
 * profile is only known at runtime and the active Workspace can change under
 * a running process. So the mounted stores are dispatchers: each call picks
 * the implementation that suits the namespace it was handed.
 *
 * The choice is made per namespace rather than per process because that is
 * where the answer actually lives. A namespace carries a `storage.root` when
 * the Space it belongs to is a directory, and does not when it is rows — the
 * same fact the Space facade reports, arriving here through Agenetes's own
 * vocabulary.
 *
 * The in-memory fall-through is not a backend choice. It is what an *unnamed*
 * namespace has always got: a conversation with no Space to belong to, which
 * Agenetes explicitly treats as non-persistent.
 */

import {
  FileEventLogStore,
  FileThreadStore,
  FileTurnStore,
  InMemoryEventLogStore,
  InMemoryThreadStore,
  InMemoryTurnStore,
} from '@agenetes/agenetes';

import {
  PostgresThreadStore,
  PostgresEventLogStore,
  PostgresTurnStore,
} from './postgres-stores.js';
import {
  SqliteEventLogStore,
  SqliteThreadStore,
  SqliteTurnStore,
} from './sqlite-stores.js';
import {
  getStructuredStore,
  registerSpaceDirHandleOwner,
} from '../../storage/index.js';
import { resolveCanvasAcpNamespace } from '../../workspace/paths.js';
import { acquireWorkspaceOperationLease } from '../../workspace.js';
import {
  appendRecentConversationTurn,
  preserveRecentConversationBeforeHistoryDelete,
} from '../recent-conversation.js';

import type {
  EventLogRecord,
  EventLogStore,
  PersistedTurn,
  ThreadRecord,
  ThreadStore,
  TurnStore,
  TurnStorePageOptions,
} from '@agenetes/agenetes';
import type { AgentSubmission, Namespace } from '@agenetes/protocol';

interface Backing {
  readonly threads: ThreadStore;
  readonly events: EventLogStore;
  readonly turns: TurnStore;
}

const fileTurns = new FileTurnStore();
const file: Backing = {
  threads: new FileThreadStore(),
  events: new FileEventLogStore(),
  turns: fileTurns,
};
const fileTurnOwners = new Map<string, { namespace: Namespace }>();

function registerFileTurnOwner(namespace: Namespace): void {
  const existing = fileTurnOwners.get(namespace.name);
  if (existing) {
    existing.namespace = namespace;
    return;
  }
  const owner = { namespace };
  fileTurnOwners.set(namespace.name, owner);
  registerSpaceDirHandleOwner(namespace.name, {
    release: () => fileTurns.close(owner.namespace),
    reacquire: () => undefined,
  });
}

const postgres: Backing = {
  threads: new PostgresThreadStore(),
  events: new PostgresEventLogStore(),
  turns: new PostgresTurnStore(),
};

const sqlite: Backing = {
  threads: new SqliteThreadStore(),
  events: new SqliteEventLogStore(),
  turns: new SqliteTurnStore(),
};

/**
 * Shared, so an unnamed namespace keeps one conversation for the life of the
 * process instead of a fresh empty one per port.
 */
const memory: Backing = {
  threads: new InMemoryThreadStore(),
  events: new InMemoryEventLogStore(),
  turns: new InMemoryTurnStore(),
};

/** The stores that own this namespace's durable conversation state. */
function backingFor(namespace: Namespace): Backing {
  // A directory to write into settles it: that is the Disk profile. Tier 1
  // and thread metadata remain files; Tier 2 is the Space-owned SQLite store.
  if (namespace.storage?.root) {
    registerFileTurnOwner(namespace);
    return file;
  }
  if (!namespace.name) return memory;
  // Every other profile answers from the structured store it was selected
  // with; a missing Space is each adapter's own case, not a fall-through.
  const kind = getStructuredStore().kind;
  if (kind === 'postgres') return postgres;
  if (kind === 'sqlite') return sqlite;
  throw new Error('A named Disk conversation requires a storage root');
}

async function inNamespace<T>(
  namespace: Namespace,
  action: (current: Namespace, backing: Backing) => T | Promise<T>,
): Promise<T> {
  if (!namespace.name) return action(namespace, memory);
  const lease = acquireWorkspaceOperationLease();
  try {
    const current = resolveCanvasAcpNamespace(namespace);
    return await action(current, backingFor(current));
  } finally {
    lease.release();
  }
}

export const conversationThreadStore: ThreadStore = {
  upsert: (namespace, threadId, record: ThreadRecord) =>
    inNamespace(namespace, (current, backing) =>
      backing.threads.upsert(
        current,
        threadId,
        current.name
          ? { ...record, spec: { ...record.spec, namespace: current } }
          : record,
      ),
    ),
  get: (namespace, threadId) =>
    inNamespace(namespace, (current, backing) =>
      backing.threads.get(current, threadId),
    ),
  list: (namespace) =>
    inNamespace(namespace, (current, backing) => backing.threads.list(current)),
  delete: (namespace, threadId) =>
    inNamespace(namespace, (current, backing) =>
      backing.threads.delete(current, threadId),
    ),
};

export const conversationEventLogStore: EventLogStore = {
  appendTurnStart: (namespace, threadId, request: AgentSubmission | null) =>
    inNamespace(namespace, (current, backing) =>
      appendRecentConversationTurn(current, threadId, request, backing.events),
    ),
  append: (namespace, threadId, event) =>
    inNamespace(namespace, (current, backing) =>
      backing.events.append(current, threadId, event),
    ),
  read: (namespace, threadId, sinceSeq) =>
    inNamespace(namespace, (current, backing) =>
      backing.events.read(current, threadId, sinceSeq),
    ),
  readRecords: (namespace, threadId, sinceSeq) =>
    inNamespace(namespace, (current, backing) =>
      backing.events.readRecords(current, threadId, sinceSeq),
    ),
  maxSeq: (namespace, threadId) =>
    inNamespace(namespace, (current, backing) =>
      backing.events.maxSeq(current, threadId),
    ),
  replace: (namespace, threadId, records: readonly EventLogRecord[]) =>
    inNamespace(namespace, (current, backing) =>
      backing.events.replace(current, threadId, records),
    ),
  delete: (namespace, threadId) =>
    inNamespace(namespace, async (current, backing) => {
      const events = backing.events;
      await preserveRecentConversationBeforeHistoryDelete(
        current,
        threadId,
        events,
      );
      await events.delete(current, threadId);
    }),
};

export const conversationTurnStore: TurnStore = {
  append: (namespace, threadId, persisted: PersistedTurn) =>
    inNamespace(namespace, (current, backing) =>
      backing.turns.append(current, threadId, persisted),
    ),
  list: (namespace, threadId) =>
    inNamespace(namespace, (current, backing) =>
      backing.turns.list(current, threadId),
    ),
  page: (namespace, threadId, options: TurnStorePageOptions) =>
    inNamespace(namespace, (current, backing) =>
      backing.turns.page(current, threadId, options),
    ),
  count: (namespace, threadId) =>
    inNamespace(namespace, (current, backing) =>
      backing.turns.count(current, threadId),
    ),
  fence: (namespace, threadId) =>
    inNamespace(namespace, (current, backing) =>
      backing.turns.fence(current, threadId),
    ),
  replace: (namespace, threadId, persisted: readonly PersistedTurn[]) =>
    inNamespace(namespace, (current, backing) =>
      backing.turns.replace(current, threadId, persisted),
    ),
  delete: (namespace, threadId) =>
    inNamespace(namespace, (current, backing) =>
      backing.turns.delete(current, threadId),
    ),
};
