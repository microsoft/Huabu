// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of the Workspace storage port.
 *
 * A Workspace owns one stable id and display name in
 * `<workspace>/.workspace.json`. It sits at the Home folder root — hidden, the
 * way the Workspace's other Huabu-owned state such as `.world/` is, so the
 * user's own Spaces and `setting/` stay the visible contents. Existing Home
 * folders predate the manifest, so adopting one creates the file once.
 *
 * The Server data directory holds a separate discovery index containing
 * `workspaceId -> workspacePath` plus the last time that Workspace was opened.
 * Array order has no meaning: listings sort by the explicit timestamp, and
 * adopting/activating a Workspace updates its timestamp in place. That
 * deliberate duplication is the minimum needed to recognize an externally
 * moved Workspace after restart and preserve recency; all other metadata
 * remains authoritative in the Workspace-owned manifest and is read back from
 * it on demand rather than cached here.
 *
 * The index is therefore the single in-process representation of membership,
 * and it is re-read from disk on every access. Reads cost a few small JSON
 * files for a collection that holds a handful of entries, and in exchange a
 * registry edited by another process — or by hand — can never be silently
 * truncated by a stale in-memory copy.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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

export const WORKSPACE_MANIFEST_FILENAME = '.workspace.json';
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
          lastOpenedAt: z.iso.datetime(),
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
  return path.join(workspacePath, WORKSPACE_MANIFEST_FILENAME);
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

/**
 * Write a manifest through the same schema that reads it.
 *
 * The schema is the only definition of what a valid manifest is — `name` is
 * trimmed and must be non-empty — so validating on the way out means a caller
 * cannot leave behind a file that fails validation on the way back in, and
 * there is no second copy of the rule to drift.
 */
function writeManifest(
  filePath: string,
  manifest: WorkspaceManifest,
): WorkspaceManifest {
  const result = workspaceManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new Error(
      `Workspace manifest for ${filePath} is invalid: ${result.error.issues[0]?.message ?? 'invalid manifest'}`,
    );
  }
  atomicWriteJson(filePath, result.data);
  return result.data;
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
    lastOpenedAt: entry.lastOpenedAt,
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

/** Produce a strictly newer timestamp even for opens in the same millisecond. */
function nextLastOpenedAt(entries: readonly WorkspaceRegistryEntry[]): string {
  const latest = entries.reduce(
    (maximum, entry) => Math.max(maximum, Date.parse(entry.lastOpenedAt)),
    Number.NEGATIVE_INFINITY,
  );
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

function compareMostRecentlyOpened(
  left: WorkspaceRegistryEntry,
  right: WorkspaceRegistryEntry,
): number {
  const timestampDifference =
    Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt);
  return (
    timestampDifference || left.workspaceId.localeCompare(right.workspaceId)
  );
}

/** Compare two existing directory spellings without conflating real copies. */
function samePhysicalDirectory(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch (error) {
    if (isUnreachable(error)) return false;
    throw error;
  }
}

function toHandle(manifest: WorkspaceManifest): WorkspaceHandle {
  return Object.freeze({
    workspaceId: manifest.workspaceId,
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
  const filePath = manifestPath(workspacePath);
  mkdirSync(workspacePath, { recursive: true });

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

/**
 * The identity a directory already claims, without adopting or writing it.
 *
 * Adoption assigns an identity when a folder has none, which makes it the
 * wrong question to ask when a caller has to *choose between* directories —
 * two remembered paths that turn out to be one copied Workspace, say, where
 * registering the second is refused and the choice has to be made first.
 * Unreachable and manifest-less directories both read as "claims nothing",
 * because both are cases where adoption would mint a fresh identity. A
 * malformed manifest still throws, as everywhere else.
 */
export function workspaceIdentityOnDisk(
  rawWorkspacePath: string,
): WorkspaceHandle | null {
  const manifest = readManifestFile(
    manifestPath(path.resolve(rawWorkspacePath)),
    true,
  );
  return manifest ? toHandle(manifest) : null;
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

  /** Whether this durable repository has been initialized on disk. */
  hasDurableRegistry(): boolean {
    return (
      this.#registryFilePath === null || existsSync(this.#registryFilePath)
    );
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
   * drive cannot take down the whole collection; `adopt()` repairs the index
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
    return toHandle(manifest);
  }

  #entryFor(workspaceId: string): WorkspaceRegistryEntry | undefined {
    return this.#read().find((entry) => entry.workspaceId === workspaceId);
  }

  // ─── Portable membership (WorkspaceRepository) ──────────────────────────

  async get(workspaceId: string): Promise<WorkspaceHandle | null> {
    const entry = this.#entryFor(workspaceId);
    return entry ? this.#hydrate(entry) : null;
  }

  async list(): Promise<readonly WorkspaceHandle[]> {
    const handles: WorkspaceHandle[] = [];
    for (const entry of this.#read().sort(compareMostRecentlyOpened)) {
      const handle = this.#hydrate(entry);
      if (handle) handles.push(handle);
    }
    return handles;
  }

  async rename(
    workspaceId: string,
    name: string,
  ): Promise<WorkspaceHandle | null> {
    const entry = this.#entryFor(workspaceId);
    if (!entry || !this.#hydrate(entry)) return null;

    const filePath = manifestPath(entry.workspacePath);
    const manifest = readManifest(filePath);
    if (manifest.workspaceId !== workspaceId) {
      throw new Error(
        `Workspace identity at ${entry.workspacePath} changed from ${workspaceId} to ${manifest.workspaceId}`,
      );
    }
    // The schema owns what a valid name is, on write as well as on read, so
    // an unusable one is refused here rather than persisted and rejected on
    // the next read.
    return toHandle(writeManifest(filePath, { ...manifest, name }));
  }

  async remove(workspaceId: string): Promise<boolean> {
    const entries = this.#read();
    const next = entries.filter((entry) => entry.workspaceId !== workspaceId);
    if (next.length === entries.length) return false;
    this.#write(next);
    return true;
  }

  // ─── Disk locator surface ───────────────────────────────────────────────
  //
  // Not part of the port: these answer *where* a Workspace is and how a real
  // directory becomes one. Composition re-exposes them as the Workspace-level
  // materialization capability, so application code never names this backend.

  /** The directory backing a registered Workspace, or null if it is not one. */
  directoryOf(workspaceId: string): string | null {
    return this.#entryFor(workspaceId)?.workspacePath ?? null;
  }

  /** The registered Workspace materialized at a directory, if there is one. */
  at(rawWorkspacePath: string): WorkspaceHandle | null {
    const workspacePath = path.resolve(rawWorkspacePath);
    const entry = this.#read().find(
      (candidate) => candidate.workspacePath === workspacePath,
    );
    return entry ? this.#hydrate(entry) : null;
  }

  /**
   * Adopt a directory as a Workspace and record its membership.
   *
   * This is the one place the index is repaired against what is actually on
   * disk, because it is the one place a caller names a directory.
   */
  adopt(rawWorkspacePath: string): WorkspaceHandle {
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
      if (
        previous?.workspaceId === manifest.workspaceId &&
        !samePhysicalDirectory(elsewhere.workspacePath, workspacePath)
      ) {
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
      lastOpenedAt: nextLastOpenedAt(entries),
    };
    // Array order is deliberately stable and carries no recency semantics.
    // Existing members update in place; newly discovered members append.
    const existingIndex = surviving.findIndex(
      (entry) => entry.workspaceId === manifest.workspaceId,
    );
    const next = [...surviving];
    if (existingIndex === -1) next.push(replacement);
    else next[existingIndex] = replacement;

    this.#write(next);
    return toHandle(manifest);
  }
}
