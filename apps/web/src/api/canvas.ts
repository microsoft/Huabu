import { API_CONFIG } from '../config/api';

import type {
  GetCanvasResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  DeleteNodeResponse,
  ImportCanvasResponse,
  ListCanvasesResponse,
  CreateCanvasRequest,
  CreateCanvasResponse,
  PreprocessNodeResponse,
} from '@sediment/shared';

/**
 * List all canvases in the workspace.
 */
export async function listCanvases(): Promise<ListCanvasesResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/canvas`);
  if (!response.ok) {
    throw new Error(`Failed to list canvases: ${response.statusText}`);
  }
  return (await response.json()) as ListCanvasesResponse;
}

/**
 * Create a new empty canvas.
 */
export async function createCanvas(
  request: CreateCanvasRequest = {},
): Promise<CreateCanvasResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/canvas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`Failed to create canvas: ${response.statusText}`);
  }
  return (await response.json()) as CreateCanvasResponse;
}

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

export async function deleteNode(
  canvasId: string,
  nodeId: string,
  options?: { signal?: AbortSignal },
): Promise<DeleteNodeResponse> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/canvas/${canvasId}/nodes/${nodeId}`,
    {
      method: 'DELETE',
      signal: options?.signal,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to delete node: ${response.statusText}`);
  }

  return (await response.json()) as DeleteNodeResponse;
}

/**
 * Download the canvas as a self-contained `.sediment.json` export bundle.
 *
 * Performs a lightweight existence check via getCanvas to catch errors early,
 * then triggers a native browser download via a temporary `<a>` link
 * so the full response body never needs to live in JS memory.
 *
 * The downloaded filename is determined solely by the server's
 * `Content-Disposition` header.
 */
export async function exportCanvas(canvasId: string): Promise<void> {
  // Lightweight pre-check: verify canvas exists without running the export.
  const canvas = await getCanvas(canvasId);
  if (!canvas) {
    throw new Error('Canvas not found');
  }

  const url = `${API_CONFIG.API_URL}/canvas/${canvasId}/export`;
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Import a canvas from a `.sediment.zip` archive.
 * The server allocates a fresh canvas id, restores artifacts/history,
 * and rewrites embedded artifact URLs to the new id.
 */
export async function importCanvas(file: File): Promise<ImportCanvasResponse> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  const response = await fetch(`${API_CONFIG.API_URL}/canvas/import`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      error.message ?? `Failed to import canvas: ${response.statusText}`,
    );
  }

  return (await response.json()) as ImportCanvasResponse;
}

/**
 * Delete a canvas by ID.
 */
export async function deleteCanvasById(
  canvasId: string,
): Promise<{ success: boolean }> {
  const response = await fetch(`${API_CONFIG.API_URL}/canvas/${canvasId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      error.message ?? `Failed to delete canvas: ${response.statusText}`,
    );
  }

  return (await response.json()) as { success: boolean };
}

/**
 * Unified preprocessing endpoint.
 * Handles all node types through a single route.
 */
export async function preprocessNode(
  canvasId: string,
  nodeId: string,
  body: {
    nodeType: string;
    trigger?: string;
    snapshot: Record<string, unknown>;
    options?: {
      allowLLM?: boolean;
      allowPersistence?: boolean;
      force?: boolean;
    };
  },
  options?: { keepalive?: boolean },
): Promise<PreprocessNodeResponse> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/canvas/${canvasId}/nodes/${nodeId}/preprocess`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: options?.keepalive ?? false,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to preprocess node: ${response.statusText}`);
  }

  return (await response.json()) as PreprocessNodeResponse;
}
