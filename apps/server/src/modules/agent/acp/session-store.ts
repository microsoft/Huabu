/**
 * ACP session persistence — disk store for `(canvasId, threadId) →
 * sessionId`. Enables transparent recovery after a server restart:
 * `ensureAcpSession` calls `session/load` (instead of `session/new`)
 * when a record exists, preserving the external agent's session
 * memory across process lifetimes.
 *
 * ### Storage shape
 *
 *   <canvasId>/.history/acp-sessions.json
 *     {
 *       "schemaVersion": 3,
 *       "records": {
 *         "<threadId>": {
 *           "sessionId":       "...",        // returned by session/new
 *           "profileId": "...",              // user-configured profile id
 *           "cwd":             "/repo",       // cwd passed to session/new
 *           "updatedAt":       1700000000000, // epoch ms
 *           "meta":            { ... }        // OPTIONAL last-known
 *                                             // selector/usage snapshot;
 *                                             // see AcpSessionPersistedMeta
 *         }
 *       }
 *     }
 *
 * Absence of file ⇒ no persisted sessions for this canvas (default).
 *
 * ### Lifecycle
 *
 *   - WRITE: after `session/new` succeeds in `service.ensureAcpSessionInner`
 *   - READ:  on registry miss to attempt `session/load`
 *   - DELETE: on stale binding/canvas, or when `session/load` fails
 *     (agent forgot the session) so the next attempt does `session/new`
 *
 * ### Trust + atomicity
 *
 * Reads tolerate missing/malformed files (return null / empty map) so a
 * corrupt persistence layer NEVER bricks the per-thread session lifecycle
 * — at worst the user pays one extra `session/new` round trip. Writes
 * go through `atomicWriteJson` so concurrent readers see either the
 * old or new full snapshot.
 *
 * ### Concurrency
 *
 * In-process callers serialize through `ensureAcpSession`'s
 * `inflightEnsureSessions` map, so per-thread writes never race in
 * normal flow. Cross-thread writes on the same canvas race on the
 * file: each writer reads-modifies-writes the whole file. Under
 * contention the last writer wins for the FILE but each thread's
 * own record key is unaffected (we never delete other threads'
 * entries during a write). Acceptable trade-off for an in-memory
 * registry's persistence layer.
 */

import { atomicWriteJson, readJson, sanitizeId } from '../../storage/io.js';
import { acpSessionsPath } from '../../storage/paths.js';

import type {
  AcpCost,
  AcpModelInfo,
  AcpSessionConfigOption,
  AcpSessionMode,
  AvailableCommand,
} from '@sediment/shared';

/**
 * Bumped only on a breaking layout change.
 *
 * v1 (legacy, removed): record carried `agentletAgentId`, the
 * volatile agentlet connection id of the per-CLI bridge handshake.
 * v2 carried `profileId` only — the user-configured spawn recipe id.
 * v3 adds `bindingRecipe` (command/cwd/autoRestart/alias snapshot) so
 * the thread is fully self-contained: deleting or mutating the
 * profile no longer affects existing threads. `profileId` is kept
 * (nullable) purely as provenance for diagnostics; the orchestrator
 * never reads it. The loader accepts v2 records (recipe-absent) and
 * uses profile lookup as a fallback in `ensureAcpSessionInner` so
 * pre-v3 threads keep working until they're re-bound.
 */
const ACP_SESSION_STORE_SCHEMA_VERSION = 3;

/**
 * Snapshot of the spawn recipe at thread-binding time. Decouples
 * the thread from the profile: once a thread is opened against a
 * profile, this record is what we use to (re-)spawn the agent for
 * subsequent prompts. Profile mutations / deletions after this point
 * are NOT propagated.
 *
 * Mirrors the subset of `AcpAgentProfile` that determines spawn
 * behaviour. `alias` is the profile's display name at snapshot time
 * — used purely for UI / log labelling.
 */
export interface AcpBindingRecipe {
  command: string;
  cwd: string;
  autoRestart: boolean;
  alias: string;
}

/**
 * Snapshot of selector/usage state that the agent pushed via
 * `session/new`, `session/load`, or `session/update` notifications.
 *
 * Persisted alongside the sessionId so that the "already loaded"
 * recovery branch in `service.ensureAcpSessionInner` can rehydrate
 * the registry entry without waiting for the agent to re-emit
 * notifications (which it generally will NOT do for a session that
 * is already loaded in its memory).
 *
 * All fields are optional: older records (and records for sessions
 * that never received the corresponding update) parse cleanly and
 * simply restore nothing.
 */
export interface AcpSessionPersistedMeta {
  availableCommands?: AvailableCommand[];
  commandsUpdatedAt?: number;
  availableModes?: AcpSessionMode[];
  currentModeId?: string | null;
  availableModels?: AcpModelInfo[];
  currentModelId?: string | null;
  configOptions?: AcpSessionConfigOption[];
  sessionInfo?: { title: string | null; updatedAt: string | null } | null;
  usage?: { used: number; size: number; cost: AcpCost | null } | null;
  metaUpdatedAt?: number;
}

/** One persisted session entry per Sediment thread on a canvas. */
export interface AcpSessionRecord {
  /** ACP session id returned by `session/new`; the key for `session/load`. */
  sessionId: string;
  /**
   * Profile id this thread was first opened against. Retained as
   * provenance / diagnostics only — the orchestrator no longer
   * reads it (recipe-first). May be the empty string for records
   * created without a profile (future-proofing).
   */
  profileId: string;
  /** `cwd` originally passed to `session/new`; replayed on `session/load`. */
  cwd: string;
  /** Epoch ms of the last write. Diagnostic only. */
  updatedAt: number;
  /**
   * Self-contained spawn recipe captured at thread-binding time.
   * Optional ONLY for backwards-compat with v2 records on disk —
   * newly written records ALWAYS carry it. When absent, callers must
   * fall back to looking up the profile by id and re-snapshotting.
   */
  bindingRecipe?: AcpBindingRecipe;
  /**
   * Last-known snapshot of selector/usage state. Optional — absent for
   * legacy records written before this field existed, and for records
   * that never received any meta updates. See {@link AcpSessionPersistedMeta}.
   */
  meta?: AcpSessionPersistedMeta;
}

interface SessionStoreFile {
  schemaVersion: number;
  records: Record<string, AcpSessionRecord>;
}

function emptyFile(): SessionStoreFile {
  return { schemaVersion: ACP_SESSION_STORE_SCHEMA_VERSION, records: {} };
}

function isRecord(value: unknown): value is AcpSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (
    !(
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      typeof r.profileId === 'string' &&
      typeof r.cwd === 'string' &&
      typeof r.updatedAt === 'number'
    )
  ) {
    return false;
  }
  // `meta` is optional. When present it MUST be an object; otherwise the
  // whole record is rejected. Individual meta fields are validated
  // permissively in `sanitizeMeta` below so a single malformed field
  // never invalidates an otherwise-valid record.
  if (r.meta !== undefined && (r.meta === null || typeof r.meta !== 'object')) {
    return false;
  }
  // `bindingRecipe` is optional (absent on v2 records). When present
  // we require it to be a plain object — individual fields are checked
  // by `sanitizeBindingRecipe` below.
  if (
    r.bindingRecipe !== undefined &&
    (r.bindingRecipe === null || typeof r.bindingRecipe !== 'object')
  ) {
    return false;
  }
  return true;
}

function sanitizeBindingRecipe(raw: unknown): AcpBindingRecipe | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== 'string' || r.command.length === 0) return undefined;
  if (typeof r.cwd !== 'string') return undefined;
  if (typeof r.alias !== 'string') return undefined;
  return {
    command: r.command,
    cwd: r.cwd,
    autoRestart: r.autoRestart === true,
    alias: r.alias,
  };
}

/**
 * Defensively shape-check a {@link AcpSessionPersistedMeta} payload
 * loaded from disk. Returns a cleaned copy containing only fields that
 * pass minimal type validation. Returns `undefined` when the input is
 * not a plain object or yields zero valid fields (so callers can keep
 * the property absent rather than store an empty `{}`).
 */
function sanitizeMeta(raw: unknown): AcpSessionPersistedMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: AcpSessionPersistedMeta = {};
  let touched = false;
  if (Array.isArray(r.availableCommands)) {
    out.availableCommands = r.availableCommands as AvailableCommand[];
    touched = true;
  }
  if (typeof r.commandsUpdatedAt === 'number') {
    out.commandsUpdatedAt = r.commandsUpdatedAt;
    touched = true;
  }
  if (Array.isArray(r.availableModes)) {
    out.availableModes = r.availableModes as AcpSessionMode[];
    touched = true;
  }
  if (r.currentModeId === null || typeof r.currentModeId === 'string') {
    out.currentModeId = r.currentModeId as string | null;
    touched = true;
  }
  if (Array.isArray(r.availableModels)) {
    out.availableModels = r.availableModels as AcpModelInfo[];
    touched = true;
  }
  if (r.currentModelId === null || typeof r.currentModelId === 'string') {
    out.currentModelId = r.currentModelId as string | null;
    touched = true;
  }
  if (Array.isArray(r.configOptions)) {
    out.configOptions = r.configOptions as AcpSessionConfigOption[];
    touched = true;
  }
  if (r.sessionInfo === null) {
    out.sessionInfo = null;
    touched = true;
  } else if (r.sessionInfo && typeof r.sessionInfo === 'object') {
    const si = r.sessionInfo as { title?: unknown; updatedAt?: unknown };
    out.sessionInfo = {
      title: typeof si.title === 'string' ? si.title : null,
      updatedAt: typeof si.updatedAt === 'string' ? si.updatedAt : null,
    };
    touched = true;
  }
  if (r.usage === null) {
    out.usage = null;
    touched = true;
  } else if (r.usage && typeof r.usage === 'object') {
    const u = r.usage as { used?: unknown; size?: unknown; cost?: unknown };
    if (typeof u.used === 'number' && typeof u.size === 'number') {
      let cost: AcpCost | null = null;
      if (u.cost && typeof u.cost === 'object') {
        const c = u.cost as { amount?: unknown; currency?: unknown };
        if (typeof c.amount === 'number' && typeof c.currency === 'string') {
          cost = { amount: c.amount, currency: c.currency };
        }
      }
      out.usage = { used: u.used, size: u.size, cost };
      touched = true;
    }
  }
  if (typeof r.metaUpdatedAt === 'number') {
    out.metaUpdatedAt = r.metaUpdatedAt;
    touched = true;
  }
  return touched ? out : undefined;
}

/**
 * Load and validate the full store file for `canvasId`. Returns an
 * empty (in-memory) file when the path is missing or corrupted —
 * NEVER throws; persistence is best-effort. Unknown record entries
 * (missing required fields) are silently dropped from the in-memory
 * view but left untouched on disk until the next write.
 */
function readFile(canvasId: string): SessionStoreFile {
  const raw = readJson<unknown>(acpSessionsPath(canvasId));
  if (!raw || typeof raw !== 'object') return emptyFile();
  const obj = raw as Record<string, unknown>;
  const records: Record<string, AcpSessionRecord> = {};
  const maybeRecords = obj.records;
  if (maybeRecords && typeof maybeRecords === 'object') {
    for (const [key, value] of Object.entries(
      maybeRecords as Record<string, unknown>,
    )) {
      if (!isRecord(value)) continue;
      // Replace any malformed meta with a sanitised copy (or drop the
      // field entirely) so callers can trust whatever they receive
      // without re-validating.
      const meta = sanitizeMeta((value as { meta?: unknown }).meta);
      const bindingRecipe = sanitizeBindingRecipe(
        (value as { bindingRecipe?: unknown }).bindingRecipe,
      );
      const cleaned: AcpSessionRecord = { ...value };
      if (meta) cleaned.meta = meta;
      else delete cleaned.meta;
      if (bindingRecipe) cleaned.bindingRecipe = bindingRecipe;
      else delete cleaned.bindingRecipe;
      records[key] = cleaned;
    }
  }
  return { schemaVersion: ACP_SESSION_STORE_SCHEMA_VERSION, records };
}

/**
 * Look up the persisted record for `(canvasId, threadId)`.
 * Returns null when `canvasId` is empty, the file is missing,
 * or the threadId has no entry.
 */
export function readAcpSessionRecord(
  canvasId: string,
  threadId: string,
): AcpSessionRecord | null {
  if (!canvasId) return null;
  try {
    sanitizeId(threadId, 'threadId');
  } catch {
    return null;
  }
  const file = readFile(canvasId);
  return file.records[threadId] ?? null;
}

/**
 * Insert or replace the record for `(canvasId, threadId)`. No-op
 * when `canvasId` is empty (mirrors {@link readAcpSessionRecord}).
 * Stamps `updatedAt` automatically. Pass `meta` to capture the
 * latest selector/usage snapshot alongside the sessionId.
 */
export function writeAcpSessionRecord(
  canvasId: string,
  threadId: string,
  record: Omit<AcpSessionRecord, 'updatedAt'>,
): void {
  if (!canvasId) return;
  sanitizeId(threadId, 'threadId');
  const file = readFile(canvasId);
  const next: AcpSessionRecord = {
    sessionId: record.sessionId,
    profileId: record.profileId,
    cwd: record.cwd,
    updatedAt: Date.now(),
  };
  if (record.meta) next.meta = record.meta;
  if (record.bindingRecipe) next.bindingRecipe = record.bindingRecipe;
  file.records[threadId] = next;
  atomicWriteJson(acpSessionsPath(canvasId), file);
}

/**
 * Update only the `meta` field for an existing record, leaving the
 * sessionId / profileId / cwd untouched. No-op when `canvasId`
 * is empty OR no record exists for `(canvasId, threadId)` — the meta
 * is per-session state, so persisting it without the parent record
 * would leak across recreations.
 *
 * Passing `meta = null` clears the field. Stamps `updatedAt`.
 */
export function writeAcpSessionMeta(
  canvasId: string,
  threadId: string,
  meta: AcpSessionPersistedMeta | null,
): boolean {
  if (!canvasId) return false;
  try {
    sanitizeId(threadId, 'threadId');
  } catch {
    return false;
  }
  const file = readFile(canvasId);
  const existing = file.records[threadId];
  if (!existing) return false;
  const next: AcpSessionRecord = {
    sessionId: existing.sessionId,
    profileId: existing.profileId,
    cwd: existing.cwd,
    updatedAt: Date.now(),
  };
  if (meta) next.meta = meta;
  if (existing.bindingRecipe) next.bindingRecipe = existing.bindingRecipe;
  file.records[threadId] = next;
  atomicWriteJson(acpSessionsPath(canvasId), file);
  return true;
}

/**
 * Remove the record for `(canvasId, threadId)`. Returns true when an
 * entry existed and was deleted. No-op when `canvasId` is empty or no
 * entry was present; the file is rewritten unconditionally when an
 * entry IS removed (to commit the deletion) and untouched otherwise.
 */
export function deleteAcpSessionRecord(
  canvasId: string,
  threadId: string,
): boolean {
  if (!canvasId) return false;
  try {
    sanitizeId(threadId, 'threadId');
  } catch {
    return false;
  }
  const file = readFile(canvasId);
  if (!(threadId in file.records)) return false;
  delete file.records[threadId];
  atomicWriteJson(acpSessionsPath(canvasId), file);
  return true;
}
