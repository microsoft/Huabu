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

export type WorkspaceMode = 'free' | 'managed';

export interface WorkspaceCapabilities {
  /** Whether the user is allowed to change workspace at runtime. */
  canChangeWorkspace: boolean;
  /** Whether the server can show a native folder picker. */
  nativePicker: boolean;
}

export interface WorkspaceInfo {
  mode: WorkspaceMode;
  configured: boolean;
  /** Free-mode active absolute path. Always null in managed mode. */
  path: string | null;
  /** Display label (basename of the active path), or null. */
  name: string | null;
  capabilities: WorkspaceCapabilities;
}

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
