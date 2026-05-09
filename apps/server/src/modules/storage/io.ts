/**
 * Low-level filesystem helpers shared by the storage module.
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
 * Append an item to a JSON array file. Creates the file with `[item]`
 * when it does not yet exist. Reads-modifies-writes the whole array; this
 * is intentionally simple and is suitable for low-volume logs (events,
 * intents).
 */
export function appendJsonArray<T>(filePath: string, item: T): void {
  const existing = readJson<T[]>(filePath);
  const next = Array.isArray(existing) ? [...existing, item] : [item];
  atomicWriteJson(filePath, next);
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
 * The scan still walks the whole file but starts JSON-parsing from a
 * position that gives us at most ~`limit` lines, keeping tail reads fast
 * for typical "show me the last N events" calls.
 */
export function readJsonLines<T>(filePath: string, limit?: number): T[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const start = limit != null ? Math.max(0, lines.length - limit - 1) : 0;
  const out: T[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed (likely a crash-truncated tail line).
    }
  }
  return limit != null && out.length > limit ? out.slice(-limit) : out;
}
