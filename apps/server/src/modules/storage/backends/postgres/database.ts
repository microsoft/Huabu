// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pool, type PoolClient, type PoolConfig } from 'pg';

import { POSTGRES_MIGRATIONS } from './schema.js';
import { createKeyedMutex } from '../../../../utils/keyed-mutex.js';
import {
  assertSpaceMutationAllowed,
  beginSpaceDeleteAdmission,
} from '../../space-lifecycle-admission.js';

import type { StorageHealth } from '../../ports/common.js';

export const SQL_WORLD_COLLISION_KEY = '.world';
// One transactional write order across this database. This conservative first
// adapter prioritizes the existing CAS/name-allocation contract over throughput.
const WRITE_LOCK = 184202606;
const serializeTransactions = createKeyedMutex<string>();

/** Adapter-internal statements. Parameters are always bound, never interpolated. */
export class PgExecutor {
  constructor(private readonly client: Pool | PoolClient) {}
  async all(
    sql: string,
    ...parameters: unknown[]
  ): Promise<Record<string, unknown>[]> {
    let index = 0;
    // These are static adapter SQL statements; '?' never occurs in a literal.
    return (
      await this.client.query(
        sql.replace(/\?/g, () => `$${++index}`),
        parameters,
      )
    ).rows as Record<string, unknown>[];
  }
  async get(
    sql: string,
    ...parameters: unknown[]
  ): Promise<Record<string, unknown> | undefined> {
    return (await this.all(sql, ...parameters))[0];
  }
  async run(
    sql: string,
    ...parameters: unknown[]
  ): Promise<{ changes: number }> {
    let index = 0;
    const result = await this.client.query(
      sql.replace(/\?/g, () => `$${++index}`),
      parameters,
    );
    return { changes: result.rowCount ?? 0 };
  }
}

export class PostgresStoreContext {
  readonly now: () => number;
  readonly #pool: Pool;
  #admissionScope = 'postgres:uninitialized';
  #state: 'new' | 'open' | 'closed' = 'new';
  #workspaceId: string | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(config: PoolConfig, now: () => number = Date.now) {
    this.now = now;
    this.#pool = new Pool({
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      ...config,
    });
    // Pool idle-client errors are reported by health/operations; never let an
    // unhandled EventEmitter error terminate the server.
    this.#pool.on('error', () => {});
  }

  async init(): Promise<void> {
    if (this.#state === 'open') return;
    if (this.#state === 'closed') throw new Error('Postgres store is closed');
    const client = await this.#pool.connect();
    // pg-pool drops its own idle listener while a client is checked out and
    // `pg` emits `error` on an unexpected disconnection, so a backend that
    // goes away mid-transaction would raise an unhandled 'error' event and
    // take the process down. The statement's own rejection below is the
    // signal this code acts on; the event only needs an ear.
    const ignoreDisconnect = () => {};
    client.on('error', ignoreDisconnect);
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS huabu_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
      );
      await client.query(
        'INSERT INTO huabu_schema_version (id, version) VALUES (1, 0) ON CONFLICT DO NOTHING',
      );
      let version = Number(
        (
          await client.query(
            'SELECT version FROM huabu_schema_version WHERE id = 1',
          )
        ).rows[0].version,
      );
      if (version > POSTGRES_MIGRATIONS.length)
        throw new Error(
          `Postgres schema version ${version} is newer than supported version ${POSTGRES_MIGRATIONS.length}`,
        );
      for (const migration of POSTGRES_MIGRATIONS) {
        if (migration.version <= version) continue;
        if (migration.version !== version + 1)
          throw new Error('Postgres migrations must be contiguous');
        await client.query(migration.sql);
        await client.query(
          'UPDATE huabu_schema_version SET version = $1 WHERE id = 1',
          [migration.version],
        );
        version = migration.version;
      }
      // Resolve the actual table namespace, not the configured search_path or
      // connection URL: aliases, credentials, and pool options cannot split the
      // lifecycle gate. Matching database/schema names on different servers
      // conservatively share coordination too. No persistent identity is needed.
      const scope = (
        await client.query(`SELECT current_database() AS database,
          n.nspname AS schema FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = 'huabu_schema_version'::regclass`)
      ).rows[0];
      if (
        typeof scope?.database !== 'string' ||
        typeof scope?.schema !== 'string'
      )
        throw new Error('Could not resolve Postgres store namespace');
      await client.query('COMMIT');
      this.#admissionScope = `postgres:${JSON.stringify([scope.database, scope.schema])}`;
      this.#state = 'open';
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
      client.removeListener('error', ignoreDisconnect);
    }
  }

  connection(): Pool {
    this.assertOpen();
    return this.#pool;
  }
  database(): PgExecutor {
    this.assertOpen();
    return new PgExecutor(this.#pool);
  }
  assertOpen(): void {
    if (this.#state !== 'open')
      throw new Error(
        `Postgres store is ${this.#state === 'closed' ? 'closed' : 'not initialized'}`,
      );
  }
  async health(kind = 'postgres'): Promise<StorageHealth> {
    try {
      await this.database().get('SELECT 1');
      return { ok: true, kind };
    } catch {
      return { ok: false, kind, detail: 'Postgres liveness query failed' };
    }
  }
  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    await this.#tail.catch(() => {});
    this.#state = 'closed';
    await this.#pool.end();
  }
  useWorkspace(workspaceId: string | null): void {
    this.#workspaceId = workspaceId;
  }
  activeWorkspaceId(): string | null {
    return this.#workspaceId;
  }
  workspaceId(): string {
    this.assertOpen();
    if (!this.#workspaceId)
      throw new Error('No Workspace is active on the Postgres backend');
    return this.#workspaceId;
  }
  assertBoundWorkspace(bound: string, what: string): string {
    if (this.workspaceId() !== bound)
      throw new Error(
        `${what} belongs to an inactive Workspace. Resolve a fresh handle after Workspace activation.`,
      );
    return bound;
  }
  assertMutationAllowed(canvasId: string): void {
    this.assertOpen();
    assertSpaceMutationAllowed(this.#admissionScope, canvasId);
  }
  async acquireDelete(canvasId: string): Promise<() => void> {
    this.assertOpen();
    const release = await beginSpaceDeleteAdmission(
      this.#admissionScope,
      canvasId,
    );
    try {
      // Admission is already closed. A barrier in the shared queue drains
      // writes admitted by every peer before composition starts blob cleanup.
      await serializeTransactions(this.#admissionScope, () => {});
      this.assertOpen();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Never hold a SQL transaction while composition performs blob I/O. */
  transaction<T>(operation: (database: PgExecutor) => Promise<T>): Promise<T> {
    this.assertOpen();
    const bound = this.#workspaceId;
    const result = serializeTransactions(this.#admissionScope, async () => {
      this.assertOpen();
      if (bound !== this.#workspaceId)
        throw new Error('Postgres operation belongs to an inactive Workspace');
      const client = await this.#pool.connect();
      // pg-pool drops its own idle listener while a client is checked out and
      // `pg` emits `error` on an unexpected disconnection, so a backend that
      // goes away mid-transaction would raise an unhandled 'error' event and
      // take the process down. The statement's own rejection below is the
      // signal this code acts on; the event only needs an ear.
      const ignoreDisconnect = () => {};
      client.on('error', ignoreDisconnect);
      let broken = false;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
        if (bound !== this.#workspaceId)
          throw new Error(
            'Postgres operation belongs to an inactive Workspace',
          );
        const value = await operation(new PgExecutor(client));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        client.release(broken);
        client.removeListener('error', ignoreDisconnect);
      }
    });
    this.#tail = result;
    return result;
  }
}
