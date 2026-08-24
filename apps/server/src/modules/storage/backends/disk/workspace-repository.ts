// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of the Workspace storage port.
 *
 * A Workspace owns one stable id and display name in
 * `<workspace>/.huabu/workspace.json`. Existing Home folders predate that
 * manifest, so opening one adopts it by creating the file once.
 *
 * The Server data directory holds a separate discovery index containing only
 * `workspaceId -> workspacePath`. That deliberate duplication is the minimum
 * needed to recognize an externally moved Workspace after restart; all other
 * metadata remains authoritative in the Workspace-owned manifest and is read
 * back from it on demand rather than cached here.
 *
 * The index is therefore the single in-process representation of membership,
 * and it is re-read from disk on every access. Reads cost a few small JSON
 * files for a collection that holds a handful of entries, and in exchange a
 * registry edited by another process — or by hand — can never be silently
 * truncated by a stale in-memory copy.
 */

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  type WriteFileOptions,
} from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { atomicWriteJson } from '../../../../utils/fs.js';
import { getLogger } from '../../../../utils/logger.js';

import type {
  WorkspaceHandle,
  WorkspaceRepository,
} from '../../ports/workspace.js';

export const WORKSPACE_MANIFEST_DIR = '.huabu';
export const WORKSPACE_MANIFEST_FILENAME = 'workspace.json';
export const WORKSPACE_REGISTRY_FILENAME = 'workspaces.json';
const WORKSPACE_MANIFEST_SCHEMA_VERSION = 1;
const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1;

const log = getLogger('workspace-repository');

const workspaceManifestSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_MANIFEST_SCHEMA_VERSION),
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1),
});

const workspaceRegistrySchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_REGISTRY_SCHEMA_VERSION),
    workspaces: z.array(
      z
        .object({
          workspaceId: z.string().uuid(),
          workspacePath: z
            .string()
            .min(1)
            .refine((value) => path.isAbsolute(value), {
              message: 'Workspace registry paths must be absolute',
            }),
        })
        .strict(),
    ),
  })
  .strict();

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
type WorkspaceRegistryEntry = z.infer<
  typeof workspaceRegistrySchema
>['workspaces'][number];

/** Where the Disk backend keeps its discovery index inside the data dir. */
export function workspaceRegistryPath(dataDir: string): string {
  return path.join(dataDir, 'storage', 'disk', WORKSPACE_REGISTRY_FILENAME);
}

function manifestPath(workspacePath: string): string {
  return path.join(
    workspacePath,
    WORKSPACE_MANIFEST_DIR,
    WORKSPACE_MANIFEST_FILENAME,
  );
}

function defaultWorkspaceName(workspacePath: string): string {
  return path.basename(workspacePath) || 'Workspace';
}

/**
 * Whether an error means "this path does not resolve right now".
 *
 * A deleted folder and an unmounted volume both land here, and both describe
 * a Workspace that is temporarily unreachable rather than a corrupt one. A
 * malformed manifest is deliberately *not* in this set: that is damage the
 * operator has to see, so it keeps throwing.
 */
function isUnreachable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readManifestFile(
  filePath: string,
  allowUnreachable: boolean,
): WorkspaceManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (allowUnreachable && isUnreachable(error)) return null;
    throw new Error(
      `Workspace manifest at ${filePath} could not be read: ${(error as Error).message}`,
    );
  }

  const result = workspaceManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Workspace manifest at ${filePath} is invalid: ${result.error.issues[0]?.message ?? 'invalid manifest'}`,
    );
  }
  return result.data;
}

function readManifest(filePath: string): WorkspaceManifest {
  return readManifestFile(filePath, false) as WorkspaceManifest;
}

function readWorkspaceRegistry(filePath: string): WorkspaceRegistryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isUnreachable(error)) return [];
    throw new Error(
      `Workspace registry at ${filePath} could not be read: ${(error as Error).message}`,
    );
  }

  const result = workspaceRegistrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Workspace registry at ${filePath} is invalid: ${result.error.issues[0]?.message ?? 'invalid registry'}`,
    );
  }

  const entries = result.data.workspaces.map((entry) => ({
    workspaceId: entry.workspaceId,
    workspacePath: path.resolve(entry.workspacePath),
  }));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.workspaceId)) {
      throw new Error(
        `Workspace registry at ${filePath} contains duplicate id ${entry.workspaceId}`,
      );
    }
    if (paths.has(entry.workspacePath)) {
      throw new Error(
        `Workspace registry at ${filePath} contains duplicate path ${entry.workspacePath}`,
      );
    }
    ids.add(entry.workspaceId);
    paths.add(entry.workspacePath);
  }
  return entries;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST';
}

function sameEntries(
  left: readonly WorkspaceRegistryEntry[],
  right: readonly WorkspaceRegistryEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.workspaceId === right[index]?.workspaceId &&
        entry.workspacePath === right[index]?.workspacePath,
    )
  );
}

function toHandle(
  manifest: WorkspaceManifest,
  workspacePath: string,
): WorkspaceHandle {
  return Object.freeze({
    workspaceId: manifest.workspaceId,
    workspacePath,
    name: manifest.name,
  });
}

/**
 * Return the persisted Workspace identity, adopting a legacy folder when the
 * manifest is absent. `wx` keeps concurrent adopters from overwriting the
 * winner; every contender then reads the same durable identity.
 *
 * Deliberately separate from the repository: workspace preparation runs this
 * inside the isolated child process, where creating the manifest is part of
 * the blocking filesystem work being contained, while registry membership
 * stays a Server-process decision with exactly one writer.
 */
export function ensureWorkspaceManifestOnDisk(
  rawWorkspacePath: string,
): WorkspaceManifest {
  const workspacePath = path.resolve(rawWorkspacePath);
  const metadataDir = path.join(workspacePath, WORKSPACE_MANIFEST_DIR);
  const filePath = manifestPath(workspacePath);
  mkdirSync(metadataDir, { recursive: true });

  const manifest: WorkspaceManifest = {
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    workspaceId: randomUUID(),
    name: defaultWorkspaceName(workspacePath),
  };
  const options: WriteFileOptions = { encoding: 'utf8', flag: 'wx' };
  try {
    writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, options);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  return readManifest(filePath);
}

export class DiskWorkspaceRepository implements WorkspaceRepository {
  readonly #registryFilePath: string | null;
  /**
   * Membership for a repository with no durable file behind it — the shape
   * tests and scripts build. When a registry path is configured this stays
   * unused and the file is the only copy.
   */
  #memory: WorkspaceRegistryEntry[] = [];

  constructor(registryFilePath?: string) {
    this.#registryFilePath = registryFilePath
      ? path.resolve(registryFilePath)
      : null;
  }

  #read(): WorkspaceRegistryEntry[] {
    return this.#registryFilePath
      ? readWorkspaceRegistry(this.#registryFilePath)
      : [...this.#memory];
  }

  #write(entries: readonly WorkspaceRegistryEntry[]): void {
    if (this.#registryFilePath) {
      atomicWriteJson(this.#registryFilePath, {
        schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
        workspaces: entries,
      });
      return;
    }
    this.#memory = [...entries];
  }

  /**
   * Read one member's live metadata, or null when it cannot answer for
   * itself.
   *
   * Two registrations are stale rather than fatal: a Workspace whose folder
   * is gone or unmounted, and a path that some other Workspace has since
   * taken over. Both resolve to "not a member right now" so one unplugged
   * drive cannot take down the whole collection; `open()` repairs the index
   * when the path is opened again.
   */
  #hydrate(entry: WorkspaceRegistryEntry): WorkspaceHandle | null {
    const manifest = readManifestFile(manifestPath(entry.workspacePath), true);
    if (!manifest) {
      log.warn(
        { workspaceId: entry.workspaceId, workspacePath: entry.workspacePath },
        'Registered Workspace is not reachable; skipping',
      );
      return null;
    }
    if (manifest.workspaceId !== entry.workspaceId) {
      log.warn(
        {
          workspaceId: entry.workspaceId,
          workspacePath: entry.workspacePath,
          claimedBy: manifest.workspaceId,
        },
        'Registered Workspace path now belongs to a different Workspace; skipping',
      );
      return null;
    }
    return toHandle(manifest, entry.workspacePath);
  }

  open(rawWorkspacePath: string): WorkspaceHandle {
    const workspacePath = path.resolve(rawWorkspacePath);
    const manifest = ensureWorkspaceManifestOnDisk(workspacePath);
    const entries = this.#read();

    // The same identity registered at another path is either a Workspace that
    // moved — the old path no longer answers to it — or a copy, which must be
    // refused so two live directories cannot share one identity.
    const elsewhere = entries.find(
      (entry) =>
        entry.workspaceId === manifest.workspaceId &&
        entry.workspacePath !== workspacePath,
    );
    if (elsewhere) {
      const previous = readManifestFile(
        manifestPath(elsewhere.workspacePath),
        true,
      );
      if (previous?.workspaceId === manifest.workspaceId) {
        throw new Error(
          `Workspace identity ${manifest.workspaceId} is present at both ${elsewhere.workspacePath} and ${workspacePath}; copied Workspaces must receive distinct identities`,
        );
      }
    }

    // Drop any registration that named this path for a different Workspace:
    // the directory was replaced, so the manifest now on disk is the truth.
    const surviving = entries.filter(
      (entry) =>
        entry.workspaceId === manifest.workspaceId ||
        entry.workspacePath !== workspacePath,
    );
    const replacement: WorkspaceRegistryEntry = {
      workspaceId: manifest.workspaceId,
      workspacePath,
    };
    let replaced = false;
    const next = surviving.map((entry) => {
      if (entry.workspaceId !== manifest.workspaceId) return entry;
      replaced = true;
      return replacement;
    });
    if (!replaced) next.push(replacement);

    if (!sameEntries(entries, next)) this.#write(next);
    return toHandle(manifest, workspacePath);
  }

  get(workspaceId: string): WorkspaceHandle | null {
    const entry = this.#read().find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    return entry ? this.#hydrate(entry) : null;
  }

  getByPath(rawWorkspacePath: string): WorkspaceHandle | null {
    const workspacePath = path.resolve(rawWorkspacePath);
    const entry = this.#read().find(
      (candidate) => candidate.workspacePath === workspacePath,
    );
    return entry ? this.#hydrate(entry) : null;
  }

  list(): readonly WorkspaceHandle[] {
    const handles: WorkspaceHandle[] = [];
    for (const entry of this.#read()) {
      const handle = this.#hydrate(entry);
      if (handle) handles.push(handle);
    }
    return handles;
  }

  rename(workspaceId: string, rawName: string): WorkspaceHandle | null {
    const current = this.get(workspaceId);
    if (!current) return null;

    // Guards the manifest's own schema, not the route body: a repository
    // caller that trims to nothing would otherwise write a file that fails
    // validation on the next read.
    const name = rawName.trim();
    if (!name) throw new Error('Workspace name is required');

    const filePath = manifestPath(current.workspacePath);
    const manifest = readManifest(filePath);
    if (manifest.workspaceId !== workspaceId) {
      throw new Error(
        `Workspace identity at ${current.workspacePath} changed from ${workspaceId} to ${manifest.workspaceId}`,
      );
    }
    atomicWriteJson(filePath, { ...manifest, name });
    return toHandle({ ...manifest, name }, current.workspacePath);
  }

  remove(workspaceId: string): boolean {
    const entries = this.#read();
    const next = entries.filter((entry) => entry.workspaceId !== workspaceId);
    if (next.length === entries.length) return false;
    this.#write(next);
    return true;
  }
}
