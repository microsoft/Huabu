// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of the Workspace storage port.
 *
 * A Workspace owns one stable id in `<workspace>/.huabu/workspace.json`.
 * Existing Home folders predate that manifest, so opening one adopts it by
 * creating the file once. The repository then indexes immutable handles by
 * both id and canonical path; it never treats a copied manifest as two
 * Workspaces with the same identity.
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

import type {
  WorkspaceHandle,
  WorkspaceRepository,
} from '../../ports/workspace.js';

export const WORKSPACE_MANIFEST_DIR = '.huabu';
export const WORKSPACE_MANIFEST_FILENAME = 'workspace.json';
const WORKSPACE_MANIFEST_SCHEMA_VERSION = 1;

const workspaceManifestSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_MANIFEST_SCHEMA_VERSION),
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1),
});

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

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

function readManifest(filePath: string): WorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
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

  open(rawWorkspacePath: string): WorkspaceHandle {
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

    const existingWithId = this.#byId.get(manifest.workspaceId);
    if (existingWithId && existingWithId.workspacePath !== workspacePath) {
      throw new Error(
        `The same Workspace identity ${manifest.workspaceId} was opened from different paths: ${existingWithId.workspacePath} and ${workspacePath}`,
      );
    }

    const handle: WorkspaceHandle = Object.freeze({
      workspaceId: manifest.workspaceId,
      workspacePath,
      name: manifest.name,
    });
    this.#byId.set(handle.workspaceId, handle);
    this.#byPath.set(handle.workspacePath, handle);
    return handle;
  }

  get(workspaceId: string): WorkspaceHandle | null {
    return this.#byId.get(workspaceId) ?? null;
  }

  getByPath(rawWorkspacePath: string): WorkspaceHandle | null {
    return this.#byPath.get(path.resolve(rawWorkspacePath)) ?? null;
  }

  list(): readonly WorkspaceHandle[] {
    return [...this.#byId.values()];
  }
}
