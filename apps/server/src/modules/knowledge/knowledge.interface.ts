import type {
  CreateSourceInput,
  Source,
  SourceOverview,
} from '@sediment/shared';

/**
 * Abstract interface for knowledge storage backends.
 *
 * Implementations:
 * - ObsidianKnowledgeRepository (file-based, Markdown + YAML frontmatter)
 *
 * Consumers should depend on this interface rather than a concrete class so the
 * storage backend can be swapped at construction time.
 */
export interface IKnowledgeRepository {
  // ==================== Source Operations ====================

  /** Find source by ID */
  findSourceById(sourceId: string): Source | null;

  /** Find source by workspace and content hash (for deduplication) */
  findSourceByHash(workspaceId: string, contentHash: string): Source | null;

  /** Find all sources for a workspace */
  findAllSources(workspaceId: string): Source[];

  /** Find all sources metadata for a workspace (excludes content) */
  findAllSourcesOverview(workspaceId: string): SourceOverview[];

  /** Create a new source record */
  createSource(input: CreateSourceInput): Source;

  /** Update source content and metadata */
  updateSource(
    sourceId: string,
    updates: {
      content?: string;
      contentHash?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): Source;

  // ==================== Transaction Support ====================

  /**
   * Execute a function inside a transaction (or a best-effort equivalent).
   * File-based backends simply run fn() synchronously.
   */
  transaction<T>(fn: () => T): T;
}
