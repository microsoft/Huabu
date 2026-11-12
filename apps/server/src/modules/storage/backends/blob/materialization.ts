// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { resolveDirectChildPath } from '../../../../utils/fs.js';
import { createBlobLease } from '../../ports/blob.js';

import type { BlobLease, BlobRead } from '../../ports/blob.js';

/** Path-only consumers receive a disposable copy, never a writable authoritative path. */
export async function materializeBlobCopy(
  opened: BlobRead | null,
): Promise<BlobLease | null> {
  if (!opened) return null;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'huabu-blob-'));
    const ownedDirectory = directory;
    const filename = resolveDirectChildPath(directory, opened.info.name);
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
