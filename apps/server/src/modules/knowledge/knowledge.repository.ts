import { getKnowledgeDb } from './knowledge.db.js';

import type { IKnowledgeRepository } from './knowledge.interface.js';
import type {
  CreateRevisionInput,
  CreateSourceInput,
  Source,
  SourceOverview,
  SourceRevision,
} from '@sediment/shared';
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
  findSourceById(sourceId: string): Source | null {
    const stmt = this.db.prepare<[string], Source>(
      'SELECT * FROM sources WHERE sourceId = ?',
    );
    return stmt.get(sourceId) ?? null;
  }

  /**
   * Find source by workspace and content hash
   * Useful for deduplication (e.g., same web URL)
   */
  findSourceByHash(workspaceId: string, contentHash: string): Source | null {
    const stmt = this.db.prepare<[string, string], Source>(
      'SELECT * FROM sources WHERE workspaceId = ? AND contentHash = ?',
    );
    return stmt.get(workspaceId, contentHash) ?? null;
  }

  /**
   * Find all sources for a workspace
   */
  findAllSources(workspaceId: string): Source[] {
    const stmt = this.db.prepare<[string], Source>(
      'SELECT * FROM sources WHERE workspaceId = ?',
    );
    return stmt.all(workspaceId);
  }

  /**
   * Find all sources metadata for a workspace (excludes content)
   */
  findAllSourcesOverview(workspaceId: string): SourceOverview[] {
    const stmt = this.db.prepare<[string], SourceOverview>(
      `SELECT 
        sourceId, workspaceId, type, title, src, 
        createdAt, updatedAt, contentHash, metaJson 
       FROM sources WHERE workspaceId = ?`,
    );
    return stmt.all(workspaceId);
  }

  /**
   * Create a new source record
   */
  createSource(input: CreateSourceInput): Source {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO sources (
        sourceId, workspaceId, type, title, src,
        createdAt, updatedAt,
        content, contentHash, metaJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.sourceId,
      input.workspaceId,
      input.type,
      input.title ?? null,
      input.src ?? null,
      now,
      now,
      input.content ?? '',
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
      content?: string;
      contentHash?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): Source {
    const now = Date.now();
    const metaJson = updates.metadata ? JSON.stringify(updates.metadata) : null;

    const stmt = this.db.prepare(`
      UPDATE sources
      SET content = COALESCE(?, content),
          contentHash = COALESCE(?, contentHash),
          title = COALESCE(?, title),
          metaJson = COALESCE(?, metaJson),
          updatedAt = ?
      WHERE sourceId = ?
    `);

    stmt.run(
      updates.content ?? null,
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
  findLatestRevision(sourceId: string): SourceRevision | null {
    const stmt = this.db.prepare<[string], SourceRevision>(`
      SELECT * FROM source_revisions
      WHERE sourceId = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `);
    return stmt.get(sourceId) ?? null;
  }

  /**
   * Find revision by ID
   */
  findRevisionById(revisionId: string): SourceRevision | null {
    const stmt = this.db.prepare<[string], SourceRevision>(
      'SELECT * FROM source_revisions WHERE revisionId = ?',
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
  ): SourceRevision | null {
    const stmt = this.db.prepare<[string, string], SourceRevision>(`
      SELECT * FROM source_revisions
      WHERE sourceId = ? AND contentHash = ?
      ORDER BY createdAt DESC
      LIMIT 1
    `);
    return stmt.get(sourceId, contentHash) ?? null;
  }

  /**
   * Create a new revision record
   */
  createRevision(input: CreateRevisionInput): SourceRevision {
    const now = Date.now();
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO source_revisions (
        revisionId, workspaceId, sourceId, createdAt,
        content, contentHash, metaJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.revisionId,
      input.workspaceId,
      input.sourceId,
      now,
      input.content ?? '',
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
  findRevisionsBySourceId(sourceId: string): SourceRevision[] {
    const stmt = this.db.prepare<[string], SourceRevision>(`
      SELECT * FROM source_revisions
      WHERE sourceId = ?
      ORDER BY createdAt DESC
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
    const { ObsidianKnowledgeRepository } = await import(
      './obsidian.repository.js'
    );
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

/**
 * Return a copy of the currently active storage config,
 * or a default SQLite config if none has been set yet.
 */
export function getActiveStorageConfig(): KnowledgeStorageConfig {
  return activeConfig ? { ...activeConfig } : { backend: 'sqlite' };
}

/**
 * Create a standalone repository for a given config.
 * Unlike getKnowledgeRepository(), this does NOT affect the cached singleton.
 * Useful for migration scenarios where two backends must be accessed simultaneously.
 */
export async function createRepositoryForConfig(
  config: KnowledgeStorageConfig,
): Promise<IKnowledgeRepository> {
  return createKnowledgeRepository(config);
}
