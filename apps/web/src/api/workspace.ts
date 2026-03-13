import { API_CONFIG } from '../config/api';

export interface WorkspaceInfo {
  path: string;
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
