import { API_CONFIG } from '../config/api';

export interface WorkspaceInfo {
  path: string | null;
  configured: boolean;
}

export interface PickFolderResult {
  cancelled: boolean;
  path: string | null;
}

/** Fetch the current server workspace path. */
export async function getWorkspacePath(): Promise<WorkspaceInfo> {
  const response = await fetch(`${API_CONFIG.API_URL}/workspace`);
  if (!response.ok) {
    throw new Error(`Failed to get workspace path: ${response.statusText}`);
  }
  return (await response.json()) as WorkspaceInfo;
}

/** Update the server workspace path. */
export async function putWorkspacePath(
  newPath: string,
): Promise<WorkspaceInfo> {
  const response = await fetch(`${API_CONFIG.API_URL}/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: newPath }),
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      err.message ?? `Failed to update workspace path: ${response.statusText}`,
    );
  }
  return (await response.json()) as WorkspaceInfo;
}

/**
 * Open a native OS folder picker dialog on the server.
 * Returns the selected path or `{ cancelled: true }` if the user dismissed.
 */
export async function pickFolder(): Promise<PickFolderResult> {
  const response = await fetch(`${API_CONFIG.API_URL}/workspace/pick-folder`, {
    method: 'POST',
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      err.message ?? `Failed to open folder picker: ${response.statusText}`,
    );
  }
  return (await response.json()) as PickFolderResult;
}
