// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ApiError, apiFetch, apiUrl } from './_client';
import { routes } from './_routes';

import type {
  ApiErrorBody,
  CanvasConflictResponse,
  CanvasErrorCode,
  DeleteCanvasResponse,
  GetCanvasResponse,
  GetWorldReferencesResponse,
  GetNodeContentResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  PutNodeContentRequest,
  PutNodeContentResponse,
  DeleteNodeResponse,
  ImportCanvasResponse,
  ListCanvasesResponse,
  CreateCanvasRequest,
  CreateCanvasResponse,
  ExecuteOriginator,
  PreprocessNodeRequest,
  PreprocessNodeResponse,
  RevealNodesFolderResponse,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';

/**
 * Error thrown when a canvas mutation is rejected by the server with a
 * structured 409 conflict (`CanvasConflictResponse`). Callers can branch on
 * `code` to distinguish title / node-label collisions from version drift.
 */
export class CanvasConflictError extends Error {
  readonly code: CanvasErrorCode;
  readonly conflictWith?: string;
  readonly nodeId?: string;
  readonly serverVersion?: number;
  /** For `NODE_CONTENT_CONFLICT`: the on-disk node's current revision. */
  readonly currentRev?: string;

  constructor(payload: CanvasConflictResponse) {
    super(payload.message);
    this.name = 'CanvasConflictError';
    this.code = payload.code;
    this.conflictWith = payload.conflictWith;
    this.nodeId = payload.nodeId;
    this.serverVersion = payload.serverVersion;
    this.currentRev = payload.currentRev;
  }
}

function isCanvasConflictResponse(
  value: unknown,
): value is CanvasConflictResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}

/**
 * Error thrown when a per-node content write is refused because more than
 * one markdown sidecar on disk claims the node's id (`NODE_DUPLICATE_FILES`).
 * Unlike {@link CanvasConflictError} (a label collision handled silently by
 * `tryRename`), this is an unresolved on-disk state the user must fix, so
 * callers surface it with a persistent toast rather than swallowing it.
 */
export class NodeDuplicateFilesError extends Error {
  readonly nodeId?: string;
  readonly duplicateFiles: string[];

  constructor(payload: {
    message: string;
    nodeId?: string;
    duplicateFiles?: string[];
  }) {
    super(payload.message);
    this.name = 'NodeDuplicateFilesError';
    this.nodeId = payload.nodeId;
    this.duplicateFiles = Array.isArray(payload.duplicateFiles)
      ? payload.duplicateFiles
      : [];
  }
}

function isNodeDuplicateResponse(value: unknown): value is {
  code: 'NODE_DUPLICATE_FILES';
  message: string;
  nodeId?: string;
  duplicateFiles?: string[];
} {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.code === 'NODE_DUPLICATE_FILES' && typeof v.message === 'string';
}

/**
 * List all canvases in the workspace.
 */
export async function listCanvases(): Promise<ListCanvasesResponse> {
  return apiFetch<ListCanvasesResponse>(routes.canvasList, {
    fallbackMessage: 'Failed to list Spaces',
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
    fallbackMessage: 'Failed to create Space',
  });
}

export async function getCanvas(
  canvasId: string,
): Promise<GetCanvasResponse | null> {
  try {
    return await apiFetch<GetCanvasResponse>(routes.canvas(canvasId), {
      fallbackMessage: 'Failed to get Space',
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    console.error('Failed to get canvas:', error);
    return null;
  }
}

export async function getWorldReferences(
  canvasId: string,
): Promise<GetWorldReferencesResponse> {
  return apiFetch<GetWorldReferencesResponse>(
    routes.canvasReferences(canvasId),
    {
      fallbackMessage: 'Failed to resolve World references',
    },
  );
}

export async function postCanvasExecute(
  canvasId: string,
  request: PostCanvasExecuteRequest,
): Promise<PostCanvasExecuteResponse> {
  return apiFetch<PostCanvasExecuteResponse>(routes.canvasExecute(canvasId), {
    method: 'POST',
    json: request,
    fallbackMessage: 'Failed to execute Space command',
  });
}

export async function putCanvas(
  canvasId: string,
  request: PutCanvasRequest,
  options?: { keepalive?: boolean },
): Promise<PutCanvasResponse> {
  // We can't use `apiFetch` directly because the structured 409
  // `CanvasConflictResponse` carries `conflictWith` / `nodeId` /
  // `serverVersion` at the top level, while `ApiError` only preserves
  // `code` + `details` from the canonical `ApiErrorBody`. Fall back to
  // a raw `fetch` so we can throw a `CanvasConflictError` with the
  // full payload intact.
  const response = await fetch(apiUrl(routes.canvas(canvasId)), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    keepalive: options?.keepalive ?? false,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.status === 409 && isCanvasConflictResponse(body)) {
      throw new CanvasConflictError(body);
    }
    const errBody =
      body && typeof body === 'object' ? (body as Partial<ApiErrorBody>) : {};
    throw new ApiError(response.status, errBody, 'Failed to save Space');
  }

  return (await response.json()) as PutCanvasResponse;
}

export async function deleteNode(
  canvasId: string,
  nodeId: string,
  options?: { signal?: AbortSignal; originator?: ExecuteOriginator },
): Promise<DeleteNodeResponse> {
  return apiFetch<DeleteNodeResponse>(routes.canvasNode(canvasId, nodeId), {
    method: 'DELETE',
    signal: options?.signal,
    ...(options?.originator
      ? { json: { originator: options.originator } }
      : {}),
    fallbackMessage: 'Failed to delete node',
  });
}

/**
 * Persist a single node's markdown sidecar (`nodes/<safe(label)>.md`). It
 * participates in the Phase 4 global commit sequence while leaving the
 * independent structure revision unchanged.
 *
 * Mirrors `putCanvas`'s raw-fetch pattern so a 409 `NODE_LABEL_CONFLICT`
 * body deserialises into `CanvasConflictError` with `nodeId` +
 * `conflictWith` intact, which `tryRename` reads to revert + alert.
 */
export async function putNodeContent(
  canvasId: string,
  nodeId: string,
  request: PutNodeContentRequest,
  options?: { keepalive?: boolean },
): Promise<PutNodeContentResponse> {
  const response = await fetch(
    apiUrl(routes.canvasNodeContent(canvasId, nodeId)),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      keepalive: options?.keepalive ?? false,
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as unknown;
    // Duplicate-sidecar refusal must be checked before the generic
    // conflict branch: it also carries a `code`, so `isCanvasConflictResponse`
    // would otherwise claim it and route it through `tryRename`'s silent
    // swallow instead of surfacing the persistent toast.
    if (response.status === 409 && isNodeDuplicateResponse(body)) {
      throw new NodeDuplicateFilesError(body);
    }
    if (response.status === 409 && isCanvasConflictResponse(body)) {
      throw new CanvasConflictError(body);
    }
    const errBody =
      body && typeof body === 'object' ? (body as Partial<ApiErrorBody>) : {};
    throw new ApiError(response.status, errBody, 'Failed to save node content');
  }

  return (await response.json()) as PutNodeContentResponse;
}

/**
 * Fetch a single node's persisted markdown sidecar. Returns `null` when
 * the canvas itself is missing (404); for an existing canvas with a
 * deleted / never-written sidecar the server responds 200 with
 * `contentMissing: true` so callers can render the placeholder UI.
 */
export async function getNodeContent(
  canvasId: string,
  nodeId: string,
): Promise<GetNodeContentResponse | null> {
  try {
    return await apiFetch<GetNodeContentResponse>(
      routes.canvasNodeContent(canvasId, nodeId),
      { fallbackMessage: 'Failed to get node content' },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    console.error('Failed to get node content:', error);
    return null;
  }
}

/**
 * Download the canvas as a self-contained `.huabu.json` export bundle.
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
 * Import a canvas from a `.huabu.zip` archive.
 * The server allocates a fresh canvas id, restores artifacts/history,
 * and rewrites embedded artifact URLs to the new id.
 */
export async function importCanvas(file: File): Promise<ImportCanvasResponse> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  return apiFetch<ImportCanvasResponse>(routes.canvasImport, {
    method: 'POST',
    formData,
    fallbackMessage: 'Failed to import Space',
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
    fallbackMessage: 'Failed to delete Space',
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
    originator?: ExecuteOriginator;
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

/**
 * Open the canvas's `nodes/` folder in the host OS file manager so the
 * user can resolve a duplicate-markdown collision by hand. Desktop-first:
 * the server runs locally and owns the only reliable filesystem path.
 */
export async function revealCanvasNodesFolder(
  canvasId: string,
): Promise<RevealNodesFolderResponse> {
  return apiFetch<RevealNodesFolderResponse>(
    routes.canvasRevealNodes(canvasId),
    {
      method: 'POST',
      fallbackMessage: 'Failed to open nodes folder',
    },
  );
}

// Re-export `ApiError` so call sites can `instanceof`-check thrown errors
// from the canvas helpers without importing the internal `_client` module.
export { ApiError };
export type { ApiErrorBody };
