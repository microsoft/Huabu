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
 * metadata remains authoritative in the Workspace-owned manifest.
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

import type {
  WorkspaceHandle,
  WorkspaceRepository,
} from '../../ports/workspace.js';

export const WORKSPACE_MANIFEST_DIR = '.huabu';
export const WORKSPACE_MANIFEST_FILENAME = 'workspace.json';
export const WORKSPACE_REGISTRY_FILENAME = 'workspaces.json';
const WORKSPACE_MANIFEST_SCHEMA_VERSION = 1;
const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1;

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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function readManifestFile(
  filePath: string,
  allowMissing: boolean,
): WorkspaceManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (allowMissing && isMissing(error)) return null;
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
    if (isMissing(error)) return [];
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

/**
 * Return the persisted Workspace identity, adopting a legacy folder when the
 * manifest is absent. `wx` keeps concurrent adopters from overwriting the
 * winner; every contender then reads the same durable identity.
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
  readonly #byId = new Map<string, WorkspaceHandle>();
  readonly #byPath = new Map<string, WorkspaceHandle>();
  readonly #registryFilePath: string | null;
  readonly #registeredPathById = new Map<string, string>();
  readonly #registeredIdByPath = new Map<string, string>();
  #registryLoaded = false;

  constructor(registryFilePath?: string) {
    this.#registryFilePath = registryFilePath
      ? path.resolve(registryFilePath)
      : null;
  }

  #ensureRegistryLoaded(): void {
    if (this.#registryLoaded) return;
    const entries = this.#registryFilePath
      ? readWorkspaceRegistry(this.#registryFilePath)
      : [];
    this.#replaceRegistrationMaps(entries);
    this.#registryLoaded = true;
  }

  #replaceRegistrationMaps(entries: readonly WorkspaceRegistryEntry[]): void {
    this.#registeredPathById.clear();
    this.#registeredIdByPath.clear();
    for (const entry of entries) {
      this.#registeredPathById.set(entry.workspaceId, entry.workspacePath);
      this.#registeredIdByPath.set(entry.workspacePath, entry.workspaceId);
    }
  }

  #registrationEntries(): WorkspaceRegistryEntry[] {
    return [...this.#registeredPathById].map(
      ([workspaceId, workspacePath]) => ({ workspaceId, workspacePath }),
    );
  }

  #commitRegistrations(entries: readonly WorkspaceRegistryEntry[]): void {
    if (this.#registryFilePath) {
      atomicWriteJson(this.#registryFilePath, {
        schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
        workspaces: entries,
      });
    }
    this.#replaceRegistrationMaps(entries);
  }

  #upsertRegistration(workspaceId: string, workspacePath: string): void {
    let replaced = false;
    const entries = this.#registrationEntries().map((entry) => {
      if (entry.workspaceId !== workspaceId) return entry;
      replaced = true;
      return { workspaceId, workspacePath };
    });
    if (!replaced) entries.push({ workspaceId, workspacePath });
    this.#commitRegistrations(entries);
  }

  #hydrateRegistered(
    workspaceId: string,
    workspacePath: string,
  ): WorkspaceHandle {
    const existing = this.#byId.get(workspaceId);
    if (existing) return existing;

    const manifest = readManifest(manifestPath(workspacePath));
    if (manifest.workspaceId !== workspaceId) {
      throw new Error(
        `Workspace registry maps ${workspaceId} to ${workspacePath}, but that path claims ${manifest.workspaceId}`,
      );
    }
    const existingAtPath = this.#byPath.get(workspacePath);
    if (existingAtPath && existingAtPath.workspaceId !== workspaceId) {
      throw new Error(
        `Workspace path ${workspacePath} is already open as ${existingAtPath.workspaceId}`,
      );
    }

    const handle: WorkspaceHandle = Object.freeze({
      workspaceId,
      workspacePath,
      name: manifest.name,
    });
    this.#byId.set(workspaceId, handle);
    this.#byPath.set(workspacePath, handle);
    return handle;
  }

  open(rawWorkspacePath: string): WorkspaceHandle {
    this.#ensureRegistryLoaded();
    const workspacePath = path.resolve(rawWorkspacePath);
    const manifest = ensureWorkspaceManifestOnDisk(workspacePath);
    const existingAtPath = this.#byPath.get(workspacePath);
    if (existingAtPath) {
      if (existingAtPath.workspaceId !== manifest.workspaceId) {
        throw new Error(
          `Workspace identity at ${workspacePath} changed from ${existingAtPath.workspaceId} to ${manifest.workspaceId}`,
        );
      }
      return existingAtPath;
    }

    const registeredIdAtPath = this.#registeredIdByPath.get(workspacePath);
    if (registeredIdAtPath && registeredIdAtPath !== manifest.workspaceId) {
      throw new Error(
        `Workspace registry maps ${workspacePath} to ${registeredIdAtPath}, but that path claims ${manifest.workspaceId}`,
      );
    }

    const existingWithId = this.#byId.get(manifest.workspaceId);
    const previousPath =
      this.#registeredPathById.get(manifest.workspaceId) ??
      existingWithId?.workspacePath;
    if (previousPath && previousPath !== workspacePath) {
      const previousManifest = readManifestFile(
        manifestPath(previousPath),
        true,
      );
      if (previousManifest?.workspaceId === manifest.workspaceId) {
        throw new Error(
          `Workspace identity ${manifest.workspaceId} is present at both ${previousPath} and ${workspacePath}; copied Workspaces must receive distinct identities`,
        );
      }
      if (previousManifest) {
        throw new Error(
          `Workspace registry maps ${manifest.workspaceId} to ${previousPath}, but that path now claims ${previousManifest.workspaceId}`,
        );
      }
    }

    const handle: WorkspaceHandle = Object.freeze({
      workspaceId: manifest.workspaceId,
      workspacePath,
      name: manifest.name,
    });
    this.#upsertRegistration(handle.workspaceId, handle.workspacePath);
    if (previousPath && previousPath !== workspacePath) {
      this.#byPath.delete(previousPath);
    }
    this.#byId.set(handle.workspaceId, handle);
    this.#byPath.set(handle.workspacePath, handle);
    return handle;
  }

  get(workspaceId: string): WorkspaceHandle | null {
    this.#ensureRegistryLoaded();
    const existing = this.#byId.get(workspaceId);
    if (existing) return existing;
    const workspacePath = this.#registeredPathById.get(workspaceId);
    return workspacePath
      ? this.#hydrateRegistered(workspaceId, workspacePath)
      : null;
  }

  getByPath(rawWorkspacePath: string): WorkspaceHandle | null {
    this.#ensureRegistryLoaded();
    const workspacePath = path.resolve(rawWorkspacePath);
    const existing = this.#byPath.get(workspacePath);
    if (existing) return existing;
    const workspaceId = this.#registeredIdByPath.get(workspacePath);
    return workspaceId
      ? this.#hydrateRegistered(workspaceId, workspacePath)
      : null;
  }

  list(): readonly WorkspaceHandle[] {
    this.#ensureRegistryLoaded();
    return this.#registrationEntries().map((entry) =>
      this.#hydrateRegistered(entry.workspaceId, entry.workspacePath),
    );
  }

  rename(workspaceId: string, rawName: string): WorkspaceHandle | null {
    const current = this.get(workspaceId);
    if (!current) return null;

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

    const updated: WorkspaceHandle = Object.freeze({ ...current, name });
    this.#byId.set(workspaceId, updated);
    this.#byPath.set(current.workspacePath, updated);
    return updated;
  }

  remove(workspaceId: string): boolean {
    this.#ensureRegistryLoaded();
    const workspacePath = this.#registeredPathById.get(workspaceId);
    if (!workspacePath) return false;
    const entries = this.#registrationEntries().filter(
      (entry) => entry.workspaceId !== workspaceId,
    );
    this.#commitRegistrations(entries);
    this.#byId.delete(workspaceId);
    this.#byPath.delete(workspacePath);
    return true;
  }
}
