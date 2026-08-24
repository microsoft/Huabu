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
 * that have one — the Workspace-level counterpart to the Space handle's
 * `diskTree` member (docs/proposals/multi-backend-storage.md §6.4.1).
 * Adopting a directory as
 * a Workspace lives there for the same reason.
 *
 * This file may not import a backend implementation or application workspace
 * lifecycle policy.
 *
 * Every operation is async so a connection-backed adapter can serve all
 * Workspace namespaces through one already-open connection or pool. Selecting
 * the active Workspace is lifecycle policy above this port, not a reason to
 * reconnect the repository.
 */

export interface WorkspaceHandle {
  readonly workspaceId: string;
  readonly name: string;
}

export interface WorkspaceRepository {
  get(workspaceId: string): Promise<WorkspaceHandle | null>;
  list(): Promise<readonly WorkspaceHandle[]>;
  rename(workspaceId: string, name: string): Promise<WorkspaceHandle | null>;
  /** Forget one member without deleting any Workspace-owned data. */
  remove(workspaceId: string): Promise<boolean>;
}
