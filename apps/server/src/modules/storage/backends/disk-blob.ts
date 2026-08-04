/**
 * Disk implementation of the blob port.
 *
 * Maps a canvas scope to `<canvasDir>/.artifacts/`, preserving the layout
 * the workspace format has always used: one file per blob, named by the
 * URL key, no manifest indirection.
 *
 * Stateless with respect to the workspace root — every operation resolves
 * through `paths.ts`, which reads `getWorkspacePath()` lazily. That is what
 * lets a free-mode workspace switch take effect with no invalidation step.
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

import { artifactPath, artifactsDir } from '../../workspace/disk/paths.js';
import { createBlobLease, normalizeBlobName } from '../ports/blob.js';

import type {
  BlobInfo,
  BlobLease,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobScopeRef,
  BlobStore,
} from '../ports/blob.js';
import type { StorageHealth } from '../ports/common.js';
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

/** Resolve one blob to its absolute path. */
function blobPath(ref: BlobScopeRef, name: string): string {
  return artifactPath(ref.canvasId, normalizeBlobName(name));
}

/** Treat a missing file as absence rather than an error. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

class DiskBlobScope implements BlobScope {
  constructor(private readonly ref: BlobScopeRef) {}

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
    const dir = scopeDir(this.ref);
    await mkdir(dir, { recursive: true });

    const full = blobPath(this.ref, safe);
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
    const safe = normalizeBlobName(name);
    try {
      const stats = await stat(blobPath(this.ref, safe));
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

  async open(name: string, range?: BlobRange): Promise<BlobRead | null> {
    const info = await this.head(name);
    if (!info) return null;
    // `info.size` stays the full blob size; the range only bounds the body.
    const body = createReadStream(blobPath(this.ref, info.name), {
      start: range?.start,
      end: range?.end,
    });
    return { info, body };
  }

  async read(name: string): Promise<Buffer | null> {
    try {
      return await readFile(blobPath(this.ref, name));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async hasMany(names: readonly string[]): Promise<ReadonlySet<string>> {
    const requested = new Set(names.map(normalizeBlobName));
    if (requested.size === 0) return new Set();

    let entries: string[];
    try {
      entries = await readdir(scopeDir(this.ref));
    } catch (err) {
      if (isMissing(err)) return new Set();
      throw err;
    }

    const candidates = entries.filter(
      (entry) => !isTempEntry(entry) && requested.has(entry),
    );
    const infos = await Promise.all(
      candidates.map((entry) => this.head(entry)),
    );
    return new Set(infos.flatMap((info) => (info === null ? [] : [info.name])));
  }

  async list(): Promise<BlobInfo[]> {
    let entries: string[];
    try {
      entries = await readdir(scopeDir(this.ref));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }

    const infos = await Promise.all(
      entries.filter((entry) => !isTempEntry(entry)).map((e) => this.head(e)),
    );
    return infos.filter((info): info is BlobInfo => info !== null);
  }

  async materialize(name: string): Promise<BlobLease | null> {
    const info = await this.head(name);
    if (!info) return null;
    // Disk already *is* a filesystem: hand back the real path and make
    // release a no-op. No copy, so this costs nothing today. The lease
    // still refuses to hand out its path after release, so a consumer
    // can't come to depend on Disk keeping the file (see `createBlobLease`).
    return createBlobLease(blobPath(this.ref, info.name), async () => {});
  }

  async deleteAll(): Promise<void> {
    await rm(scopeDir(this.ref), { recursive: true, force: true });
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
