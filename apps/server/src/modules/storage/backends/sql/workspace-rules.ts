// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { WorkspaceHandle } from '../../ports/workspace.js';

export const WORKSPACE_COLUMNS =
  'workspace_id, name, created_at, last_opened_at';

export function decodeWorkspaceRow(value: unknown): WorkspaceHandle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('Malformed persisted SQLite Workspace row');
  }
  const row = value as Record<string, unknown>;
  const workspaceId = row['workspace_id'];
  const name = row['name'];
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new SyntaxError('Invalid workspace_id in persisted SQLite Workspace');
  }
  if (typeof name !== 'string') {
    throw new SyntaxError('Invalid name in persisted SQLite Workspace');
  }
  return { workspaceId, name };
}

export function requireName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new TypeError('Workspace name must be a string');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new TypeError('Workspace name must not be empty');
  }
  return trimmed;
}
