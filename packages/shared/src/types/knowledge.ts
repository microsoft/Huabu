/**
 * Knowledge Store Types
 * Shared types for knowledge base sources and revisions
 */

export type SourceType = 'web' | 'pdf' | 'note' | 'text';

/**
 * Source record - stores metadata and content for all data sources
 */
export interface Source {
  sourceId: string;
  workspaceId: string;
  type: SourceType;
  title: string | null;
  src: string | null;
  createdAt: number;
  updatedAt: number;
  content: string;
  contentHash: string;
  metaJson: string | null;
}

/**
 * Source overview (excludes content for performance)
 */
export type SourceOverview = Omit<Source, 'content'>;

/**
 * Source metadata (parsed from metaJson)
 */
export interface SourceMetadata {
  // Web-specific
  author?: string;
  publishDate?: string;
  favicon?: string;
  siteName?: string;
  image?: string;
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
  src?: string;
  content?: string;
  contentHash: string;
  metadata?: SourceMetadata;
}
