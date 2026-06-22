import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import initSqlJs, { type Database } from 'sql.js'

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Compute a non-reversible token signature for use as owner ID */
export function tokenSignature(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionStatus = 'starting' | 'active' | 'suspending' | 'suspended' | 'resuming' | 'closed' | 'failed'

export interface SessionRecord {
  sessionId: string
  displayName: string
  agentletId?: string
  owner: string
  command: string
  cwd: string
  env?: Record<string, string>
  status: SessionStatus
  supportsLoad: boolean
  supportsResume: boolean
  initializeResult?: unknown
  /**
   * The full ACP `session/new` response for freshly-created sessions
   * (absent on resume/load). Stored opaquely — may carry inline
   * `models` / `modes` / `configOptions` the host reads to seed its UI.
   */
  newSessionResult?: unknown
  profile?: string
  idleTimeoutSecs: number
  autoRestart: boolean
  createdAt: string
  suspendedAt?: string
  updatedAt: string
}

export interface AgentletRecord {
  agentletId: string
  owner: string
  machine?: { hostname: string; platform: string }
  bridge: { name: string; version: string }
  capabilities: { autoRestart: boolean; bufferLimit: number; maxAgents?: number }
  registeredAt: string
  updatedAt: string
}

export interface DataStoreOptions {
  /** Path to SQLite file. If omitted, uses in-memory only. */
  filePath?: string
  /** Debounce interval (ms) for flushing to disk. Default: 1000 */
  flushDebounceMs?: number
}

/** @deprecated Use DataStoreOptions */
export type SessionStoreOptions = DataStoreOptions

// ─── Data Store ───────────────────────────────────────────────────────────────

export class DataStore {
  private db: Database | null = null
  private readonly filePath?: string
  private readonly flushDebounceMs: number
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private initialized = false

  constructor(options: DataStoreOptions = {}) {
    this.filePath = options.filePath
    this.flushDebounceMs = options.flushDebounceMs ?? 1000
  }

  /** Initialize the store. Must be called before any operations. */
  async init(): Promise<void> {
    if (this.initialized) return

    const SQL = await initSqlJs()

    if (this.filePath && existsSync(this.filePath)) {
      const buffer = readFileSync(this.filePath)
      this.db = new SQL.Database(buffer)
    } else {
      this.db = new SQL.Database()
    }

    this.createSchema()
    this.migrateSchema()
    this.initialized = true
  }

  // ─── Session Methods ────────────────────────────────────────────────────

  /** Get a session by ID */
  getSession(sessionId: string): SessionRecord | undefined {
    const stmt = this.db!.prepare('SELECT * FROM sessions WHERE session_id = ?')
    stmt.bind([sessionId])
    if (stmt.step()) {
      const row = stmt.getAsObject()
      stmt.free()
      return this.rowToSessionRecord(row)
    }
    stmt.free()
    return undefined
  }

  /** @deprecated Use getSession() */
  get(sessionId: string): SessionRecord | undefined {
    return this.getSession(sessionId)
  }

  /** Find sessions by owner (token signature), optionally filtered by status */
  findSessionsByOwner(owner: string, status?: SessionStatus): SessionRecord[] {
    let query = 'SELECT * FROM sessions WHERE owner = ?'
    const params: (string | number)[] = [owner]
    if (status) {
      query += ' AND status = ?'
      params.push(status)
    }
    query += ' ORDER BY updated_at DESC'

    const stmt = this.db!.prepare(query)
    stmt.bind(params)
    const results: SessionRecord[] = []
    while (stmt.step()) {
      results.push(this.rowToSessionRecord(stmt.getAsObject()))
    }
    stmt.free()
    return results
  }

  /** @deprecated Use findSessionsByOwner() */
  findByToken(token: string, status?: SessionStatus): SessionRecord[] {
    return this.findSessionsByOwner(tokenSignature(token), status)
  }

  /** Find sessions by parent agentlet ID */
  findSessionsByAgentlet(agentletId: string): SessionRecord[] {
    const stmt = this.db!.prepare('SELECT * FROM sessions WHERE agentlet_id = ? ORDER BY updated_at DESC')
    stmt.bind([agentletId])
    const results: SessionRecord[] = []
    while (stmt.step()) {
      results.push(this.rowToSessionRecord(stmt.getAsObject()))
    }
    stmt.free()
    return results
  }

  /** @deprecated Use findSessionsByAgentlet() */
  findByAgentlet(agentletId: string): SessionRecord[] {
    return this.findSessionsByAgentlet(agentletId)
  }

  /** Save a session record (insert or replace) */
  saveSession(record: SessionRecord): void {
    this.db!.run(`
      INSERT OR REPLACE INTO sessions (
        session_id, display_name, agentlet_id, owner, command, cwd, env, status,
        supports_load, supports_resume, initialize_result, new_session_result, profile,
        idle_timeout_secs, auto_restart, created_at, suspended_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.sessionId,
      record.displayName,
      record.agentletId ?? null,
      record.owner,
      record.command,
      record.cwd,
      record.env ? JSON.stringify(record.env) : null,
      record.status,
      record.supportsLoad ? 1 : 0,
      record.supportsResume ? 1 : 0,
      record.initializeResult ? JSON.stringify(record.initializeResult) : null,
      record.newSessionResult ? JSON.stringify(record.newSessionResult) : null,
      record.profile ?? null,
      record.idleTimeoutSecs,
      record.autoRestart ? 1 : 0,
      record.createdAt,
      record.suspendedAt ?? null,
      record.updatedAt,
    ])
    this.scheduleCriticalFlush()
  }

  /** @deprecated Use saveSession() */
  save(record: SessionRecord): void {
    this.saveSession(record)
  }

  /** Update session status (with critical flush for lifecycle transitions) */
  updateSessionStatus(sessionId: string, status: SessionStatus, extra?: { suspendedAt?: string }): void {
    const now = new Date().toISOString()
    let query = 'UPDATE sessions SET status = ?, updated_at = ?'
    const params: (string | number | null)[] = [status, now]

    if (extra?.suspendedAt) {
      query += ', suspended_at = ?'
      params.push(extra.suspendedAt)
    }

    query += ' WHERE session_id = ?'
    params.push(sessionId)

    this.db!.run(query, params)
    this.scheduleCriticalFlush()
  }

  /** @deprecated Use updateSessionStatus() */
  updateStatus(sessionId: string, status: SessionStatus, extra?: { suspendedAt?: string }): void {
    this.updateSessionStatus(sessionId, status, extra)
  }

  /** Update the human-readable display name for a session */
  updateDisplayName(sessionId: string, displayName: string): void {
    const now = new Date().toISOString()
    this.db!.run(
      'UPDATE sessions SET display_name = ?, updated_at = ? WHERE session_id = ?',
      [displayName, now, sessionId]
    )
    this.scheduleFlush()
  }

  /** Update spawn params for a session (used on resume with different args) */
  updateSpawnParams(sessionId: string, params: { cwd?: string; env?: Record<string, string>; command?: string; idleTimeoutSecs?: number }): void {
    const now = new Date().toISOString()
    const updates: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [now]

    if (params.cwd !== undefined) {
      updates.push('cwd = ?')
      values.push(params.cwd)
    }
    if (params.env !== undefined) {
      updates.push('env = ?')
      values.push(JSON.stringify(params.env))
    }
    if (params.command !== undefined) {
      updates.push('command = ?')
      values.push(params.command)
    }
    if (params.idleTimeoutSecs !== undefined) {
      updates.push('idle_timeout_secs = ?')
      values.push(params.idleTimeoutSecs)
    }

    const query = `UPDATE sessions SET ${updates.join(', ')} WHERE session_id = ?`
    values.push(sessionId)
    this.db!.run(query, values)
    this.scheduleFlush()
  }

  /** Delete a session record */
  deleteSession(sessionId: string): void {
    this.db!.run('DELETE FROM sessions WHERE session_id = ?', [sessionId])
    this.scheduleFlush()
  }

  /** @deprecated Use deleteSession() */
  delete(sessionId: string): void {
    this.deleteSession(sessionId)
  }

  // ─── Agentlet Methods ──────────────────────────────────────────────────

  /** Get an agentlet by ID */
  getAgentlet(agentletId: string): AgentletRecord | undefined {
    const stmt = this.db!.prepare('SELECT * FROM agentlets WHERE agentlet_id = ?')
    stmt.bind([agentletId])
    if (stmt.step()) {
      const row = stmt.getAsObject()
      stmt.free()
      return this.rowToAgentletRecord(row)
    }
    stmt.free()
    return undefined
  }

  /** Get all agentlets, optionally filtered by owner */
  getAgentlets(owner?: string): AgentletRecord[] {
    const query = owner
      ? 'SELECT * FROM agentlets WHERE owner = ? ORDER BY updated_at DESC'
      : 'SELECT * FROM agentlets ORDER BY updated_at DESC'
    const stmt = this.db!.prepare(query)
    if (owner) stmt.bind([owner])
    const results: AgentletRecord[] = []
    while (stmt.step()) {
      results.push(this.rowToAgentletRecord(stmt.getAsObject()))
    }
    stmt.free()
    return results
  }

  /** Save an agentlet record (insert or update). Preserves registeredAt on update. */
  saveAgentlet(record: AgentletRecord): void {
    this.db!.run(`
      INSERT INTO agentlets (
        agentlet_id, owner, machine, bridge, capabilities,
        registered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agentlet_id) DO UPDATE SET
        owner = excluded.owner,
        machine = excluded.machine,
        bridge = excluded.bridge,
        capabilities = excluded.capabilities,
        updated_at = excluded.updated_at
    `, [
      record.agentletId,
      record.owner,
      record.machine ? JSON.stringify(record.machine) : null,
      JSON.stringify(record.bridge),
      JSON.stringify(record.capabilities),
      record.registeredAt,
      record.updatedAt,
    ])
    this.scheduleCriticalFlush()
  }

  /** Delete an agentlet record */
  deleteAgentlet(agentletId: string): void {
    this.db!.run('DELETE FROM agentlets WHERE agentlet_id = ?', [agentletId])
    this.scheduleFlush()
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Flush database to disk immediately (for critical transitions) */
  flush(): void {
    if (!this.filePath || !this.db) return
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const data = this.db.export()
    writeFileSync(this.filePath, Buffer.from(data))
  }

  /** Close the store and flush any pending writes */
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
    this.db?.close()
    this.db = null
    this.initialized = false
  }

  // ─── Private: Schema ─────────────────────────────────────────────────────

  private createSchema(): void {
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        agentlet_id TEXT,
        owner TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        env TEXT,
        status TEXT NOT NULL DEFAULT 'starting',
        supports_load INTEGER NOT NULL DEFAULT 0,
        supports_resume INTEGER NOT NULL DEFAULT 0,
        initialize_result TEXT,
        new_session_result TEXT,
        profile TEXT,
        idle_timeout_secs INTEGER NOT NULL DEFAULT 0,
        auto_restart INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        suspended_at TEXT,
        updated_at TEXT NOT NULL
      )
    `)
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS agentlets (
        agentlet_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        machine TEXT,
        bridge TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db!.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_agentlet_id
      ON sessions(agentlet_id, updated_at DESC)
    `)
    this.db!.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_owner
      ON sessions(owner, updated_at DESC)
    `)
  }

  /**
   * Apply additive schema migrations for databases created by an older
   * version. `CREATE TABLE IF NOT EXISTS` does not add columns to an
   * existing table, so new columns must be backfilled via ALTER TABLE.
   * Each ALTER is guarded against the "duplicate column" error so the
   * migration is idempotent across restarts.
   */
  private migrateSchema(): void {
    const existing = new Set<string>()
    const stmt = this.db!.prepare(`PRAGMA table_info(sessions)`)
    while (stmt.step()) {
      const col = stmt.getAsObject()
      if (typeof col['name'] === 'string') existing.add(col['name'])
    }
    stmt.free()

    if (!existing.has('new_session_result')) {
      this.db!.run(`ALTER TABLE sessions ADD COLUMN new_session_result TEXT`)
    }
  }

  // ─── Private: Flush ─────────────────────────────────────────────────────

  /** Flush synchronously for critical lifecycle transitions */
  private scheduleCriticalFlush(): void {
    this.flush()
  }

  /** Debounced flush for non-critical updates */
  private scheduleFlush(): void {
    if (!this.filePath) return
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.flushDebounceMs)
  }

  // ─── Private: Row Mapping ──────────────────────────────────────────────

  private rowToSessionRecord(row: Record<string, unknown>): SessionRecord {
    return {
      sessionId: row['session_id'] as string,
      displayName: (row['display_name'] as string) ?? '',
      agentletId: (row['agentlet_id'] as string) ?? undefined,
      owner: row['owner'] as string,
      command: row['command'] as string,
      cwd: row['cwd'] as string,
      env: row['env'] ? JSON.parse(row['env'] as string) : undefined,
      status: row['status'] as SessionStatus,
      supportsLoad: row['supports_load'] === 1,
      supportsResume: row['supports_resume'] === 1,
      initializeResult: row['initialize_result'] ? JSON.parse(row['initialize_result'] as string) : undefined,
      newSessionResult: row['new_session_result'] ? JSON.parse(row['new_session_result'] as string) : undefined,
      profile: (row['profile'] as string) ?? undefined,
      idleTimeoutSecs: row['idle_timeout_secs'] as number,
      autoRestart: row['auto_restart'] === 1,
      createdAt: row['created_at'] as string,
      suspendedAt: (row['suspended_at'] as string) ?? undefined,
      updatedAt: row['updated_at'] as string,
    }
  }

  private rowToAgentletRecord(row: Record<string, unknown>): AgentletRecord {
    return {
      agentletId: row['agentlet_id'] as string,
      owner: row['owner'] as string,
      machine: row['machine'] ? JSON.parse(row['machine'] as string) : undefined,
      bridge: JSON.parse(row['bridge'] as string),
      capabilities: JSON.parse(row['capabilities'] as string),
      registeredAt: row['registered_at'] as string,
      updatedAt: row['updated_at'] as string,
    }
  }
}

/** @deprecated Use DataStore */
export const SessionStore = DataStore
