import { getKnowledgeDb } from './knowledge.db.js';

import type { IKnowledgeRepository } from './knowledge.interface.js';
import type {
  CreateRevisionInput,
  CreateSourceInput,
  SourceRevisionRow,
  SourceRow,
} from './types.js';
import type { KnowledgeStorageConfig } from '@sediment/shared';
import type Database from 'better-sqlite3';

/**
 * SQLite-backed knowledge repository.
 * Implements IKnowledgeRepository using better-sqlite3.
 */
export class KnowledgeRepository implements IKnowledgeRepository {
  private db: Database.Database;

  constructor(database?: Database.Database) {
    this.db = database ?? getKnowledgeDb();
  }

  // ==================== Source Operations ====================

  /**
   * Find source by ID
   */
  findSourceById(sourceId: string): SourceRow | null {
    const stmt = this.db.prepare<[string], SourceRow>(
      'SELECT * FROM sources WHERE source_id = ?',
    );
    return stmt.get(sourceId) ?? null;
  }

  /**
   * Find source by workspace and content hash
   * Useful for deduplication (e.g., same web URL)
   */
  findSourceByHash(workspaceId: string, contentHash: string): SourceRow | null {
    const stmt = this.db.prepare<[string, string], SourceRow>(
      'SELECT * FROM sources WHERE workspace_id = ? AND content_hash = ?',
    );
    return stmt.get(workspaceId, contentHash) ?? null;
  }

  /**
   * Create a new source record
   */
  createSource(input: CreateSourceInput): SourceRow {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO sources (
        source_id, workspace_id, type, title, uri,
        created_at, updated_at,
        content_text, content_hash, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.sourceId,
      input.workspaceId,
      input.type,
      input.title ?? null,
      input.uri ?? null,
      now,
      now,
      input.contentText ?? '',
      input.contentHash,
      metaJson,
    );

    const result = this.findSourceById(input.sourceId);
    if (!result) {
      throw new Error(`Failed to create source: ${input.sourceId}`);
    }
    return result;
  }

  /**
   * Update source content and metadata
   * Used for Web/PDF when content changes or Note/Text current snapshot
   */
  updateSource(
    sourceId: string,
    updates: {
      contentText?: string;
      contentHash?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): SourceRow {
    const now = Date.now();
    const metaJson = updates.metadata ? JSON.stringify(updates.metadata) : null;

    const stmt = this.db.prepare(`
      UPDATE sources
      SET content_text = COALESCE(?, content_text),
          content_hash = COALESCE(?, content_hash),
          title = COALESCE(?, title),
          meta_json = COALESCE(?, meta_json),
          updated_at = ?
      WHERE source_id = ?
    `);

    stmt.run(
      updates.contentText ?? null,
      updates.contentHash ?? null,
      updates.title ?? null,
      metaJson,
      now,
      sourceId,
    );

    const result = this.findSourceById(sourceId);
    if (!result) {
      throw new Error(`Source not found after update: ${sourceId}`);
    }
    return result;
  }

  // ==================== Revision Operations ====================

  /**
   * Find latest revision for a source
   */
  findLatestRevision(sourceId: string): SourceRevisionRow | null {
    const stmt = this.db.prepare<[string], SourceRevisionRow>(`
      SELECT * FROM source_revisions
      WHERE source_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return stmt.get(sourceId) ?? null;
  }

  /**
   * Find revision by ID
   */
  findRevisionById(revisionId: string): SourceRevisionRow | null {
    const stmt = this.db.prepare<[string], SourceRevisionRow>(
      'SELECT * FROM source_revisions WHERE revision_id = ?',
    );
    return stmt.get(revisionId) ?? null;
  }

  /**
   * Check if a revision with specific hash exists for a source
   * Used to avoid creating duplicate revisions
   */
  findRevisionByHash(
    sourceId: string,
    contentHash: string,
  ): SourceRevisionRow | null {
    const stmt = this.db.prepare<[string, string], SourceRevisionRow>(`
      SELECT * FROM source_revisions
      WHERE source_id = ? AND content_hash = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return stmt.get(sourceId, contentHash) ?? null;
  }

  /**
   * Create a new revision record
   */
  createRevision(input: CreateRevisionInput): SourceRevisionRow {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO source_revisions (
        revision_id, workspace_id, source_id, created_at,
        content_text, content_hash, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.revisionId,
      input.workspaceId,
      input.sourceId,
      now,
      input.contentText ?? '',
      input.contentHash,
      metaJson,
    );

    const result = this.findRevisionById(input.revisionId);
    if (!result) {
      throw new Error(`Failed to create revision: ${input.revisionId}`);
    }
    return result;
  }

  /**
   * Get all revisions for a source (for history view)
   */
  findRevisionsBySourceId(sourceId: string): SourceRevisionRow[] {
    const stmt = this.db.prepare<[string], SourceRevisionRow>(`
      SELECT * FROM source_revisions
      WHERE source_id = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(sourceId);
  }

  /**
   * Transaction support for atomic operations
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

/**
 * Singleton instance for convenience.
 * Lazily created via createKnowledgeRepository() which uses
 * the runtime storage config set from the canvas frontend.
 */
let repositoryInstance: IKnowledgeRepository | null = null;

/**
 * Currently active storage config (set via setKnowledgeStorageConfig).
 */
let activeConfig: KnowledgeStorageConfig | null = null;

/**
 * Create a repository instance based on the provided config.
 *
 * Supported backends:
 *  - "sqlite"   (default) – uses better-sqlite3
 *  - "obsidian" – reads/writes Markdown files in an Obsidian vault
 *                 (requires obsidianVaultPath in config)
 */
async function createKnowledgeRepository(
  config?: KnowledgeStorageConfig,
): Promise<IKnowledgeRepository> {
  const backend = (config?.backend ?? 'sqlite').toLowerCase();

  if (backend === 'obsidian') {
    // Dynamic import to avoid loading Obsidian code when unused
    const { ObsidianKnowledgeRepository } =
      await import('./obsidian.repository.js');
    const vaultPath = config?.obsidianVaultPath;
    if (!vaultPath) {
      throw new Error(
        'obsidianVaultPath is required when backend is "obsidian"',
      );
    }
    return new ObsidianKnowledgeRepository(vaultPath);
  }

  // Default: SQLite
  return new KnowledgeRepository();
}

/**
 * Update the storage configuration at runtime.
 * Clears the cached singleton so the next call to getKnowledgeRepository()
 * will create a fresh instance matching the new config.
 *
 * NOTE: callers should also call resetIngestService() (from ingest.service)
 * after this to ensure the IngestService picks up the new repository.
 */
export function setKnowledgeStorageConfig(
  config: KnowledgeStorageConfig,
): void {
  const configChanged =
    activeConfig?.backend !== config.backend ||
    activeConfig?.obsidianVaultPath !== config.obsidianVaultPath;

  if (configChanged) {
    activeConfig = config;
    repositoryInstance = null;
  }
}

/**
 * Get or initialise the knowledge repository singleton.
 * The concrete implementation is chosen by createKnowledgeRepository().
 */
export async function getKnowledgeRepository(): Promise<IKnowledgeRepository> {
  if (!repositoryInstance) {
    repositoryInstance = await createKnowledgeRepository(
      activeConfig ?? undefined,
    );
  }
  return repositoryInstance;
}
