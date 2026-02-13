import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { getKnowledgeRepository } from './knowledge.repository.js';
import { parsePdfFile } from './pdf-parser.js';
import {
  computeBufferHash,
  computeContentHash,
  generateRevisionId,
  generateSourceId,
  normalizeUrl,
} from './utils.js';
import { getWebSnapshot } from './web-fetcher.js';

import type { IKnowledgeRepository } from './knowledge.interface.js';
import type { SourceMetadata, SourceRow, SourceType } from './types.js';

/**
 * Input for Text/Note source ingestion
 */
export interface IngestTextSourceInput {
  workspaceId: string;
  nodeId: string;
  type: 'note' | 'text';
  title?: string;
  content: string;
  metadata?: SourceMetadata;
  /**
   * Optional: provide existing sourceId if this is an update
   * If not provided, a new sourceId will be generated
   */
  existingSourceId?: string;
}

/**
 * Input for Web source ingestion
 */
export interface IngestWebSourceInput {
  workspaceId: string;
  nodeId: string;
  uri: string;
  title?: string;
  /**
   * Optional: pre-fetched content from frontend
   * If provided, backend will use this instead of fetching
   */
  content?: string;
  metadata?: SourceMetadata;
}

/**
 * Input for PDF source ingestion
 */
export interface IngestPdfSourceInput {
  workspaceId: string;
  nodeId: string;
  artifactUri: string;
  title?: string;
  /**
   * Absolute path to PDF file in artifact store
   * Must be provided for PDF parsing
   */
  filePath: string;
  metadata?: SourceMetadata;
}

/**
 * Result of source ingestion
 */
export interface IngestSourceResult {
  source: SourceRow;
  revisionId?: string;
  isNew: boolean;
  contentChanged: boolean;
}

export type NodeIngestError = {
  code: string;
  message: string;
};

export type NodeIngestOutcome = {
  sourceId: string;
  success: boolean;
  /**
   * Optional title inferred during ingestion (e.g. from web fetch or PDF metadata).
   * Canvas can use this as a suggested default label.
   */
  title?: string;
  error?: NodeIngestError;
};

/**
 * Service layer for knowledge source ingestion
 * Handles business logic for creating/updating sources and revisions
 */
export class IngestService {
  constructor(private repository: IKnowledgeRepository) {}

  private safeParseMeta(metaJson: string | null): Record<string, unknown> {
    if (!metaJson) return {};
    try {
      const parsed = JSON.parse(metaJson) as unknown;
      if (parsed && typeof parsed === 'object')
        return parsed as Record<string, unknown>;
      return {};
    } catch {
      return {};
    }
  }

  private toMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private upsertPlaceholderSource(params: {
    sourceId: string;
    workspaceId: string;
    type: 'note' | 'text' | 'web' | 'pdf';
    title?: string;
    uri?: string;
    ingestError?: NodeIngestError;
    extraMetadata?: Record<string, unknown>;
  }): void {
    const existing = this.repository.findSourceById(params.sourceId);
    const metadata: Record<string, unknown> = {
      ...(existing ? this.safeParseMeta(existing.meta_json) : {}),
      ...(params.extraMetadata ?? {}),
      placeholder: true,
      ingestError: params.ingestError,
    };

    if (existing) {
      this.repository.updateSource(params.sourceId, {
        title: params.title,
        metadata,
      });
      return;
    }

    this.repository.createSource({
      sourceId: params.sourceId,
      workspaceId: params.workspaceId,
      type: params.type,
      title: params.title,
      uri: params.uri,
      contentText: '',
      contentHash: computeContentHash(''),
      metadata,
    });
  }

  /**
   * Ingest a node coming from the canvas node endpoint.
   * This method never throws for expected ingest failures; it returns a non-null sourceId
   * and includes a detailed ingestError.
   */
  async ingestCanvasNode(params: {
    workspaceId: string;
    nodeId: string;
    type: 'note' | 'text' | 'web';
    title?: string;
    content?: string;
    src?: string;
    existingSourceId?: string | null;
  }): Promise<NodeIngestOutcome> {
    const { workspaceId, nodeId, type, title, content, src, existingSourceId } =
      params;

    if (type === 'note' || type === 'text') {
      const nodeContent = content ?? '';
      if (nodeContent.trim().length === 0) {
        const sourceId =
          existingSourceId ??
          generateSourceId({
            workspaceId,
            type,
          });
        const ingestError: NodeIngestError = {
          code: 'EMPTY_CONTENT',
          message: 'No content to ingest yet',
        };
        this.upsertPlaceholderSource({
          sourceId,
          workspaceId,
          type,
          title,
          ingestError,
        });
        return { sourceId, success: false, error: ingestError };
      }

      try {
        const result = await this.ingestTextSource({
          workspaceId,
          nodeId,
          type,
          title,
          content: nodeContent,
          existingSourceId: existingSourceId ?? undefined,
        });
        return {
          sourceId: result.source.source_id,
          success: true,
          title: result.source.title ?? undefined,
        };
      } catch (error) {
        const sourceId =
          existingSourceId ??
          generateSourceId({
            workspaceId,
            type,
          });
        const ingestError: NodeIngestError = {
          code: 'TEXT_INGEST_FAILED',
          message: this.toMessage(error),
        };
        this.upsertPlaceholderSource({
          sourceId,
          workspaceId,
          type,
          title,
          ingestError,
        });
        return { sourceId, success: false, error: ingestError };
      }
    }

    // type === 'web'
    const uri = (src ?? '').trim();
    if (uri.length === 0) {
      const normalizedUri = `missing:${nodeId}`;
      const sourceId =
        existingSourceId ??
        generateSourceId({
          workspaceId,
          type: 'web',
          uri: normalizedUri,
        });
      const ingestError: NodeIngestError = {
        code: 'MISSING_SRC',
        message: 'Missing src for web node',
      };
      this.upsertPlaceholderSource({
        sourceId,
        workspaceId,
        type: 'web',
        title,
        uri: normalizedUri,
        ingestError,
      });
      return { sourceId, success: false, error: ingestError };
    }

    try {
      const result = await this.ingestWebSource({
        workspaceId,
        nodeId,
        uri,
        title,
        content,
      });
      return {
        sourceId: result.source.source_id,
        success: true,
        title: result.source.title ?? undefined,
      };
    } catch (error) {
      const normalizedUri = normalizeUrl(uri);
      const sourceId =
        existingSourceId ??
        generateSourceId({
          workspaceId,
          type: 'web',
          uri: normalizedUri,
        });
      const ingestError: NodeIngestError = {
        code: 'WEB_INGEST_FAILED',
        message: this.toMessage(error),
      };
      this.upsertPlaceholderSource({
        sourceId,
        workspaceId,
        type: 'web',
        title,
        uri: normalizedUri,
        ingestError,
      });
      return { sourceId, success: false, error: ingestError };
    }
  }

  /**
   * Ingest a PDF node when the frontend provides an artifact URI.
   * The artifactsDir should point at the server's artifact storage directory.
   */
  async ingestPdfCanvasNodeFromArtifact(params: {
    workspaceId: string;
    nodeId: string;
    title?: string;
    artifactUri?: string;
    artifactsDir: string;
    existingSourceId?: string | null;
  }): Promise<NodeIngestOutcome> {
    const { workspaceId, nodeId, title, artifactsDir, existingSourceId } =
      params;
    const artifactUri = (params.artifactUri ?? '').trim();

    const placeholderFrom = async (ingestError: NodeIngestError) => {
      // Try to create a stable pdf sourceId.
      let fileHash = artifactUri
        ? computeContentHash(artifactUri)
        : computeContentHash(nodeId);

      const filename = this.extractArtifactFilename(artifactUri);
      if (filename) {
        const filePath = path.join(artifactsDir, filename);
        try {
          const buffer = await readFile(filePath);
          fileHash = computeBufferHash(buffer);
        } catch {
          // Ignore; keep fallback hash.
        }
      }

      const sourceId =
        existingSourceId ??
        generateSourceId({
          workspaceId,
          type: 'pdf',
          fileHash,
        });

      this.upsertPlaceholderSource({
        sourceId,
        workspaceId,
        type: 'pdf',
        title,
        uri: artifactUri || undefined,
        ingestError,
        extraMetadata: {
          originalArtifactUri: artifactUri,
        },
      });

      return { sourceId, success: false, error: ingestError };
    };

    if (artifactUri.length === 0) {
      return placeholderFrom({
        code: 'MISSING_SRC',
        message: 'Missing src for pdf node',
      });
    }

    const filename = this.extractArtifactFilename(artifactUri);
    if (!filename) {
      return placeholderFrom({
        code: 'INVALID_ARTIFACT_URI',
        message: 'Invalid PDF artifact URI',
      });
    }

    const filePath = path.join(artifactsDir, filename);
    try {
      await access(filePath);
    } catch (error) {
      return placeholderFrom({
        code: 'PDF_FILE_NOT_FOUND',
        message: this.toMessage(error),
      });
    }

    try {
      const result = await this.ingestPdfSource({
        workspaceId,
        nodeId,
        artifactUri,
        filePath,
        title,
      });
      return {
        sourceId: result.source.source_id,
        success: true,
        title: result.source.title ?? undefined,
      };
    } catch (error) {
      return placeholderFrom({
        code: 'PDF_PARSE_FAILED',
        message: this.toMessage(error),
      });
    }
  }

  private extractArtifactFilename(artifactUri: string): string {
    if (!artifactUri) return '';

    const artifactPath = (() => {
      try {
        return new URL(artifactUri).pathname;
      } catch {
        return artifactUri;
      }
    })();

    const rawFilename = artifactPath.split('/').pop();
    const filename = rawFilename ? path.basename(rawFilename) : '';
    return filename;
  }

  /**
   * Create or update source record based on whether it exists
   */
  private createOrUpdateSource(params: {
    sourceId: string;
    existingSource: SourceRow | null;
    workspaceId: string;
    type: SourceType;
    title?: string;
    uri?: string;
    contentText: string | undefined;
    contentHash: string;
    metadata?: SourceMetadata;
  }): { source: SourceRow; isNew: boolean } {
    const {
      sourceId,
      existingSource,
      workspaceId,
      type,
      title,
      uri,
      contentText,
      contentHash,
      metadata,
    } = params;

    if (existingSource) {
      // Update existing source
      const source = this.repository.updateSource(sourceId, {
        contentText,
        contentHash,
        title,
        metadata,
      });
      return { source, isNew: false };
    } else {
      // Create new source
      const source = this.repository.createSource({
        sourceId,
        workspaceId,
        type,
        title,
        uri,
        contentText,
        contentHash,
        metadata,
      });
      return { source, isNew: true };
    }
  }

  /**
   * Ingest Text/Note source (editable types)
   *
   * Strategy:
   * - Check if source exists (by sourceId if provided)
   * - Compute content hash
   * - If hash unchanged, return existing source (no new revision)
   * - If hash changed or new source:
   *   - Create/update source record
   *   - Create new revision record
   *
   * @param input - Ingestion input
   * @returns Ingestion result
   */
  async ingestTextSource(
    input: IngestTextSourceInput,
  ): Promise<IngestSourceResult> {
    const contentHash = computeContentHash(input.content);

    // Determine sourceId
    const sourceId =
      input.existingSourceId ??
      generateSourceId({
        workspaceId: input.workspaceId,
        type: input.type,
      });

    // Check if source already exists
    const existingSource = this.repository.findSourceById(sourceId);

    // Check if content actually changed
    if (existingSource && existingSource.content_hash === contentHash) {
      // Content unchanged, no need to create new revision
      return {
        source: existingSource,
        isNew: false,
        contentChanged: false,
      };
    }

    // Use transaction for atomic source + revision creation
    const result = this.repository.transaction(() => {
      // Create or update source
      const { source, isNew } = this.createOrUpdateSource({
        sourceId,
        existingSource,
        workspaceId: input.workspaceId,
        type: input.type,
        title: input.title,
        contentText: input.content,
        contentHash,
        metadata: input.metadata,
      });

      // Create new revision (for editable types, always track history)
      const revisionId = generateRevisionId();
      this.repository.createRevision({
        revisionId,
        workspaceId: input.workspaceId,
        sourceId,
        contentText: input.content,
        contentHash,
        metadata: input.metadata,
      });

      return { source, revisionId, isNew };
    });

    return {
      ...result,
      contentChanged: true,
    };
  }

  /**
   * Ingest Web source (non-editable type)
   *
   * Strategy:
   * - Try to use pre-fetched content from frontend first
   * - Fallback to backend fetch if no content provided
   * - Generate deterministic sourceId from URI
   * - Check if source already exists (deduplication)
   * - Create/update source (no revisions for web)
   *
   * @param input - Ingestion input
   * @returns Ingestion result
   */
  async ingestWebSource(
    input: IngestWebSourceInput,
  ): Promise<IngestSourceResult> {
    // Normalize URI for consistent sourceId generation
    const normalizedUri = normalizeUrl(input.uri);

    // Generate deterministic sourceId
    const sourceId = generateSourceId({
      workspaceId: input.workspaceId,
      type: 'web',
      uri: normalizedUri,
    });

    const snapshot = await getWebSnapshot({
      uri: input.uri,
      content: input.content,
      title: input.title,
      metadata: (input.metadata ?? {}) as Record<string, unknown>,
      format: 'markdown',
    });

    const content = snapshot.content;
    const title = snapshot.title;
    const metadata = snapshot.metadata as SourceMetadata;

    const contentHash = computeContentHash(content);

    // Check if source already exists with same content
    const existingSource = this.repository.findSourceById(sourceId);
    if (existingSource && existingSource.content_hash === contentHash) {
      // Content unchanged, no need to update
      return {
        source: existingSource,
        isNew: false,
        contentChanged: false,
      };
    }

    // Store web markdown in DB to avoid any runtime refetch/IO.
    const contentText = content;

    // Create or update source
    const { source, isNew } = this.createOrUpdateSource({
      sourceId,
      existingSource,
      workspaceId: input.workspaceId,
      type: 'web',
      title,
      uri: normalizedUri,
      contentText,
      contentHash,
      metadata,
    });

    return {
      source,
      isNew,
      contentChanged: true,
    };
  }

  /**
   * Ingest PDF source (non-editable type)
   *
   * Strategy:
   * - Parse PDF file to extract text content
   * - Generate deterministic sourceId from file content hash
   * - Check if source already exists (deduplication)
   * - Create/update source (no revisions for PDF)
   *
   * @param input - Ingestion input
   * @returns Ingestion result
   */
  async ingestPdfSource(
    input: IngestPdfSourceInput,
  ): Promise<IngestSourceResult> {
    // Parse PDF file to extract text
    const parseResult = await parsePdfFile(input.filePath);
    if (!parseResult.success || !parseResult.text) {
      throw new Error(
        `Failed to parse PDF file: ${parseResult.error || 'No text extracted'}`,
      );
    }

    const content = parseResult.text;
    const contentHash = computeContentHash(content);

    // Generate deterministic sourceId from workspace + file content hash
    const sourceId = generateSourceId({
      workspaceId: input.workspaceId,
      type: 'pdf',
      fileHash: contentHash,
    });

    // Check if source already exists with same content
    const existingSource = this.repository.findSourceById(sourceId);
    if (existingSource && existingSource.content_hash === contentHash) {
      // Content unchanged, no need to update
      return {
        source: existingSource,
        isNew: false,
        contentChanged: false,
      };
    }

    // Use parsed title or fallback to input title
    const title = parseResult.title || input.title;

    // Merge metadata with PDF info
    const metadata = {
      ...input.metadata,
      numPages: parseResult.numPages,
      originalArtifactUri: input.artifactUri,
    };

    // Create or update source
    const { source, isNew } = this.createOrUpdateSource({
      sourceId,
      existingSource,
      workspaceId: input.workspaceId,
      type: 'pdf',
      title,
      uri: input.artifactUri,
      contentText: content,
      contentHash,
      metadata,
    });

    return {
      source,
      isNew,
      contentChanged: true,
    };
  }

  /**
   * Batch ingest multiple sources
   * Useful for processing selectedNodeIds in bulk
   */
  async ingestTextSourcesBatch(
    inputs: IngestTextSourceInput[],
  ): Promise<IngestSourceResult[]> {
    // Process sequentially for now to maintain transaction safety
    // Could be parallelized with careful transaction handling
    const results: IngestSourceResult[] = [];
    for (const input of inputs) {
      const result = await this.ingestTextSource(input);
      results.push(result);
    }
    return results;
  }

  /**
   * Get source with latest revision content
   * Useful for building LLM context
   */
  getSourceWithLatestRevision(sourceId: string): {
    source: SourceRow;
    latestRevision?: {
      revisionId: string;
      content: string;
      createdAt: number;
    };
  } | null {
    const source = this.repository.findSourceById(sourceId);
    if (!source) return null;

    // For editable types, get latest revision
    if (source.type === 'note' || source.type === 'text') {
      const revision = this.repository.findLatestRevision(sourceId);
      if (revision) {
        return {
          source,
          latestRevision: {
            revisionId: revision.revision_id,
            content: revision.content_text,
            createdAt: revision.created_at,
          },
        };
      }
    }

    // For non-editable types or if no revision, use source content
    return {
      source,
      latestRevision: source.content_text
        ? {
            revisionId: 'current', // Placeholder for non-revisioned types
            content: source.content_text,
            createdAt: source.updated_at,
          }
        : undefined,
    };
  }
}

/**
 * Singleton instance
 */
let serviceInstance: IngestService | null = null;

/**
 * Reset the cached IngestService singleton.
 * Called when the storage backend config changes so that the next call
 * to getIngestService() creates a fresh instance with the new repository.
 */
export function resetIngestService(): void {
  serviceInstance = null;
}

export async function getIngestService(): Promise<IngestService> {
  if (!serviceInstance) {
    const repository = await getKnowledgeRepository();
    serviceInstance = new IngestService(repository);
  }
  return serviceInstance;
}
