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

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { artifactPath, artifactsDir } from '../paths.js';
import { normalizeBlobName } from '../ports/blob.js';

import type {
  BlobInfo,
  BlobLease,
  BlobPutOptions,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobScopeRef,
  BlobStore,
} from '../ports/blob.js';
import type { StorageHealth } from '../ports/common.js';
import type { Readable } from 'node:stream';

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

  async put(
    name: string,
    body: Readable | Buffer,
    options?: BlobPutOptions,
  ): Promise<BlobInfo> {
    const safe = normalizeBlobName(name);
    await mkdir(scopeDir(this.ref), { recursive: true });
    const full = blobPath(this.ref, safe);

    if (Buffer.isBuffer(body)) {
      await writeFile(full, body);
    } else {
      await pipeline(body, createWriteStream(full));
    }

    const stats = await stat(full);
    return {
      name: safe,
      size: stats.size,
      mimeType: options?.mimeType ?? null,
      updatedAt: stats.mtimeMs,
    };
  }

  async head(name: string): Promise<BlobInfo | null> {
    const safe = normalizeBlobName(name);
    try {
      const stats = await stat(blobPath(this.ref, safe));
      if (!stats.isFile()) return null;
      return {
        name: safe,
        size: stats.size,
        // Disk stores no per-blob metadata; MIME type lives with the
        // structured artifact record.
        mimeType: null,
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

  async list(): Promise<BlobInfo[]> {
    let entries: string[];
    try {
      entries = await readdir(scopeDir(this.ref));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }

    const out: BlobInfo[] = [];
    for (const entry of entries) {
      const info = await this.head(entry).catch(() => null);
      if (info) out.push(info);
    }
    return out;
  }

  async materialize(name: string): Promise<BlobLease | null> {
    const info = await this.head(name);
    if (!info) return null;
    // Disk already *is* a filesystem: hand back the real path and make
    // release a no-op. No copy, so this costs nothing today.
    return {
      path: blobPath(this.ref, info.name),
      release: async () => {},
    };
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
