/**
 * Node content types
 * Shared types describing the kind of content a node holds and the
 * metadata produced by the preprocessing pipeline.
 */

export type NodeContentKind = 'web' | 'pdf' | 'note' | 'text';

/**
 * Node content metadata (parsed from the per-node markdown frontmatter).
 */
export interface NodeContentMetadata {
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

  // LLM-enriched
  summary?: string;
  keywords?: string[];

  // Extensible for future metadata
  [key: string]: unknown;
}
