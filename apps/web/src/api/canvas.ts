import { ApiError, apiFetch, apiUrl } from './_client';
import { routes } from './_routes';

import type {
  ApiErrorBody,
  DeleteCanvasResponse,
  GetCanvasResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  DeleteNodeResponse,
  ImportCanvasResponse,
  ListCanvasesResponse,
  CreateCanvasRequest,
  CreateCanvasResponse,
  PreprocessNodeRequest,
  PreprocessNodeResponse,
} from '@sediment/shared';

/**
 * List all canvases in the workspace.
 */
export async function listCanvases(): Promise<ListCanvasesResponse> {
  return apiFetch<ListCanvasesResponse>(routes.canvasList, {
    fallbackMessage: 'Failed to list canvases',
  });
}

/**
 * Create a new empty canvas.
 */
export async function createCanvas(
  request: CreateCanvasRequest = {},
): Promise<CreateCanvasResponse> {
  return apiFetch<CreateCanvasResponse>(routes.canvasList, {
    method: 'POST',
    json: request,
    fallbackMessage: 'Failed to create canvas',
  });
}

export async function getCanvas(
  canvasId: string,
): Promise<GetCanvasResponse | null> {
  try {
    return await apiFetch<GetCanvasResponse>(routes.canvas(canvasId), {
      fallbackMessage: 'Failed to get canvas',
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    console.error('Failed to get canvas:', error);
    return null;
  }
}

export async function putCanvas(
  canvasId: string,
  request: PutCanvasRequest,
  options?: { keepalive?: boolean },
): Promise<PutCanvasResponse> {
  try {
    return await apiFetch<PutCanvasResponse>(routes.canvas(canvasId), {
      method: 'PUT',
      json: request,
      keepalive: options?.keepalive ?? false,
      fallbackMessage: 'Failed to save canvas',
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const details = error.details as { serverVersion?: number } | undefined;
      throw new Error(
        `Canvas version mismatch. Server version: ${details?.serverVersion ?? 'unknown'}`,
      );
    }
    throw error;
  }
}

export async function deleteNode(
  canvasId: string,
  nodeId: string,
  options?: { signal?: AbortSignal },
): Promise<DeleteNodeResponse> {
  return apiFetch<DeleteNodeResponse>(routes.canvasNode(canvasId, nodeId), {
    method: 'DELETE',
    signal: options?.signal,
    fallbackMessage: 'Failed to delete node',
  });
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

  const url = apiUrl(routes.canvasExport(canvasId));
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

  return apiFetch<ImportCanvasResponse>(routes.canvasImport, {
    method: 'POST',
    formData,
    fallbackMessage: 'Failed to import canvas',
  });
}

/**
 * Delete a canvas by ID.
 */
export async function deleteCanvasById(
  canvasId: string,
): Promise<DeleteCanvasResponse> {
  return apiFetch<DeleteCanvasResponse>(routes.canvas(canvasId), {
    method: 'DELETE',
    fallbackMessage: 'Failed to delete canvas',
  });
}

/**
 * Unified preprocessing endpoint.
 * Handles all node types through a single route.
 *
 * Note: `nodeType` is intentionally typed as `string` here (rather than
 * `CanvasNodeType`) to match call sites that read `node.type ?? ''`.
 * The server validates the wire shape via zod.
 */
export async function preprocessNode(
  canvasId: string,
  nodeId: string,
  body: {
    nodeType: string;
    trigger?: PreprocessNodeRequest['trigger'];
    snapshot: PreprocessNodeRequest['snapshot'];
    options?: PreprocessNodeRequest['options'];
  },
  options?: { keepalive?: boolean },
): Promise<PreprocessNodeResponse> {
  return apiFetch<PreprocessNodeResponse>(
    routes.canvasNodePreprocess(canvasId, nodeId),
    {
      method: 'POST',
      json: body,
      keepalive: options?.keepalive ?? false,
      fallbackMessage: 'Failed to preprocess node',
    },
  );
}

// Re-export `ApiError` so call sites can `instanceof`-check thrown errors
// from the canvas helpers without importing the internal `_client` module.
export { ApiError };
export type { ApiErrorBody };
