// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Workspace storage port — membership and stable Workspace identity.
 *
 * A Workspace is the namespace that owns Spaces. The repository manages that
 * collection by stable id; a handle carries the identity and the display name
 * and nothing else.
 *
 * Where a Workspace *is* is deliberately absent. A directory path is a
 * materialization fact, not an identity one, and a structured backend that
 * keeps Workspaces in a database has no directory to name. Rather than force
 * such an adapter to manufacture a path it cannot honor, locating a Workspace
 * is a capability the composition root exposes separately, for the profiles
 * that have one — the Workspace-level counterpart to `spaceDirectory()`
 * (docs/proposals/multi-backend-storage.md §12.5.4). Adopting a directory as
 * a Workspace lives there for the same reason.
 *
 * This file may not import a backend implementation or application workspace
 * lifecycle policy.
 */

export interface WorkspaceHandle {
  readonly workspaceId: string;
  readonly name: string;
}

export interface WorkspaceRepository {
  get(workspaceId: string): WorkspaceHandle | null;
  list(): readonly WorkspaceHandle[];
  rename(workspaceId: string, name: string): WorkspaceHandle | null;
  /** Forget one member without deleting any Workspace-owned data. */
  remove(workspaceId: string): boolean;
}
