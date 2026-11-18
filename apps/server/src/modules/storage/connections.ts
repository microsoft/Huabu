// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The process's one connection to each SQL backend.
 *
 * Server records and the rest of storage borrow the same connection, and
 * that is load-bearing rather than tidy: a context is also the scope that
 * fences Space deletion against in-flight writes, and a second SQLite
 * connection would be a second writer to one file.
 *
 * A connection opens from the environment it is asked for, because records
 * open before the rest of storage from whatever environment startup was
 * handed (`setup` and the Vite dev server pass their own). Once open, a
 * request naming another database is refused rather than answered from the
 * open one, which would read or import one instance's records into another's.
 */

import path from 'node:path';

import { PostgresStoreContext } from './backends/postgres/database.js';
import {
  SqliteStoreContext,
  sqliteDatabasePath,
} from './backends/sqlite/database.js';
import { StorageProfileError } from './profile.js';

let sqlite: SqliteStoreContext | null = null;
/** The open pool and the URL it was opened for, compared but never printed. */
let postgres: { context: PostgresStoreContext; url: string } | null = null;

/** The SQLite database `env` selects, opened once for the process. */
export function sqliteConnection(
  env: NodeJS.ProcessEnv = process.env,
): SqliteStoreContext {
  const filename = path.resolve(sqliteDatabasePath(env));
  if (sqlite) {
    if (sqlite.filename !== filename)
      throw new StorageProfileError(
        `SQLite is already open at ${sqlite.filename} in this process; ` +
          `it cannot also open ${filename}`,
      );
    return sqlite;
  }
  const context = new SqliteStoreContext(filename);
  context.init();
  sqlite = context;
  return context;
}

/** The PostgreSQL database `env` names, connected once for the process. */
export function postgresConnection(
  env: NodeJS.ProcessEnv = process.env,
): PostgresStoreContext {
  const url = env['HUABU_POSTGRES_URL'];
  if (!url)
    throw new StorageProfileError('Postgres requires HUABU_POSTGRES_URL');
  if (postgres) {
    if (postgres.url !== url)
      throw new StorageProfileError(
        'PostgreSQL is already connected to another database in this process',
      );
    return postgres.context;
  }
  const context = new PostgresStoreContext({ connectionString: url });
  postgres = { context, url };
  return context;
}

/** Every open connection, for scoping them all to one Workspace. */
export function openConnections(): Array<
  SqliteStoreContext | PostgresStoreContext
> {
  const open: Array<SqliteStoreContext | PostgresStoreContext> = [];
  if (sqlite) open.push(sqlite);
  if (postgres) open.push(postgres.context);
  return open;
}

/**
 * Forget the open connections, so nothing borrows them from now on, and
 * return the function that closes them once their users have finished.
 */
export function releaseConnections(): () => Promise<void> {
  const released = { sqlite, postgres: postgres?.context ?? null };
  sqlite = null;
  postgres = null;
  return async () => {
    try {
      released.sqlite?.close();
    } finally {
      await released.postgres?.close();
    }
  };
}
