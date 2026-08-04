/**
 * Low-level filesystem helpers.
 *
 * Atomic file IO and identifier/path validation are host utilities shared by
 * several domains — storage adapters, the agent memory writers, ACP profile
 * persistence, and the boot-time Workspace migrations — so they live here
 * rather than inside any one of them.
 *
 * Every disk write goes through `atomic*` helpers — write to a `.tmp`
 * sibling first, then rename — so readers never observe partial files.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import path from 'node:path';

/** Pattern allowed for canvas / node / thread identifiers. */
const ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate an identifier (canvas id, node id, thread id, ...).
 * Throws when the input contains characters outside `[a-zA-Z0-9_-]`.
 */
export function sanitizeId(id: string, label = 'id'): string {
  if (!ID_RE.test(id)) {
    throw new Error(`Invalid ${label}: "${id}"`);
  }
  return id;
}

/**
 * Join a base directory and a child segment, ensuring the result stays
 * inside the base. Throws on path traversal attempts.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const joined = path.resolve(base, ...segments);
  const baseResolved = path.resolve(base);
  if (joined !== baseResolved && !joined.startsWith(baseResolved + path.sep)) {
    throw new Error(
      `Refusing to escape base directory: base=${baseResolved} resolved=${joined}`,
    );
  }
  return joined;
}

/** Create a directory recursively (no-op if it already exists). */
export function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
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

/** Read a UTF-8 text file. Returns null when missing or unreadable. */
export function readText(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Async, non-blocking variant of {@link readText}. Returns null when the
 * file is missing or unreadable. Skips the pre-flight `existsSync` stat
 * and treats a failed read (e.g. `ENOENT`) as `null`, so it costs one
 * syscall on the happy path and never blocks the event loop.
 */
export async function readTextAsync(filePath: string): Promise<string | null> {
  try {
    return await readFileAsync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Map `items` through an async `fn` with a bounded number of in-flight
 * calls. A fixed pool of `limit` workers pulls from a shared cursor so
 * at most `limit` promises are pending at once — this caps peak memory
 * and open file descriptors when fanning out many filesystem reads,
 * while still overlapping I/O for throughput. Results are returned in
 * input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Atomic write of a UTF-8 text file. */
export function atomicWriteText(filePath: string, contents: string): void {
  mkdirp(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, contents, 'utf-8');
  renameSync(tmp, filePath);
}

/** Atomic write of a JSON file (pretty-printed with 2-space indent). */
export function atomicWriteJson(filePath: string, data: unknown): void {
  atomicWriteText(filePath, JSON.stringify(data, null, 2));
}

/**
 * Append a single JSON object as one line (JSONL).
 *
 * Uses a single `appendFileSync`, which maps to one `write(2)` syscall on
 * POSIX — atomic at the line boundary, so a crash mid-write at worst
 * leaves a truncated final line that `readJsonLines` will skip. Suited
 * for high-volume append-only logs (canvas events).
 */
export function appendJsonLine<T>(filePath: string, item: T): void {
  mkdirp(path.dirname(filePath));
  appendFileSync(filePath, `${JSON.stringify(item)}\n`, 'utf-8');
}

/**
 * Append many JSON objects as JSONL lines in a single write.
 *
 * Builds one buffer of `N` lines and issues a single `appendFileSync`.
 * Either every line lands or (on crash mid-write) the trailing partial
 * line is dropped by the reader. No-op when `items` is empty.
 */
export function appendJsonLines<T>(
  filePath: string,
  items: readonly T[],
): void {
  if (items.length === 0) return;
  mkdirp(path.dirname(filePath));
  let buf = '';
  for (const item of items) {
    buf += `${JSON.stringify(item)}\n`;
  }
  appendFileSync(filePath, buf, 'utf-8');
}

/**
 * Read a JSONL file and parse each non-empty line. Malformed lines are
 * skipped silently (they typically come from a crash-truncated tail).
 *
 * When `limit` is set, only the last `limit` parsed records are returned.
 * For tail reads the function scans backwards from the end of the raw
 * string to locate the start of the last `limit` lines before splitting,
 * so only a small slice of the buffer is materialised into strings.
 */
export function readJsonLines<T>(filePath: string, limit?: number): T[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  let slice = raw;
  if (limit != null && raw.length > 0) {
    // Scan backwards to find the byte offset where the last `limit` lines begin.
    // This avoids splitting the entire file into an array of strings.
    let newlines = 0;
    let pos = raw.length - 1;
    if (raw[pos] === '\n') pos--; // skip trailing newline
    while (pos >= 0 && newlines < limit) {
      if (raw[pos] === '\n') newlines++;
      pos--;
    }
    // pos is now one position before the start of the first kept line.
    slice = raw.slice(pos + 1);
  }

  const out: T[] = [];
  for (const line of slice.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed (likely a crash-truncated tail line).
    }
  }
  return limit != null && out.length > limit ? out.slice(-limit) : out;
}
