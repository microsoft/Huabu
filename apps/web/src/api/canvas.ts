import { API_CONFIG } from '../config/api';

import type {
  GetCanvasResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  UpsertNodeRequest,
  UpsertNodeResponse,
  DeleteNodeResponse,
  KnowledgeStorageConfig,
  MigrateStorageResponse,
} from '@sediment/shared';

export async function getCanvas(
  canvasId: string,
): Promise<GetCanvasResponse | null> {
  try {
    const response = await fetch(`${API_CONFIG.API_URL}/canvas/${canvasId}`);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Failed to get canvas: ${response.statusText}`);
    }
    return (await response.json()) as GetCanvasResponse;
  } catch (error) {
    console.error('Failed to get canvas:', error);
    return null;
  }
}

export async function putCanvas(
  canvasId: string,
  request: PutCanvasRequest,
  options?: { keepalive?: boolean },
): Promise<PutCanvasResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/canvas/${canvasId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    keepalive: options?.keepalive ?? false,
  });

  if (!response.ok) {
    if (response.status === 409) {
      const error = (await response.json()) as {
        message: string;
        serverVersion: number;
      };
      throw new Error(
        `Canvas version mismatch. Server version: ${error.serverVersion}`,
      );
    }
    throw new Error(`Failed to save canvas: ${response.statusText}`);
  }

  return (await response.json()) as PutCanvasResponse;
}

export async function upsertNode(
  canvasId: string,
  nodeId: string,
  request: UpsertNodeRequest,
  options?: { keepalive?: boolean },
): Promise<UpsertNodeResponse> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/canvas/${canvasId}/nodes/${nodeId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      keepalive: options?.keepalive ?? false,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to upsert node: ${response.statusText}`);
  }

  return (await response.json()) as UpsertNodeResponse;
}

export async function deleteNode(
  canvasId: string,
  nodeId: string,
): Promise<DeleteNodeResponse> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/canvas/${canvasId}/nodes/${nodeId}`,
    {
      method: 'DELETE',
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to delete node: ${response.statusText}`);
  }

  return (await response.json()) as DeleteNodeResponse;
}

/**
 * Migrate node sources from the current storage backend to a new one.
 * The server copies all content, updates the canvas state, and bumps the version.
 */
export async function migrateStorage(
  canvasId: string,
  to: KnowledgeStorageConfig,
): Promise<MigrateStorageResponse> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/canvas/${canvasId}/migrate-storage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    },
  );

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      error.message ?? `Failed to migrate storage: ${response.statusText}`,
    );
  }

  return (await response.json()) as MigrateStorageResponse;
}
