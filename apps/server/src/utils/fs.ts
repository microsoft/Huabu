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

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
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

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Read and parse a JSON file. Returns null when missing or unreadable. */
export function readJson<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Read and parse JSON, treating only a genuinely missing path as absence.
 *
 * Unlike {@link readJson}, this is for persistence boundaries that must not
 * collapse malformed data, permission failures, or an unexpected directory
 * into a domain-level "not found" result. Callers can therefore distinguish
 * absence from damaged or unreadable durable state.
 */
export function readJsonStrict<T>(filePath: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    throw new SyntaxError(
      `Expected a persisted JSON value in ${filePath}, received null`,
    );
  }
  return parsed as T;
}

/** Read a UTF-8 text file. Returns null when missing or unreadable. */
export function readText(filePath: string): string | null {
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
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    writeFileSync(tmp, contents, 'utf-8');
    renameSync(tmp, filePath);
  } catch (error) {
    // A failed rename (locked destination, EISDIR, permissions, ...) must not
    // accumulate invisible siblings. The UUID makes each writer independent;
    // cleanup therefore cannot remove another writer's in-flight file.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Preserve the operation's original error. A cleanup failure is useful
      // only if it does not hide why the durable write itself failed.
    }
    throw error;
  }
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
  repairJsonLinesTail(filePath);
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
  repairJsonLinesTail(filePath);
  let buf = '';
  for (const item of items) {
    buf += `${JSON.stringify(item)}\n`;
  }
  appendFileSync(filePath, buf, 'utf-8');
}

/**
 * Restore a JSONL file to an append-safe line boundary after an interrupted
 * write.
 *
 * A valid final JSON value without its newline is preserved by terminating
 * it. A malformed final fragment is the crash tail and is truncated back to
 * the preceding newline. Only ENOENT means there is nothing to repair; all
 * other read/truncate/append failures propagate to the caller.
 */
export function repairJsonLinesTail(filePath: string): void {
  let fd: number;
  try {
    fd = openSync(filePath, 'r+');
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;

    // Scan only the final physical row. In the steady state this is one
    // bounded read, independent of total history size; unusually large rows
    // are assembled chunk-by-chunk until their preceding newline is found.
    const chunkSize = 64 * 1024;
    const tailChunks: Buffer[] = [];
    let cursor = size;
    let tailStart = 0;
    while (cursor > 0) {
      const length = Math.min(chunkSize, cursor);
      const start = cursor - length;
      const chunk = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const bytesRead = readSync(
          fd,
          chunk,
          offset,
          length - offset,
          start + offset,
        );
        if (bytesRead === 0) {
          throw new Error(
            `Unexpected EOF while repairing JSONL file ${filePath}`,
          );
        }
        offset += bytesRead;
      }

      if (cursor === size && chunk[length - 1] === 0x0a) return;

      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        tailStart = start + newline + 1;
        tailChunks.unshift(chunk.subarray(newline + 1));
        break;
      }
      tailChunks.unshift(chunk);
      cursor = start;
    }

    const tail = Buffer.concat(tailChunks).toString('utf8').trim();
    try {
      JSON.parse(tail);
      const newline = Buffer.from('\n');
      writeSync(fd, newline, 0, newline.length, size);
    } catch (error) {
      if (error instanceof SyntaxError) {
        ftruncateSync(fd, tailStart);
        return;
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
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
function parseJsonLines<T>(raw: string, limit?: number): T[] {
  if (limit !== undefined && limit !== null) {
    if (limit <= 0 || raw.length === 0) return [];

    // Walk complete physical lines backwards until `limit` *valid* records
    // have been collected. Counting newlines first is insufficient: a
    // crash-malformed final fragment would consume the whole limit and hide
    // the preceding valid row (the exact tail a monotonic append needs).
    const newestFirst: T[] = [];
    let cursor = raw.length;
    while (cursor > 0 && newestFirst.length < limit) {
      if (raw[cursor - 1] === '\n') cursor--;
      const previousNewline = raw.lastIndexOf('\n', cursor - 1);
      const start = previousNewline + 1;
      const trimmed = raw.slice(start, cursor).trim();
      cursor = previousNewline < 0 ? 0 : previousNewline;
      if (!trimmed) continue;
      try {
        newestFirst.push(JSON.parse(trimmed) as T);
      } catch {
        // Continue past malformed rows until enough valid records are found.
      }
    }
    return newestFirst.reverse();
  }

  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed (likely a crash-truncated tail line).
    }
  }
  return out;
}

export function readJsonLines<T>(filePath: string, limit?: number): T[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  return parseJsonLines<T>(raw, limit);
}

/**
 * Parse a durable JSONL log without mistaking persistent corruption for a
 * crash tail. A malformed final physical row is recoverable only when it is
 * unterminated; malformed interior rows and malformed newline-terminated rows
 * are durable corruption and reject even when a tail limit was requested.
 */
function parseJsonLinesStrict<T>(
  raw: string,
  filePath: string,
  limit?: number,
): T[] {
  const hasLimit = limit !== undefined;
  const retainedLimit =
    typeof limit === 'number' && limit > 0 ? Math.ceil(limit) : 0;
  const out: T[] = [];
  let row = 0;
  let start = 0;

  while (start < raw.length) {
    row += 1;
    const newline = raw.indexOf('\n', start);
    const unterminated = newline < 0;
    const end = unterminated ? raw.length : newline;
    const trimmed = raw.slice(start, end).trim();

    if (trimmed) {
      let parsed: T;
      try {
        parsed = JSON.parse(trimmed) as T;
      } catch (error) {
        if (unterminated) break;
        const detail = error instanceof Error ? `: ${error.message}` : '';
        throw new SyntaxError(
          `Malformed JSONL row ${row} in ${filePath}${detail}`,
        );
      }

      if (!hasLimit) {
        out.push(parsed);
      } else if (retainedLimit > 0) {
        out.push(parsed);
        if (out.length > retainedLimit) out.shift();
      }
    }

    if (unterminated) break;
    start = newline + 1;
  }

  return out;
}

/**
 * Strict JSONL read for persistence boundaries: only a missing file is an
 * empty log. Only a malformed final unterminated row is treated as a
 * crash-truncated fragment; other malformed rows and non-ENOENT I/O failures
 * propagate.
 */
export function readJsonLinesStrict<T>(filePath: string, limit?: number): T[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return parseJsonLinesStrict<T>(raw, filePath, limit);
}
