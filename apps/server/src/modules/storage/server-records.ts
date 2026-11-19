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

import path from 'node:path';

import { getDataDir } from '../../data-dir.js';
import { createKeyedMutex } from '../../utils/keyed-mutex.js';
import { getLogger } from '../../utils/logger.js';
import { diskServerRecordPath } from './backends/disk/data-dir.js';
import { DiskServerRecordStore } from './backends/disk/server-records.js';
import {
  PostgresServerRecordStore,
  postgresDatabaseHoldsServerRecords,
  postgresServerRecordBeforeInit,
} from './backends/postgres/server-records.js';
import {
  SqliteServerRecordStore,
  sqliteDatabaseHoldsServerRecords,
  sqliteServerRecordWithoutOpening,
} from './backends/sqlite/server-records.js';
import {
  postgresConnection,
  releaseConnections,
  sqliteConnection,
  sqliteFilename,
} from './connections.js';
import {
  assertServerRecordKey,
  ServerRecordError,
  serverRecordId,
} from './ports/server-records.js';
import {
  parseStorageProfile,
  StorageProfileError,
  validateStorageProfile,
  type StorageProfile,
} from './profile.js';

import type {
  ServerRecordEntry,
  ServerRecordImportTarget,
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

/**
 * Which records an open answers for: the backend and the database or data
 * directory it reads, as the process resolves them. Two opens of one target
 * share one {@link ServerRecords}, and with it the mutex that keeps their
 * read-modify-writes from losing one another. Compared, never printed: a
 * PostgreSQL target holds the connection URL.
 */
function recordTarget(
  kind: StructuredBackendKind,
  env: NodeJS.ProcessEnv,
): string {
  switch (kind) {
    case 'disk':
      return `disk:${path.resolve(getDataDir(env))}`;
    case 'sqlite':
      return `sqlite:${sqliteFilename(env)}`;
    case 'postgres':
      return `postgres:${env['HUABU_POSTGRES_URL'] ?? ''}`;
    default:
      throw new Error(`Unsupported structured backend: ${String(kind)}`);
  }
}

/** The open records and the target they answer for. */
let open: { target: string; records: ServerRecords } | null = null;
/** An open in flight, shared by every caller asking for the same target. */
let opening: { target: string; records: Promise<ServerRecords> } | null = null;

function buildDatabaseStore(
  kind: ServerRecordImportTarget['kind'],
  env: NodeJS.ProcessEnv,
): ServerRecordImportTarget {
  return kind === 'sqlite'
    ? new SqliteServerRecordStore(sqliteConnection(env))
    : new PostgresServerRecordStore(postgresConnection(env));
}

/** The database kinds, which keep records as rows and import legacy files. */
function isDatabaseKind(
  kind: StructuredBackendKind,
): kind is ServerRecordImportTarget['kind'] {
  return kind === 'sqlite' || kind === 'postgres';
}

/** Whether `kind`'s database, as `env` names it, holds any record, asked without opening it. */
async function databaseHoldsServerRecords(
  kind: ServerRecordImportTarget['kind'],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return kind === 'sqlite'
    ? sqliteDatabaseHoldsServerRecords(sqliteFilename(env))
    : postgresDatabaseHoldsServerRecords(postgresConnection(env));
}

/**
 * The records opening `kind`'s database would import from the files an
 * earlier version kept in `env`'s data directory, read without changing
 * anything.
 *
 * Opening a database upgrades its schema, and the earlier version cannot open
 * the upgraded database, so everything the import needs is read first: a
 * file that is not valid JSON fails here with the database as it was, rather
 * than leaving the only copy of a record where repairing the file no longer
 * reaches it. Whether each owner can read its value is checked above
 * storage, before startup opens anything (`modules/server-record-shapes.ts`),
 * since storage knows no owner's schema.
 *
 * Empty for Disk, where the files are the records, and for a database that
 * already holds server records. The import commits all of its records in one
 * transaction, so a database holding any record has had its import, and the
 * files it was taken from are never read or checked again.
 *
 * @param kind The structured backend being opened; defaults to the one `env`
 *   selects. A caller with an explicit storage profile passes its kind, so
 *   the import is read for the backend that is actually opened.
 * @throws ServerRecordError naming the file, when one cannot be read.
 */
export async function readPendingImport(
  env: NodeJS.ProcessEnv = process.env,
  kind: StructuredBackendKind = parseStorageProfile(env).structured.kind,
): Promise<readonly PendingImportEntry[]> {
  if (!isDatabaseKind(kind)) return [];
  if (await databaseHoldsServerRecords(kind, env)) return [];
  const dataDir = getDataDir(env);
  const files = new DiskServerRecordStore(() => dataDir);
  const records: PendingImportEntry[] = [];
  for (const key of await files.keys()) {
    const file = diskServerRecordPath(key, dataDir);
    let value: unknown;
    try {
      value = await files.get(key);
    } catch (error) {
      throw unimportableRecord(file, (error as Error).message, error);
    }
    records.push({ key, value, file });
  }
  return records;
}

/** One record {@link readPendingImport} found, and the file it was read from. */
export interface PendingImportEntry extends ServerRecordEntry {
  /** The file's absolute path, for an operator to repair. */
  readonly file: string;
}

/**
 * The startup error for a file an import cannot take, raised before the
 * database is opened.
 */
export function unimportableRecord(
  file: string,
  reason: string,
  cause?: unknown,
): ServerRecordError {
  return new ServerRecordError(
    `Cannot import ${file} into the database: ${reason}. The database was ` +
      `not changed. Repair or remove the file, then start again.`,
    { cause },
  );
}

/**
 * One record as the next open of `env`'s backend would serve it, read
 * without opening, creating, or upgrading anything: the database's row once
 * it holds records, else the file an import would take it from. For a
 * lookup that must leave storage exactly as it found it, such as `setup`
 * asking whether a password is saved before the operator confirms anything.
 */
export async function peekServerRecord(
  key: ServerRecordKey,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  assertServerRecordKey(key);
  const { kind } = parseStorageProfile(env).structured;
  const dataDir = getDataDir(env);
  if (isDatabaseKind(kind) && (await databaseHoldsServerRecords(kind, env)))
    return kind === 'sqlite'
      ? sqliteServerRecordWithoutOpening(sqliteFilename(env), key)
      : postgresServerRecordBeforeInit(postgresConnection(env), key);
  return new DiskServerRecordStore(() => dataDir).get(key);
}

/**
 * Open server records for `kind`, the database or data directory taken from
 * `env`. Every caller asking for one target, at once or later, gets the same
 * {@link ServerRecords}. On a database this also imports
 * {@link readPendingImport}'s records.
 */
function openRecords(
  kind: StructuredBackendKind,
  env: NodeJS.ProcessEnv,
): Promise<ServerRecords> {
  const target = recordTarget(kind, env);
  if (open?.target === target) return Promise.resolve(open.records);
  if (opening?.target === target) return opening.records;
  const records = openServerRecords(kind, env).then(
    (opened) => {
      if (opening?.records === records) {
        open = { target, records: opened };
        opening = null;
      }
      return opened;
    },
    (error: unknown) => {
      if (opening?.records === records) opening = null;
      throw error;
    },
  );
  opening = { target, records };
  return records;
}

/**
 * Open server records for the structured backend `env` selects.
 *
 * `env` chooses the backend, its database, and the data directory; setup and
 * the Vite dev server pass their own.
 */
export async function initServerRecords(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerRecords> {
  const profile = parseStorageProfile(env);
  validateStorageProfile(profile);
  return openRecords(profile.structured.kind, env);
}

/**
 * Records for `profile`, for storage opened with an explicit profile, on the
 * process environment's database. Keeps the records already open when they
 * answer for the same target.
 */
export async function ensureServerRecords(
  profile: StorageProfile,
): Promise<void> {
  await openRecords(profile.structured.kind, process.env);
}

async function openServerRecords(
  kind: StructuredBackendKind,
  env: NodeJS.ProcessEnv,
): Promise<ServerRecords> {
  if (!isDatabaseKind(kind)) {
    if (kind !== 'disk')
      throw new Error(`Unsupported structured backend: ${String(kind)}`);
    return new ServerRecords(new DiskServerRecordStore(() => getDataDir(env)));
  }
  // Read before the store opens: opening upgrades the database.
  const pending = await readPendingImport(env, kind);
  const store = buildDatabaseStore(kind, env);
  await store.init();
  if (pending.length > 0) {
    // Conditional, so a process that imported first keeps whatever has
    // been written since.
    const imported = await store.insertMissing(pending);
    log.info(
      { imported, backend: kind },
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
  if (open) return open.records;
  const profile = parseStorageProfile();
  if (profile.structured.kind !== 'disk')
    throw new StorageProfileError(
      `Server records were used before initServerRecords(). The ` +
        `"${profile.structured.kind}" structured backend has a connection to ` +
        `open. Call initServerRecords() during startup.`,
    );
  const records = new ServerRecords(new DiskServerRecordStore());
  open = { target: recordTarget('disk', process.env), records };
  return records;
}

/** Forget the open records, when storage closes its connections. */
export function forgetServerRecords(): void {
  open = null;
  opening = null;
}

/**
 * Forget the open records and close the connections they borrowed, for a
 * process that opened records without the rest of storage, such as `setup`,
 * which would otherwise stay alive on an idle PostgreSQL pool.
 */
export async function closeServerRecords(): Promise<void> {
  forgetServerRecords();
  await releaseConnections()();
}

/**
 * For tests that need specific records. Returns the restore function. The
 * records answer for no target, so the next open reopens.
 */
export function setServerRecordsForTesting(
  records: ServerRecords | null,
): () => void {
  const previous = { open, opening };
  open = records ? { target: 'testing', records } : null;
  opening = null;
  return () => {
    open = previous.open;
    opening = previous.opening;
  };
}
