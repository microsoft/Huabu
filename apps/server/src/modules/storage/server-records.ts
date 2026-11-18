// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Server records composition root.
 *
 * The Server's own state, owned by no Workspace (ports/server-records.ts,
 * docs/proposals/server-records.md). Records follow the structured backend
 * and borrow its connection (`connections.ts`), so a database profile keeps
 * them as rows beside the Workspaces. Credentials are records and are read
 * before the Server binds, so records open before the rest of storage: they
 * need only the profile, which comes from the environment alone.
 *
 * This is the only place that maps a backend kind to a record adapter, kept
 * apart from `storage.ts` so that opening records loads the record adapters
 * and nothing else of the storage graph: the Vite dev server opens them while
 * loading its configuration to read a saved password, where the rest of that
 * graph does not load.
 */

import { getDataDir } from '../../data-dir.js';
import { createKeyedMutex } from '../../utils/keyed-mutex.js';
import { getLogger } from '../../utils/logger.js';
import { DiskServerRecordStore } from './backends/disk/server-records.js';
import { PostgresServerRecordStore } from './backends/postgres/server-records.js';
import { SqliteServerRecordStore } from './backends/sqlite/server-records.js';
import { postgresConnection, sqliteConnection } from './connections.js';
import {
  assertServerRecordKey,
  serverRecordId,
} from './ports/server-records.js';
import {
  parseStorageProfile,
  StorageProfileError,
  validateStorageProfile,
  type StorageProfile,
} from './profile.js';

import type {
  ServerRecordKey,
  ServerRecordStore,
} from './ports/server-records.js';
import type { StructuredBackendKind } from './ports/structured.js';

const log = getLogger('storage');

/**
 * The application's view of server records: the adapter's reads, which always
 * go to storage, plus writes this process never loses to one another.
 */
export class ServerRecords {
  readonly #serialize = createKeyedMutex<string>();

  constructor(readonly store: ServerRecordStore) {}

  get kind(): StructuredBackendKind {
    return this.store.kind;
  }

  /** The latest acknowledged value, or `null` when never written. */
  get(key: ServerRecordKey): Promise<unknown> {
    return this.store.get(assertServerRecordKey(key));
  }

  /**
   * Replace a record, after every earlier write to it has settled. The old
   * value is never read, so a replacement also repairs a damaged record.
   */
  put(key: ServerRecordKey, value: unknown): Promise<void> {
    assertServerRecordKey(key);
    return this.#serialize(serverRecordId(key), () =>
      this.store.put(key, value),
    );
  }

  /**
   * Read-modify-write one record. `change` receives the latest acknowledged
   * value (`null` when never written) and returns the replacement; it runs
   * only after every earlier write to this record has settled, so two
   * concurrent changes both apply. A throwing `change` writes nothing.
   *
   * @returns the value written.
   */
  update<T>(key: ServerRecordKey, change: (current: unknown) => T): Promise<T> {
    assertServerRecordKey(key);
    return this.#serialize(serverRecordId(key), async () => {
      const next = change(await this.store.get(key));
      await this.store.put(key, next);
      return next;
    });
  }
}

let serverRecords: ServerRecords | null = null;
/** The environment {@link serverRecords} was opened from, when opened explicitly. */
let serverRecordsEnvironment: NodeJS.ProcessEnv | null = null;

function buildServerRecordStore(
  profile: StorageProfile,
  env: NodeJS.ProcessEnv,
): ServerRecordStore {
  switch (profile.structured.kind) {
    case 'disk':
      return new DiskServerRecordStore(() => getDataDir(env));
    case 'sqlite':
      return new SqliteServerRecordStore(sqliteConnection(env));
    case 'postgres':
      return new PostgresServerRecordStore(postgresConnection(env));
    default:
      throw new Error(
        `Unsupported structured backend: ${profile.structured.kind}`,
      );
  }
}

/**
 * Copy every record that exists in `source` and not yet in `target`.
 *
 * Records are never deleted, so a record present in `target` is newer than
 * any file an earlier version wrote, and once every file has been copied this
 * does nothing: running it on each start is the same as running it once. A
 * damaged file fails startup rather than being dropped, because it may be the
 * only copy of a credential.
 *
 * @returns how many records were copied.
 */
export async function importServerRecords(
  target: ServerRecordStore,
  source: ServerRecordStore,
): Promise<number> {
  let imported = 0;
  for (const key of await source.keys()) {
    if ((await target.get(key)) !== null) continue;
    await target.put(key, await source.get(key));
    imported += 1;
  }
  return imported;
}

/**
 * A record an earlier version kept as a file in `env`'s data directory, or
 * `null`. Read without opening any backend, so a caller can check what a
 * database backend is about to import before anything is changed.
 */
export function readDataDirectoryRecord(
  key: ServerRecordKey,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  return new DiskServerRecordStore(() => getDataDir(env)).get(key);
}

/**
 * Open server records for the structured backend `env` selects. Idempotent
 * for the same environment.
 *
 * `env` chooses the backend, its database, and the data directory; setup and
 * the Vite dev server pass their own. On a database backend this also imports
 * the records an earlier version kept as files in the data directory.
 */
export async function initServerRecords(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerRecords> {
  if (serverRecords && serverRecordsEnvironment === env) return serverRecords;
  const profile = parseStorageProfile(env);
  validateStorageProfile(profile);
  serverRecords = await openServerRecords(profile, env);
  serverRecordsEnvironment = env;
  return serverRecords;
}

/**
 * Records for `profile`, for storage opened with an explicit profile. Keeps
 * the records already open when they are for the same backend.
 */
export async function ensureServerRecords(
  profile: StorageProfile,
): Promise<void> {
  if (serverRecords?.kind === profile.structured.kind) return;
  serverRecords = await openServerRecords(profile, process.env);
  serverRecordsEnvironment = null;
}

async function openServerRecords(
  profile: StorageProfile,
  env: NodeJS.ProcessEnv,
): Promise<ServerRecords> {
  const store = buildServerRecordStore(profile, env);
  await store.init();
  if (store.kind !== 'disk') {
    const imported = await importServerRecords(
      store,
      new DiskServerRecordStore(() => getDataDir(env)),
    );
    if (imported > 0)
      log.info(
        { imported, backend: store.kind },
        'Imported server records from the data directory',
      );
  }
  return new ServerRecords(store);
}

/**
 * The process's server records.
 *
 * Disk needs no connection, so it opens on first use, exactly as the Disk
 * profile does on the on-demand path. A database backend must have been
 * opened by an awaited {@link initServerRecords} during startup.
 */
export function getServerRecords(): ServerRecords {
  if (serverRecords) return serverRecords;
  const profile = parseStorageProfile();
  if (profile.structured.kind !== 'disk')
    throw new StorageProfileError(
      `Server records were used before initServerRecords(). The ` +
        `"${profile.structured.kind}" structured backend has a connection to ` +
        `open. Call initServerRecords() during startup.`,
    );
  serverRecords = new ServerRecords(new DiskServerRecordStore());
  return serverRecords;
}

/** Forget the open records, when storage closes its connections. */
export function forgetServerRecords(): void {
  serverRecords = null;
  serverRecordsEnvironment = null;
}

/** For tests that need specific records. Returns the restore function. */
export function setServerRecordsForTesting(
  records: ServerRecords | null,
): () => void {
  const previous = {
    records: serverRecords,
    environment: serverRecordsEnvironment,
  };
  serverRecords = records;
  serverRecordsEnvironment = null;
  return () => {
    serverRecords = previous.records;
    serverRecordsEnvironment = previous.environment;
  };
}
