/**
 * Canvas API types for server-client communication
 */

export interface GetCanvasResponse {
  canvasId: string;
  version: number;
  state: unknown;
}

export interface PutCanvasRequest {
  version: number;
  state: unknown;
  workspaceId?: string;
  title?: string;
}

export interface PutCanvasResponse {
  canvasId: string;
  version: number;
}

export interface CanvasVersionMismatchError {
  message: string;
  serverVersion: number;
}

/**
 * Node API types for individual node operations
 */

export interface UpsertNodeRequest {
  workspaceId?: string;
  type: 'note' | 'text' | 'web' | 'pdf';
  title?: string;
  content?: string;
  src?: string;
}

export interface UpsertNodeResponse {
  nodeId: string;
  sourceId: string | null;
}

export interface DeleteNodeResponse {
  success: boolean;
}
