// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Workspace storage port — membership and stable Workspace identity.
 *
 * A Workspace is the namespace that owns Spaces. The repository manages that
 * collection; a handle identifies one member and carries the materialized path
 * used by the Disk adapter. A database adapter can retain the same identity and
 * repository shape while replacing the path with its own materialization
 * capability when that backend is implemented.
 *
 * This file may not import a backend implementation or application workspace
 * lifecycle policy.
 */

export interface WorkspaceHandle {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly name: string;
}

export interface WorkspaceRepository {
  open(workspacePath: string): WorkspaceHandle;
  get(workspaceId: string): WorkspaceHandle | null;
  getByPath(workspacePath: string): WorkspaceHandle | null;
  list(): readonly WorkspaceHandle[];
}
