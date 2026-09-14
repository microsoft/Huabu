// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Where the Disk backend puts state that belongs to no Workspace folder.
 *
 * `layout.ts` answers "where inside a Workspace does a Space go". This file
 * answers the other half: the Disk adapters also keep things in the Server's
 * own data directory — a registry of Workspaces that is *about* folders rather
 * than in one, and Space bytes for a deployment whose records live in a
 * database and therefore has no folder at all.
 *
 * Both are under `<data dir>/storage/disk/`, which names the backend the way
 * `storage/sqlite/` names the other one. Two adapters share that directory, so
 * each gets a subtree of its own and neither may grow into the other's:
 *
 *   storage/disk/
 *     workspaces.json          the *structured* store's membership registry
 *     blobs/<workspaceId>/…    the *blob* store's Space byte roots
 *
 * That separation is not cosmetic. The blob store deletes whole directories —
 * an area on `deleteAll()`, a Space's root when its record goes — and the
 * registry is not its to delete. Keeping the registry out of `blobs/` is what
 * makes "sweep this Space's bytes" unable to reach it, and putting both paths
 * in one file is what keeps that true when either moves.
 *
 * Nothing outside `storage/` may depend on these names (§12.5.2). The SQLite
 * backend answers the same question for itself in `backends/sqlite/database.ts`.
 */

import path from 'node:path';

import { getDataDir } from '../../../../data-dir.js';
import { sanitizeId } from '../../../../utils/fs.js';

/** The Disk backend's own area in the Server data directory. */
export function diskDataDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'storage', 'disk');
}

export const WORKSPACE_REGISTRY_FILENAME = 'workspaces.json';

/** Structured store: the `workspaceId -> workspacePath` discovery index. */
export function workspaceRegistryPath(dataDir: string = getDataDir()): string {
  return path.join(diskDataDir(dataDir), WORKSPACE_REGISTRY_FILENAME);
}

/**
 * Blob store: the root its Space byte directories sit under.
 *
 * Only reached when the structured backend gives a Space no folder of its own;
 * where Disk keeps the records too, a Space's bytes stay inside the Space
 * folder the user can see and this path is never built.
 *
 * `HUABU_BLOB_ROOT` replaces it wholesale, for a deployment that keeps bytes
 * on another volume. It moves the bytes and nothing else — the registry above
 * is the structured store's and stays where it is.
 */
export function diskBlobRoot(dataDir: string = getDataDir()): string {
  const configured = process.env['HUABU_BLOB_ROOT']?.trim();
  return configured ? configured : path.join(diskDataDir(dataDir), 'blobs');
}

/**
 * Blob store: where one Space's areas go, Workspace-scoped.
 *
 * A Space belongs to exactly one Workspace, so its bytes are filed under that
 * Workspace and removed with it. The directory holds bytes and nothing else:
 * it is not a Workspace folder and not a Space tree, which is why none of the
 * Disk-only capabilities become available because it exists.
 */
export function diskSpaceBlobRoot(
  workspaceId: string,
  canvasId: string,
  dataDir: string = getDataDir(),
): string {
  return path.join(
    diskBlobRoot(dataDir),
    sanitizeId(workspaceId, 'workspaceId'),
    sanitizeId(canvasId, 'canvasId'),
  );
}
