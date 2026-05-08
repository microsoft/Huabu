import { API_CONFIG } from '../config/api';

import type {
  ApiErrorBody,
  PickFolderResult,
  WorkspaceInfo,
  WorkspacePathRequest,
} from '@sediment/shared';

// Re-export so call sites can keep importing the wire types from `../api/workspace`.
export type {
  PickFolderResult,
  WorkspaceCapabilities,
  WorkspaceInfo,
  WorkspaceMode,
} from '@sediment/shared';

// ────────────────────────────────────────────────────────────────────
// Wire-format types
//
// Every workspace endpoint replies with a discriminated union keyed by
// `ok`. The HTTP status is redundant with `ok` but still meaningful
// (200 / 400 / 403). `unwrap` accepts either signal so we don't depend
// on both being in sync — server bugs that send `ok: true` with a 4xx
// (or vice versa) still surface as a thrown error.
// ────────────────────────────────────────────────────────────────────

type WorkspaceApiResponse<T> =
  | ({ ok: true } & T)
  | ({ ok: false } & ApiErrorBody);

async function unwrap<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as
    | WorkspaceApiResponse<T>
    | Partial<ApiErrorBody>;

  if (response.ok && (body as WorkspaceApiResponse<T>).ok === true) {
    // Strip the discriminator so callers see a clean payload type.
    const { ok: _ok, ...payload } = body as { ok: true } & T;
    return payload as T;
  }
  const message =
    typeof body === 'object' && body && 'message' in body && body.message
      ? body.message
      : fallback;
  throw new Error(message);
}

/** Fetch current workspace mode/state and server capabilities. */
export async function getWorkspaceInfo(): Promise<WorkspaceInfo> {
  const response = await fetch(`${API_CONFIG.API_URL}/workspace`);
  return unwrap<WorkspaceInfo>(
    response,
    `Failed to get workspace info: ${response.statusText}`,
  );
}

/** (Free mode) Activate an absolute path on the server. */
export async function putWorkspacePath(
  newPath: string,
): Promise<WorkspaceInfo> {
  const body: WorkspacePathRequest = { path: newPath };
  const response = await fetch(`${API_CONFIG.API_URL}/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrap<WorkspaceInfo>(
    response,
    `Failed to update workspace path: ${response.statusText}`,
  );
}

/**
 * (Free mode) Open a native OS folder picker dialog on the server.
 *
 * Returns a discriminated result rather than throwing for the two
 * "expected non-success" cases:
 *   - `{ ok: false, reason: 'cancelled' }` — user dismissed the dialog
 *   - `{ ok: false, reason: 'no-picker' }` — server is headless; the
 *     caller should fall back to a text-input UI.
 *
 * Genuine HTTP errors (non-2xx) are thrown so callers don't have to
 * pattern-match three states.
 */
export async function pickFolder(): Promise<PickFolderResult> {
  const response = await fetch(`${API_CONFIG.API_URL}/workspace/pick-folder`, {
    method: 'POST',
  });
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({}))) as Partial<ApiErrorBody>;
    throw new Error(
      body.message ?? `Failed to open folder picker: ${response.statusText}`,
    );
  }
  return (await response.json()) as PickFolderResult;
}
