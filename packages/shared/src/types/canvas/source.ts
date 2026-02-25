/**
 * Knowledge Source Types
 * Node ingestion and knowledge base storage
 */

import type { CanvasNodeType } from './node.js';

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

/**
 * Node ingestion request types
 */

export interface UpsertNodeRequest {
  workspaceId?: string;
  type: Exclude<CanvasNodeType, 'frame'>; // All node types except 'frame'
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
   * The storage backend where this source was persisted.
   * Stored on the node so the client can detect cross-backend mismatches.
   */
  sourceBackend?: KnowledgeStorageBackend;
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

/**
 * Storage migration API types
 */

export interface MigrateStorageRequest {
  to: KnowledgeStorageConfig;
}

export interface MigrateStorageNodeResult {
  nodeId: string;
  sourceId: string;
  status: 'migrated' | 'skipped' | 'failed';
  error?: string;
}

export interface MigrateStorageResponse {
  success: boolean;
  totalNodes: number;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  results: MigrateStorageNodeResult[];
  version: number;
}
