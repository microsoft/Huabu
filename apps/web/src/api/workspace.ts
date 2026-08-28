// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';
import { getElectronBridge } from '../hooks/useElectron';

import type {
  PickFolderResult,
  WorkspaceDescriptor,
  WorkspaceInfo,
  WorkspacePathRequest,
} from '@huabu/shared';

// Re-export so call sites can keep importing the wire types from `../api/workspace`.
export type {
  PickFolderResult,
  WorkspaceCapabilities,
  WorkspaceDescriptor,
  WorkspaceInfo,
  WorkspaceMode,
} from '@huabu/shared';

// ────────────────────────────────────────────────────────────────────
// Wire format
//
// Workspace endpoints follow the same convention as the rest of the
// API: success bodies are returned as plain payloads, errors come back
// as HTTP 4xx with the shared `ApiErrorBody` envelope. `apiFetch`
// transparently throws an `ApiError` for non-2xx responses.
//
// `pickFolder` is the one exception: its `{ ok }` discriminator carries
// *business* outcomes ("cancelled" / "no-picker") that are returned with
// HTTP 200, so callers must branch on `result.ok` themselves.
// ────────────────────────────────────────────────────────────────────

/** Fetch current workspace mode/state and server capabilities. */
export async function getWorkspaceInfo(): Promise<WorkspaceInfo> {
  return apiFetch<WorkspaceInfo>(routes.workspace, {
    fallbackMessage: 'Failed to get Home info',
  });
}

/** (Free mode) Activate an absolute path on the server. */
export async function putWorkspacePath(
  newPath: string,
): Promise<WorkspaceInfo> {
  const body: WorkspacePathRequest = { path: newPath };
  return apiFetch<WorkspaceInfo>(routes.workspace, {
    method: 'PUT',
    json: body,
    fallbackMessage: 'Failed to update Home path',
  });
}

/** List registered Workspaces in durable most-recently-used order. */
export async function listWorkspaces(): Promise<WorkspaceDescriptor[]> {
  return apiFetch<WorkspaceDescriptor[]>(routes.workspaces, {
    fallbackMessage: 'Failed to list Home folders',
  });
}

/** Activate a registered Workspace by stable identity. */
export async function activateWorkspace(
  workspaceId: string,
): Promise<WorkspaceDescriptor> {
  return apiFetch<WorkspaceDescriptor>(routes.workspaceActivate(workspaceId), {
    method: 'POST',
    fallbackMessage: 'Failed to activate Home folder',
  });
}

/** Unregister a Workspace without deleting its directory or contents. */
export async function removeWorkspace(workspaceId: string): Promise<void> {
  await apiFetch<void>(routes.workspaceById(workspaceId), {
    method: 'DELETE',
    fallbackMessage: 'Failed to remove Home folder',
  });
}

/**
 * (Free mode) Open a native OS folder picker dialog.
 *
 * In the Electron desktop shell this is routed through the main
 * process's `dialog.showOpenDialog({ properties: ['openDirectory'] })`,
 * which uses the modern IFileOpenDialog on Windows and NSOpenPanel on
 * macOS — the Explorer-style picker with a sidebar, breadcrumb path
 * bar and "New folder" button. In a plain browser we fall back to the
 * server route, which spawns a native picker on the host (with
 * `'no-picker'` reported when the server is headless).
 *
 * Returns a discriminated result rather than throwing for the two
 * "expected non-success" cases:
 *   - `{ ok: false, reason: 'cancelled' }` — user dismissed the dialog
 *   - `{ ok: false, reason: 'no-picker' }` — server is headless; the
 *     caller should fall back to a text-input UI. Never happens in
 *     Electron mode.
 *
 * Genuine HTTP errors (managed mode, non-localhost, etc.) are thrown
 * by `apiFetch` so callers don't have to pattern-match three states.
 */
export async function pickFolder(): Promise<PickFolderResult> {
  const bridge = getElectronBridge();
  if (bridge?.dialog) {
    return bridge.dialog.pickFolder();
  }
  return apiFetch<PickFolderResult>(routes.workspacePickFolder, {
    method: 'POST',
    fallbackMessage: 'Failed to open folder picker',
  });
}
