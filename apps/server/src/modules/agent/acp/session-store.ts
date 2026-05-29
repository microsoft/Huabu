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
 *       "schemaVersion": 1,
 *       "records": {
 *         "<threadId>": {
 *           "sessionId":       "...",        // returned by session/new
 *           "agentletAgentId": "...",        // binding identifier
 *           "cwd":             "/repo",       // cwd passed to session/new
 *           "updatedAt":       1700000000000  // epoch ms
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

/** Bumped only on a breaking layout change. */
const ACP_SESSION_STORE_SCHEMA_VERSION = 1;

/** One persisted session entry per Sediment thread on a canvas. */
export interface AcpSessionRecord {
  /** ACP session id returned by `session/new`; the key for `session/load`. */
  sessionId: string;
  /**
   * agentlet agent id this session was opened against. We compare on
   * read so a binding change (thread re-pointed at a different agent)
   * discards the stale record instead of trying to load it.
   */
  agentletAgentId: string;
  /** `cwd` originally passed to `session/new`; replayed on `session/load`. */
  cwd: string;
  /** Epoch ms of the last write. Diagnostic only. */
  updatedAt: number;
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
  return (
    typeof r.sessionId === 'string' &&
    r.sessionId.length > 0 &&
    typeof r.agentletAgentId === 'string' &&
    r.agentletAgentId.length > 0 &&
    typeof r.cwd === 'string' &&
    typeof r.updatedAt === 'number'
  );
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
      if (isRecord(value)) records[key] = value;
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
 * Stamps `updatedAt` automatically.
 */
export function writeAcpSessionRecord(
  canvasId: string,
  threadId: string,
  record: Omit<AcpSessionRecord, 'updatedAt'>,
): void {
  if (!canvasId) return;
  sanitizeId(threadId, 'threadId');
  const file = readFile(canvasId);
  file.records[threadId] = { ...record, updatedAt: Date.now() };
  atomicWriteJson(acpSessionsPath(canvasId), file);
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
