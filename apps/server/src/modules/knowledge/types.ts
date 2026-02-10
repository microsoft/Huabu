/**
 * Source types supported by the knowledge store
 */
export type SourceType = 'web' | 'pdf' | 'note' | 'text';

/**
 * Source record in the knowledge database
 * Stores metadata and current content snapshot for all data sources
 */
export interface SourceRow {
  source_id: string;
  workspace_id: string;
  type: SourceType;
  title: string | null;
  uri: string | null;
  created_at: number;
  updated_at: number;
  content_artifact_uri: string | null;
  content_text: string | null;
  content_hash: string;
  meta_json: string | null;
}

/**
 * Source revision record in the knowledge database
 * Stores version history for editable sources (note/text)
 */
export interface SourceRevisionRow {
  revision_id: string;
  workspace_id: string;
  source_id: string;
  created_at: number;
  content_artifact_uri: string | null;
  content_text: string | null;
  content_hash: string;
  meta_json: string | null;
}

/**
 * Source metadata (parsed from meta_json)
 */
export interface SourceMetadata {
  // Web-specific
  author?: string;
  publishDate?: string;
  favicon?: string;
  wordCount?: number;

  // PDF-specific
  pageCount?: number;
  fileSize?: number;
  createdDate?: string;

  // Note-specific
  tags?: string[];
  lastEditor?: string;

  // Extensible for future metadata
  [key: string]: unknown;
}

/**
 * Source creation input
 */
export interface CreateSourceInput {
  sourceId: string;
  workspaceId: string;
  type: SourceType;
  title?: string;
  uri?: string;
  contentText?: string;
  contentArtifactUri?: string;
  contentHash: string;
  metadata?: SourceMetadata;
}

/**
 * Source revision creation input
 */
export interface CreateRevisionInput {
  revisionId: string;
  workspaceId: string;
  sourceId: string;
  contentText?: string;
  contentArtifactUri?: string;
  contentHash: string;
  metadata?: SourceMetadata;
}
