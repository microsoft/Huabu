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
  conversationTables,
  SqliteEventLogStore,
  SqliteThreadStore,
  SqliteTurnStore,
} from './sqlite-stores.js';

import type {
  EventLogEntry,
  EventLogRecord,
  EventLogStore,
  PersistedTurn,
  ThreadRecord,
  ThreadStore,
  TurnStartLogEntry,
  TurnStore,
} from '@agenetes/agenetes';
import type { AgentSubmission, Namespace } from '@agenetes/protocol';

interface Backing {
  readonly threads: ThreadStore;
  readonly events: EventLogStore;
  readonly turns: TurnStore;
}

const file: Backing = {
  threads: new FileThreadStore(),
  events: new FileEventLogStore(),
  turns: new FileTurnStore(),
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
  // A directory to write into settles it: that is the Disk profile, and the
  // file stores are what wrote whatever is already there.
  if (namespace.storage?.root) return file;
  if (namespace.name && conversationTables(namespace) !== null) return sqlite;
  return memory;
}

export const conversationThreadStore: ThreadStore = {
  upsert: (namespace, threadId, record: ThreadRecord) =>
    backingFor(namespace).threads.upsert(namespace, threadId, record),
  get: (namespace, threadId) =>
    backingFor(namespace).threads.get(namespace, threadId),
  list: (namespace) => backingFor(namespace).threads.list(namespace),
  delete: (namespace, threadId) =>
    backingFor(namespace).threads.delete(namespace, threadId),
};

export const conversationEventLogStore: EventLogStore = {
  appendTurnStart: (
    namespace,
    threadId,
    request: AgentSubmission | null,
  ): TurnStartLogEntry =>
    backingFor(namespace).events.appendTurnStart(namespace, threadId, request),
  append: (namespace, threadId, event): EventLogEntry =>
    backingFor(namespace).events.append(namespace, threadId, event),
  read: (namespace, threadId, sinceSeq) =>
    backingFor(namespace).events.read(namespace, threadId, sinceSeq),
  readRecords: (namespace, threadId, sinceSeq) =>
    backingFor(namespace).events.readRecords(namespace, threadId, sinceSeq),
  maxSeq: (namespace, threadId) =>
    backingFor(namespace).events.maxSeq(namespace, threadId),
  replace: (namespace, threadId, records: readonly EventLogRecord[]) =>
    backingFor(namespace).events.replace(namespace, threadId, records),
  delete: (namespace, threadId) =>
    backingFor(namespace).events.delete(namespace, threadId),
};

export const conversationTurnStore: TurnStore = {
  append: (namespace, threadId, persisted: PersistedTurn) =>
    backingFor(namespace).turns.append(namespace, threadId, persisted),
  list: (namespace, threadId) =>
    backingFor(namespace).turns.list(namespace, threadId),
  count: (namespace, threadId) =>
    backingFor(namespace).turns.count(namespace, threadId),
  fence: (namespace, threadId) =>
    backingFor(namespace).turns.fence(namespace, threadId),
  replace: (namespace, threadId, persisted: readonly PersistedTurn[]) =>
    backingFor(namespace).turns.replace(namespace, threadId, persisted),
  delete: (namespace, threadId) =>
    backingFor(namespace).turns.delete(namespace, threadId),
};
