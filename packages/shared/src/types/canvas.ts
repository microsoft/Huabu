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
