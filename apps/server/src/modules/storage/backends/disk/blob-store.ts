/**
 * Disk implementation of the blob port.
 *
 * Maps a canvas scope to `<canvasDir>/.artifacts/`, preserving the layout
 * the workspace format has always used: one file per blob, named by the
 * URL key, no manifest indirection.
 *
 * Each scope is bound to the workspace active when it is created. A fresh
 * scope follows a free-mode workspace switch; a retained scope rejects the
 * next operation instead of silently redirecting it into the new workspace.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { artifactsDir } from '../../../workspace/disk/paths.js';
import { getWorkspacePath } from '../../../workspace.js';
import { createBlobLease, normalizeBlobName } from '../../ports/blob.js';

import type {
  BlobInfo,
  BlobLease,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobScopeRef,
  BlobStore,
} from '../../ports/blob.js';
import type { StorageHealth } from '../../ports/common.js';
import type { Readable } from 'node:stream';

/**
 * Prefix for the sibling file a write lands in before it is renamed into
 * place. Dot-prefixed and unique per call, so a concurrent writer of the same
 * name never shares one, and a process killed mid-write leaves something
 * recognizably not-a-blob behind.
 */
const TEMP_PREFIX = '.blobtmp-';

/** Scope directory entries that are in-flight writes, not blobs. */
function isTempEntry(entry: string): boolean {
  return entry.startsWith(TEMP_PREFIX);
}

/** Resolve a scope to its backing directory. */
function scopeDir(ref: BlobScopeRef): string {
  return artifactsDir(ref.canvasId);
}

/** Resolve one blob beneath an already-bound scope directory. */
function blobPath(dir: string, name: string): string {
  return path.join(dir, normalizeBlobName(name));
}

/** Treat a missing file as absence rather than an error. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

class DiskBlobScope implements BlobScope {
  readonly #ref: BlobScopeRef;
  readonly #workspacePath: string;

  constructor(ref: BlobScopeRef) {
    this.#ref = ref;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  #resolveDir(): string {
    const active = path.resolve(getWorkspacePath());
    if (active !== this.#workspacePath) {
      throw new Error(
        `DiskBlobScope(${this.#ref.canvasId}) belongs to an inactive workspace. ` +
          `Resolve a fresh scope after workspace activation.`,
      );
    }
    // Resolve once per operation, before its first await. Every later path in
    // that operation is derived from this absolute directory, so a workspace
    // switch cannot combine a temp in A with a destination in B.
    return scopeDir(this.#ref);
  }

  async #headAt(dir: string, name: string): Promise<BlobInfo | null> {
    const safe = normalizeBlobName(name);
    try {
      const stats = await stat(blobPath(dir, safe));
      if (!stats.isFile()) return null;
      return {
        name: safe,
        size: stats.size,
        updatedAt: stats.mtimeMs,
      };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /**
   * Write to a unique sibling, then rename into place.
   *
   * Matches the atomic-write invariant the rest of the storage module holds
   * (`io.ts`): a reader either sees the previous blob or the new one, never a
   * prefix of the new one. That matters because names are reused —
   * content-derived snapshot filenames are regenerated — and because a failed
   * write must not leave a truncated blob at a live key, which the port has
   * no per-key delete to clean up.
   */
  async put(name: string, body: Readable | Buffer): Promise<BlobInfo> {
    const safe = normalizeBlobName(name);
    const dir = this.#resolveDir();
    await mkdir(dir, { recursive: true });

    const full = blobPath(dir, safe);
    const temp = path.join(dir, `${TEMP_PREFIX}${randomUUID()}`);

    try {
      if (Buffer.isBuffer(body)) {
        await writeFile(temp, body);
      } else {
        await pipeline(body, createWriteStream(temp));
      }
      // Stat before the rename: `rename` preserves size and mtime, and this
      // describes the bytes we wrote rather than whatever a concurrent
      // writer may have put at `full` by the time we look.
      const stats = await stat(temp);
      await rename(temp, full);
      return {
        name: safe,
        size: stats.size,
        updatedAt: stats.mtimeMs,
      };
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async head(name: string): Promise<BlobInfo | null> {
    return this.#headAt(this.#resolveDir(), name);
  }

  async open(name: string, range?: BlobRange): Promise<BlobRead | null> {
    const dir = this.#resolveDir();
    const info = await this.#headAt(dir, name);
    if (!info) return null;
    // `info.size` stays the full blob size; the range only bounds the body.
    const body = createReadStream(blobPath(dir, info.name), {
      start: range?.start,
      end: range?.end,
    });
    return { info, body };
  }

  async read(name: string): Promise<Buffer | null> {
    const dir = this.#resolveDir();
    try {
      return await readFile(blobPath(dir, name));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async hasMany(names: readonly string[]): Promise<ReadonlySet<string>> {
    const dir = this.#resolveDir();
    const requested = new Set(names.map(normalizeBlobName));
    if (requested.size === 0) return new Set();

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (isMissing(err)) return new Set();
      throw err;
    }

    const candidates = entries.filter(
      (entry) => !isTempEntry(entry) && requested.has(entry),
    );
    const infos = await Promise.all(
      candidates.map((entry) => this.#headAt(dir, entry)),
    );
    return new Set(infos.flatMap((info) => (info === null ? [] : [info.name])));
  }

  async list(): Promise<BlobInfo[]> {
    const dir = this.#resolveDir();
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }

    const infos = await Promise.all(
      entries
        .filter((entry) => !isTempEntry(entry))
        .map((entry) => this.#headAt(dir, entry)),
    );
    return infos.filter((info): info is BlobInfo => info !== null);
  }

  async materialize(name: string): Promise<BlobLease | null> {
    const dir = this.#resolveDir();
    const info = await this.#headAt(dir, name);
    if (!info) return null;
    // Disk already *is* a filesystem: hand back the real path and make
    // release a no-op. No copy, so this costs nothing today. The lease
    // still refuses to hand out its path after release, so a consumer
    // can't come to depend on Disk keeping the file (see `createBlobLease`).
    return createBlobLease(blobPath(dir, info.name), async () => {});
  }

  async deleteAll(): Promise<void> {
    await rm(this.#resolveDir(), { recursive: true, force: true });
  }
}

export class DiskBlobStore implements BlobStore {
  readonly kind = 'disk' as const;

  async init(): Promise<void> {
    // Scope directories are created on first write; nothing to prepare.
  }

  async health(): Promise<StorageHealth> {
    return { ok: true, kind: this.kind };
  }

  async close(): Promise<void> {}

  scope(ref: BlobScopeRef): BlobScope {
    return new DiskBlobScope(ref);
  }
}
