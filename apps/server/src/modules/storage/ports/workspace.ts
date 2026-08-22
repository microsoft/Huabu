// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Workspace storage port — membership and stable Workspace identity.
 *
 * A Workspace is the namespace that owns Spaces. The repository manages that
 * collection; a handle identifies one member and, for the currently implemented
 * Disk profile, carries its materialized path. A non-directory structured
 * adapter must extend this locator contract when it is implemented rather than
 * manufacture a fake filesystem path.
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
  rename(workspaceId: string, name: string): WorkspaceHandle | null;
  /** Forget one handle without deleting any Workspace-owned data. */
  remove(workspaceId: string): boolean;
}
