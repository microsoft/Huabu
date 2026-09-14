// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';

import { sanitizeId } from '../../../../utils/fs.js';
import { createKeyedMutex } from '../../../../utils/keyed-mutex.js';
import { getWorkspaceKey } from '../../../workspace.js';
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
  BlobStore,
  SpaceBlobs,
} from '../../ports/blob.js';
import type { StorageHealth } from '../../ports/common.js';

// Azure commits discard other uncommitted blocks on the same object. Serialize
// staging + commit across scope handles in this process, keyed without SAS data.
// A multi-Server deployment would need distributed writer ownership instead.
const serializeUpload = createKeyedMutex<string>();
const BLOCK_SIZE = 4 * 1024 * 1024;
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    error.statusCode === 404
  );
}

/** Container ownership stays with the operator. Closing/deleting a Space never deletes it. */
export class AzureBlobStore implements BlobStore {
  readonly kind = 'azure' as const;
  #state: 'new' | 'open' | 'closed' = 'new';
  constructor(
    readonly container: ContainerClient,
    private readonly workspaceKey: () => string = getWorkspaceKey,
    private readonly prefix = 'huabu',
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix))
      throw new Error('Azure blob prefix must be a non-empty single segment');
  }
  static fromEnvironment(): AzureBlobStore {
    const connection = process.env['HUABU_AZURE_STORAGE_CONNECTION_STRING'];
    const container = process.env['HUABU_AZURE_BLOB_CONTAINER']?.trim();
    if (!connection || !container)
      throw new Error(
        'Azure blobs require HUABU_AZURE_STORAGE_CONNECTION_STRING and HUABU_AZURE_BLOB_CONTAINER',
      );
    return new AzureBlobStore(
      BlobServiceClient.fromConnectionString(connection).getContainerClient(
        container,
      ),
      getWorkspaceKey,
      process.env['HUABU_AZURE_BLOB_PREFIX']?.trim() || 'huabu',
    );
  }
  async init(): Promise<void> {
    if (this.#state === 'closed') throw new Error('Azure blob store is closed');
    await this.container.getProperties();
    this.#state = 'open';
  }
  assertOpen(): void {
    if (this.#state !== 'open')
      throw new Error(
        `Azure blob store is ${this.#state === 'closed' ? 'closed' : 'not initialized'}`,
      );
  }
  async health(): Promise<StorageHealth> {
    try {
      this.assertOpen();
      await this.container.getProperties();
      return { ok: true, kind: this.kind };
    } catch {
      return {
        ok: false,
        kind: this.kind,
        detail: 'Azure blob container is unavailable',
      };
    }
  }
  async close(): Promise<void> {
    this.#state = 'closed';
  }
  space(canvasIdInput: string): SpaceBlobs {
    const canvasId = sanitizeId(canvasIdInput, 'canvasId');
    const bound = this.workspaceKey();
    const guard = () => {
      this.assertOpen();
      if (this.workspaceKey() !== bound)
        throw new Error(
          `Azure blob scope ${canvasId} belongs to an inactive Workspace`,
        );
    };
    const root = `${this.prefix}/${encodeURIComponent(bound)}/${canvasId}/`;
    const area = (name: keyof SpaceBlobs) =>
      new AzureBlobScope(
        this.container,
        `${root}${name}/`,
        guard,
        name === 'guide' ? SPACE_GUIDE_BLOB_NAMES : null,
      );
    return Object.freeze({
      artifacts: area('artifacts'),
      guide: area('guide'),
      memory: area('memory'),
      uploads: area('uploads'),
    });
  }
}

class AzureBlobScope implements BlobScope {
  constructor(
    private readonly container: ContainerClient,
    private readonly prefix: string,
    private readonly guard: () => void,
    private readonly members: readonly string[] | null,
  ) {}
  private name(input: string): string {
    this.guard();
    const name = normalizeBlobName(input);
    if (this.members && !this.members.includes(name))
      throw new BlobNameError(`Blob name ${name} is outside this area`);
    return name;
  }
  async put(input: string, body: Buffer | Readable): Promise<BlobInfo> {
    try {
      const name = this.name(input);
      const key = new URL(this.container.url);
      key.search = '';
      const ignoreError = () => {};
      if (!Buffer.isBuffer(body)) body.on('error', ignoreError);
      try {
        return await serializeUpload(
          `${key.href}/${this.prefix}${name}`,
          async () => {
            this.guard();
            const client = this.container.getBlockBlobClient(
              this.prefix + name,
            );
            const uploadId = randomUUID();
            const blocks: string[] = [];
            let size = 0;
            let pending = Buffer.alloc(0);
            const stage = async (data: Buffer) => {
              if (blocks.length >= 50_000)
                throw new Error('Azure block blob exceeds 50000 blocks');
              const id = Buffer.from(
                `${uploadId}-${String(blocks.length).padStart(6, '0')}`,
              ).toString('base64');
              await client.stageBlock(id, data, data.length);
              blocks.push(id);
              size += data.length;
            };
            // A unique block-id family per writer prevents concurrent replaces from
            // mixing bytes. The keyed mutex also prevents a commit from discarding
            // another writer's staged blocks. Only commitBlockList publishes;
            // failed streams leave the old object untouched. Azure expires
            // uncommitted blocks.
            for await (const chunk of Buffer.isBuffer(body) ? [body] : body) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              let offset = 0;
              if (pending.length) {
                const count = Math.min(
                  BLOCK_SIZE - pending.length,
                  bytes.length,
                );
                pending = Buffer.concat([pending, bytes.subarray(0, count)]);
                offset = count;
                if (pending.length === BLOCK_SIZE) {
                  await stage(pending);
                  pending = Buffer.alloc(0);
                }
              }
              while (offset + BLOCK_SIZE <= bytes.length) {
                await stage(bytes.subarray(offset, offset + BLOCK_SIZE));
                offset += BLOCK_SIZE;
              }
              if (offset < bytes.length)
                pending = Buffer.from(bytes.subarray(offset));
            }
            if (pending.length) await stage(pending);
            const committed = await client.commitBlockList(blocks);
            return {
              name,
              size,
              updatedAt: committed.lastModified?.getTime() ?? Date.now(),
            };
          },
        );
      } finally {
        if (!Buffer.isBuffer(body)) body.off('error', ignoreError);
      }
    } catch (error) {
      if (!Buffer.isBuffer(body)) {
        body.on('error', () => {});
        body.destroy();
      }
      throw error;
    }
  }
  async head(input: string): Promise<BlobInfo | null> {
    const name = this.name(input);
    try {
      const properties = await this.container
        .getBlobClient(this.prefix + name)
        .getProperties();
      return {
        name,
        size: properties.contentLength ?? 0,
        updatedAt: properties.lastModified?.getTime() ?? 0,
      };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async open(input: string, range?: BlobRange): Promise<BlobRead | null> {
    const name = this.name(input);
    const start = range?.start ?? 0;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      (range?.end !== undefined &&
        (!Number.isSafeInteger(range.end) || range.end < start))
    )
      throw new RangeError('Invalid blob byte range');
    try {
      // Metadata and bytes come from one response, so a concurrent replacement
      // cannot pair the old object's metadata with the new object's bytes.
      const response = await this.container
        .getBlobClient(this.prefix + name)
        .download(
          start,
          range?.end === undefined ? undefined : range.end - start + 1,
        );
      const size = response.contentRange
        ? Number(response.contentRange.split('/')[1])
        : (response.contentLength ?? 0);
      return {
        info: { name, size, updatedAt: response.lastModified?.getTime() ?? 0 },
        body: (response.readableStreamBody as Readable) ?? Readable.from([]),
      };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async read(input: string): Promise<Buffer | null> {
    const opened = await this.open(input);
    if (!opened) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of opened.body)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  async hasMany(inputs: readonly string[]): Promise<ReadonlySet<string>> {
    this.guard();
    const names = [...new Set(inputs.map(normalizeBlobName))].filter(
      (name) => !this.members || this.members.includes(name),
    );
    const found = new Set<string>();
    for (let offset = 0; offset < names.length; offset += 16) {
      const results = await Promise.all(
        names.slice(offset, offset + 16).map((name) => this.head(name)),
      );
      for (const info of results) if (info) found.add(info.name);
    }
    return found;
  }
  async list(): Promise<BlobInfo[]> {
    this.guard();
    const result: BlobInfo[] = [];
    for await (const blob of this.container.listBlobsFlat({
      prefix: this.prefix,
    })) {
      const name = blob.name.slice(this.prefix.length);
      if (name.includes('/') || (this.members && !this.members.includes(name)))
        continue;
      result.push({
        name,
        size: blob.properties.contentLength ?? 0,
        updatedAt: blob.properties.lastModified?.getTime() ?? 0,
      });
    }
    return result;
  }
  async materialize(input: string): Promise<BlobLease | null> {
    const opened = await this.open(input);
    if (!opened) return null;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(tmpdir(), 'huabu-azure-'));
      const ownedDirectory = directory;
      const filename = path.join(directory, opened.info.name);
      await pipeline(opened.body, createWriteStream(filename, { mode: 0o600 }));
      await chmod(filename, 0o400);
      return createBlobLease(filename, () =>
        rm(ownedDirectory, { recursive: true, force: true }),
      );
    } catch (error) {
      opened.body.destroy();
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async deleteAll(): Promise<void> {
    this.guard();
    // Prefix includes Workspace, Space and area plus a trailing separator.
    // Enumerate uncommitted objects too so deletion also cleans failed uploads.
    for await (const blob of this.container.listBlobsFlat({
      prefix: this.prefix,
      includeUncommitedBlobs: true,
    })) {
      const name = blob.name.slice(this.prefix.length);
      if (name.includes('/') || (this.members && !this.members.includes(name)))
        continue;
      await this.container
        .getBlobClient(blob.name)
        .deleteIfExists({ deleteSnapshots: 'include' });
    }
  }
}
