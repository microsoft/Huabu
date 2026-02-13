/**
 * Canvas API types for server-client communication
 */

/**
 * Supported knowledge storage backends.
 */
export type KnowledgeStorageBackend = 'sqlite' | 'obsidian';

/**
 * User-configurable knowledge storage settings.
 * Persisted inside the canvas state so it can be changed from the frontend.
 */
export interface KnowledgeStorageConfig {
  backend: KnowledgeStorageBackend;
  /** Required when backend is 'obsidian'. Absolute path to the Obsidian vault folder. */
  obsidianVaultPath?: string;
}

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
  /**
   * Existing source ID from a previous ingestion.
   * When provided the server will update the existing source
   * instead of creating a new one.
   */
  sourceId?: string;
}

export interface UpsertNodeResponse {
  nodeId: string;
  sourceId: string;
  success: boolean;
  /**
   * Optional server-suggested label derived from ingested content (e.g. web page title, PDF title).
   * The client may choose to apply it only when the current label is empty or still a placeholder.
   */
  suggestedLabel?: string;
  error?: string;
}

export interface DeleteNodeResponse {
  success: boolean;
}
