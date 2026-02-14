import type {
  CreateRevisionInput,
  CreateSourceInput,
  SourceRevisionRow,
  SourceRow,
} from './types.js';

/**
 * Abstract interface for knowledge storage backends.
 *
 * Implementations:
 * - SqliteKnowledgeRepository  (default, backed by better-sqlite3)
 * - ObsidianKnowledgeRepository (backed by an Obsidian vault on the filesystem)
 *
 * Consumers should depend on this interface rather than a concrete class so the
 * storage backend can be swapped via the KNOWLEDGE_STORAGE env var.
 */
export interface IKnowledgeRepository {
  // ==================== Source Operations ====================

  /** Find source by ID */
  findSourceById(sourceId: string): SourceRow | null;

  /** Find source by workspace and content hash (for deduplication) */
  findSourceByHash(workspaceId: string, contentHash: string): SourceRow | null;

  /** Find all sources for a workspace */
  findAllSources(workspaceId: string): SourceRow[];

  /** Create a new source record */
  createSource(input: CreateSourceInput): SourceRow;

  /** Update source content and metadata */
  updateSource(
    sourceId: string,
    updates: {
      contentText?: string;
      contentHash?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): SourceRow;

  // ==================== Revision Operations ====================

  /** Find latest revision for a source */
  findLatestRevision(sourceId: string): SourceRevisionRow | null;

  /** Find revision by ID */
  findRevisionById(revisionId: string): SourceRevisionRow | null;

  /** Check if a revision with specific hash exists for a source */
  findRevisionByHash(
    sourceId: string,
    contentHash: string,
  ): SourceRevisionRow | null;

  /** Create a new revision record */
  createRevision(input: CreateRevisionInput): SourceRevisionRow;

  /** Get all revisions for a source (for history view) */
  findRevisionsBySourceId(sourceId: string): SourceRevisionRow[];

  // ==================== Transaction Support ====================

  /**
   * Execute a function inside a transaction (or a best-effort equivalent).
   * SQLite uses real transactions; file-based backends may just run fn().
   */
  transaction<T>(fn: () => T): T;
}
