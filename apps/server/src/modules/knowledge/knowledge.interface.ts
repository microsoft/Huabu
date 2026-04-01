import type {
  CreateSourceInput,
  Source,
  SourceOverview,
} from '@sediment/shared';

/**
 * Abstract interface for knowledge storage backends.
 *
 * Implementations:
 * - FileKnowledgeRepository (file-based, Markdown + YAML frontmatter)
 *
 * Consumers should depend on this interface rather than a concrete class so the
 * storage backend can be swapped at construction time.
 */
export interface IKnowledgeRepository {
  // ==================== Source Operations ====================

  /** Find source by ID */
  findSourceById(sourceId: string): Source | null;

  /** Find source by content hash (for deduplication) */
  findSourceByHash(contentHash: string): Source | null;

  /** Find all sources */
  findAllSources(): Source[];

  /** Find all sources metadata (excludes content) */
  findAllSourcesOverview(): SourceOverview[];

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

  /** Delete a source by ID. Returns true if it existed and was removed. */
  deleteSource(sourceId: string): Promise<boolean>;

  // ==================== Transaction Support ====================

  /**
   * Execute a function inside a transaction (or a best-effort equivalent).
   * File-based backends simply run fn() synchronously.
   */
  transaction<T>(fn: () => T): T;
}
