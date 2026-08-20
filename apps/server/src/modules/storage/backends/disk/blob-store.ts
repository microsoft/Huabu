// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  artifactsDir,
  canvasRoot,
  spaceMemoryDir,
  spaceUploadDir,
} from './layout.js';
import { renameOverWithRetry } from '../../../../utils/fs.js';
import { getWorkspacePath } from '../../../workspace.js';
import {
  BlobNameError,
  createBlobLease,
  normalizeBlobName,
  SPACE_GUIDE_BLOB_NAMES,
} from '../../ports/blob.js';

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
/**
 * Where one scope's bytes sit, and which names it owns there.
 *
 * `members: null` means the directory *is* the scope — everything in it
 * belongs. A name list means the scope is bounded by its members instead, for
 * an area shared with files that are not blobs at all.
 */
interface ScopePlacement {
  readonly directory: string;
  readonly members: readonly string[] | null;
}

function scopePlacement(ref: BlobScopeRef): ScopePlacement {
  switch (ref.kind) {
    case 'space-artifacts':
      return { directory: artifactsDir(ref.canvasId), members: null };
    case 'space-memory':
      return { directory: spaceMemoryDir(ref.canvasId), members: null };
    case 'space-upload':
      return { directory: spaceUploadDir(ref.canvasId), members: null };
    case 'space-guide':
      // The Space root, which also holds `space.json` and every node
      // directory — so this scope is the guide names, not the folder.
      return {
        directory: canvasRoot(ref.canvasId),
        members: SPACE_GUIDE_BLOB_NAMES,
      };
  }
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

  #placement(): ScopePlacement {
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
    return scopePlacement(this.#ref);
  }

  /** Names this scope owns in `dir`, given what is actually there. */
  async #entries(placement: ScopePlacement): Promise<string[]> {
    if (placement.members) {
      // A member-bounded scope never reads the directory: everything else in
      // it belongs to someone else, and listing it would claim otherwise.
      const present = await Promise.all(
        placement.members.map(async (name) =>
          (await this.#headAt(placement.directory, name)) ? name : null,
        ),
      );
      return present.filter((name): name is string => name !== null);
    }
    try {
      return (await readdir(placement.directory)).filter(
        (entry) => !isTempEntry(entry),
      );
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  /** Refuse a name this scope does not own, before it reaches the filesystem. */
  #assertMember(placement: ScopePlacement, name: string): string {
    const safe = normalizeBlobName(name);
    if (placement.members && !placement.members.includes(safe)) {
      throw new BlobNameError(
        `"${safe}" is not a member of the ${this.#ref.kind} scope. ` +
          `It holds: ${placement.members.join(', ')}.`,
      );
    }
    return safe;
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
   * (`utils/fs.ts`): a reader either sees the previous blob or the new one,
   * never a
   * prefix of the new one. That matters because names are reused —
   * content-derived snapshot filenames are regenerated — and because a failed
   * write must not leave a truncated blob at a live key, which the port has
   * no per-key delete to clean up.
   */
  async put(name: string, body: Readable | Buffer): Promise<BlobInfo> {
    const placement = this.#placement();
    const safe = this.#assertMember(placement, name);
    const dir = placement.directory;
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
      await renameOverWithRetry(temp, full);
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
    const placement = this.#placement();
    return this.#headAt(
      placement.directory,
      this.#assertMember(placement, name),
    );
  }

  async open(name: string, range?: BlobRange): Promise<BlobRead | null> {
    const placement = this.#placement();
    const dir = placement.directory;
    const info = await this.#headAt(dir, this.#assertMember(placement, name));
    if (!info) return null;
    // `info.size` stays the full blob size; the range only bounds the body.
    const body = createReadStream(blobPath(dir, info.name), {
      start: range?.start,
      end: range?.end,
    });
    return { info, body };
  }

  async read(name: string): Promise<Buffer | null> {
    const placement = this.#placement();
    const safe = this.#assertMember(placement, name);
    try {
      return await readFile(blobPath(placement.directory, safe));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async hasMany(names: readonly string[]): Promise<ReadonlySet<string>> {
    const placement = this.#placement();
    const requested = new Set(names.map(normalizeBlobName));
    if (requested.size === 0) return new Set();

    const entries = (await this.#entries(placement)).filter((entry) =>
      requested.has(entry),
    );
    const infos = await Promise.all(
      entries.map((entry) => this.#headAt(placement.directory, entry)),
    );
    return new Set(infos.flatMap((info) => (info === null ? [] : [info.name])));
  }

  async list(): Promise<BlobInfo[]> {
    const placement = this.#placement();
    const entries = await this.#entries(placement);
    const infos = await Promise.all(
      entries.map((entry) => this.#headAt(placement.directory, entry)),
    );
    return infos.filter((info): info is BlobInfo => info !== null);
  }

  async materialize(name: string): Promise<BlobLease | null> {
    const placement = this.#placement();
    const dir = placement.directory;
    const info = await this.#headAt(dir, this.#assertMember(placement, name));
    if (!info) return null;
    // Disk already *is* a filesystem: hand back the real path and make
    // release a no-op. No copy, so this costs nothing today. The lease
    // still refuses to hand out its path after release, so a consumer
    // can't come to depend on Disk keeping the file (see `createBlobLease`).
    return createBlobLease(blobPath(dir, info.name), async () => {});
  }

  async deleteAll(): Promise<void> {
    const placement = this.#placement();
    if (!placement.members) {
      await rm(placement.directory, { recursive: true, force: true });
      return;
    }
    // Removing the directory would take the Space with it. Only the members
    // are this scope's to delete.
    await Promise.all(
      placement.members.map((name) =>
        rm(blobPath(placement.directory, name), { force: true }),
      ),
    );
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
