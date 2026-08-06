// Minimal filesystem helpers the durable FileThreadStore needs. A
// self-contained copy of the subset of Sediment's storage/io helpers used
// here, so the instance package owns its persistence primitives without
// depending on the host. Every disk write is atomic (write to a `.tmp`
// sibling, then rename) so readers never observe a partial file.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Pattern allowed for namespace / thread identifiers. */
const ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate an identifier (namespace name, thread id, ...). Throws when the
 * input contains characters outside `[a-zA-Z0-9_-]`.
 */
export function sanitizeId(id: string, label = 'id'): string {
  if (!ID_RE.test(id)) {
    throw new Error(`Invalid ${label}: "${id}"`);
  }
  return id;
}

/** Read and parse a JSON file. Returns null when missing or unreadable. */
export function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Backoff schedule (ms) for a rename whose target is momentarily locked.
 * Bounded at ~310ms: long enough to outlast a virus scan or a cloud-sync
 * client's read, short enough that a genuinely broken write still fails fast.
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

/**
 * Windows fails a rename whose destination is open in another handle. Unlike a
 * POSIX `rename(2)`, which replaces the target atomically and cannot fail this
 * way, `MoveFileEx` reports `EPERM` (or `EACCES` / `EBUSY`) whenever a virus
 * scanner, a cloud-sync client, an editor, or a file watcher holds the file
 * open — none of which require a second writer.
 */
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/** Blocks the thread; only ever between rename attempts. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** {@link renameSync} that rides out a transiently locked destination. */
function renameOverWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (
        attempt >= RENAME_RETRY_DELAYS_MS.length ||
        !isTransientRenameError(err)
      ) {
        throw err;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Atomic write of a JSON file (pretty-printed with 2-space indent). */
export function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameOverWithRetry(tmp, filePath);
}

/**
 * Append one JSON value as a single line to a JSONL file (creating parent
 * dirs as needed). Append-only: the existing lines are never rewritten, so
 * the cost is O(one line), not O(whole file) — the write pattern the
 * append-only Tier-1 event log relies on (README I9.8).
 */
export function appendJsonLine(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(data)}\n`, 'utf-8');
}

/**
 * Read a JSONL file into an array, one parsed value per non-empty line.
 * Returns `[]` when the file is missing or unreadable, and silently skips
 * any single malformed line so a partial trailing write never bricks a
 * read.
 */
export function readJsonLines<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip a malformed / partially-written line.
    }
  }
  return out;
}
