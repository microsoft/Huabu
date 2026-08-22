// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Workspace API wire types & schemas.
 *
 * The workspace endpoints describe the server's storage mode and let the
 * client (in free mode) point the server at an absolute path. Per
 * docs/architecture/api-design.md: schemas are the single source of truth, types
 * derived via `z.infer`.
 *
 * Errors use the shared {@link ApiErrorBody} envelope with HTTP status
 * codes (4xx / 5xx) — there is no in-body `ok` discriminator on the
 * error path. The only place a `{ ok }` shape appears is `PickFolderResult`,
 * which uses it for *business* outcomes ("cancelled" / "no-picker") that
 * are returned with HTTP 200.
 */

import { z } from 'zod';

export const workspaceModeSchema = z.enum(['free', 'managed']);
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>;

export const workspaceCapabilitiesSchema = z.object({
  /** Whether the user is allowed to change workspace at runtime. */
  canChangeWorkspace: z.boolean(),
  /** Whether the server can show a native folder picker. */
  nativePicker: z.boolean(),
});
export type WorkspaceCapabilities = z.infer<typeof workspaceCapabilitiesSchema>;

export const workspaceInfoSchema = z.object({
  mode: workspaceModeSchema,
  configured: z.boolean(),
  /** Stable Workspace identity, or null before configuration. */
  workspaceId: z.string().uuid().nullable(),
  /** Free-mode active absolute path. Always null in managed mode. */
  path: z.string().nullable(),
  /** Persisted display label (defaults to the active path basename), or null. */
  name: z.string().nullable(),
  /** Stable hidden World canvas identity, or null before configuration. */
  worldCanvasId: z.string().min(1).nullable(),
  capabilities: workspaceCapabilitiesSchema,
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

/** One Workspace exposed by the plural management API. */
export const workspaceDescriptorSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  /** Disk path in free mode; hidden for managed deployments. */
  path: z.string().nullable(),
  active: z.boolean(),
});
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;

/** Body for `POST /api/workspaces`. */
export const workspaceCreateSchema = z.object({
  path: z.string().min(1, 'Workspace path is required'),
  name: z.string().trim().min(1, 'Workspace name is required').optional(),
});
export type WorkspaceCreateRequest = z.infer<typeof workspaceCreateSchema>;

/** Body for `PATCH /api/workspaces/:workspaceId`. */
export const workspaceRenameSchema = z.object({
  name: z.string().trim().min(1, 'Workspace name is required'),
});
export type WorkspaceRenameRequest = z.infer<typeof workspaceRenameSchema>;

/**
 * Result of `POST /api/workspace/pick-folder`.
 *
 * Returns a discriminated result rather than an HTTP error for the two
 * "expected non-success" business outcomes:
 *   - `{ ok: false, reason: 'cancelled' }` — user dismissed the dialog
 *   - `{ ok: false, reason: 'no-picker' }` — server is headless; the
 *     caller should fall back to a text-input UI.
 *
 * Genuine failures (managed mode, non-localhost, etc.) come back as
 * normal HTTP 4xx with an {@link ApiErrorBody}.
 */
export type PickFolderResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' | 'no-picker' };

/** Body for `PUT /api/workspace`. */
export const workspacePathSchema = z.object({
  path: z.string().min(1, 'Workspace path is required'),
});
export type WorkspacePathRequest = z.infer<typeof workspacePathSchema>;

/** Body for `POST /api/workspace/validate-path`. */
export const validatePathSchema = z.object({
  path: z.string().min(1, 'Path is required'),
});
export type ValidatePathRequest = z.infer<typeof validatePathSchema>;

/** Response for `POST /api/workspace/validate-path`. */
export interface ValidatePathResponse {
  path: string;
  exists: boolean;
}
