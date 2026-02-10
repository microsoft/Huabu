import { getKnowledgeRepository } from './knowledge.repository.js';
import { parsePdfFile } from './pdf-parser.js';
import {
  computeContentHash,
  generateRevisionId,
  generateSourceId,
  normalizeUrl,
  shouldUseArtifactStorage,
} from './utils.js';
import { fetchWebContent } from './web-fetcher.js';

import type { KnowledgeRepository } from './knowledge.repository.js';
import type { SourceMetadata, SourceRow } from './types.js';

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

/**
 * Service layer for knowledge source ingestion
 * Handles business logic for creating/updating sources and revisions
 */
export class IngestService {
  constructor(private repository: KnowledgeRepository) {}

  /**
   * Prepare storage strategy for content
   * Returns either inline text or artifact URI based on content size
   */
  private prepareStorageStrategy(content: string): {
    contentText: string | undefined;
    contentArtifactUri: string | undefined;
  } {
    const useArtifact = shouldUseArtifactStorage(content);

    if (useArtifact) {
      // TODO: Implement artifact storage
      throw new Error(
        'Artifact storage not yet implemented. Content size exceeds 1MB.',
      );
    }

    return {
      contentText: content,
      contentArtifactUri: undefined,
    };
  }

  /**
   * Create or update source record based on whether it exists
   */
  private createOrUpdateSource(params: {
    sourceId: string;
    existingSource: SourceRow | null;
    workspaceId: string;
    type: string;
    title?: string;
    uri?: string;
    contentText: string | undefined;
    contentArtifactUri: string | undefined;
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
      contentArtifactUri,
      contentHash,
      metadata,
    } = params;

    if (existingSource) {
      // Update existing source
      const source = this.repository.updateSource(sourceId, {
        contentText,
        contentArtifactUri,
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
        contentArtifactUri,
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

    // Prepare storage strategy
    const { contentText, contentArtifactUri } = this.prepareStorageStrategy(
      input.content,
    );

    // Use transaction for atomic source + revision creation
    const result = this.repository.transaction(() => {
      // Create or update source
      const { source, isNew } = this.createOrUpdateSource({
        sourceId,
        existingSource,
        workspaceId: input.workspaceId,
        type: input.type,
        title: input.title,
        contentText,
        contentArtifactUri,
        contentHash,
        metadata: input.metadata,
      });

      // Create new revision (for editable types, always track history)
      const revisionId = generateRevisionId();
      this.repository.createRevision({
        revisionId,
        workspaceId: input.workspaceId,
        sourceId,
        contentText,
        contentArtifactUri,
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

    // Get or fetch content
    let content = input.content;
    let title = input.title;
    const metadata = input.metadata ?? {};

    if (!content) {
      // Backend fetch fallback
      const fetchResult = await fetchWebContent(input.uri);
      if (!fetchResult.success) {
        throw new Error(`Failed to fetch web content: ${fetchResult.error}`);
      }
      content = fetchResult.content ?? '';
      title = title ?? fetchResult.title;
    }

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

    // Prepare storage strategy
    const { contentText, contentArtifactUri } =
      this.prepareStorageStrategy(content);

    // Create or update source
    const { source, isNew } = this.createOrUpdateSource({
      sourceId,
      existingSource,
      workspaceId: input.workspaceId,
      type: 'web',
      title,
      uri: normalizedUri,
      contentText,
      contentArtifactUri,
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

    // Prepare storage strategy
    const { contentText, contentArtifactUri } =
      this.prepareStorageStrategy(content);

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
      contentText,
      contentArtifactUri,
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
            content: revision.content_text ?? '', // TODO: handle artifact
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

export function getIngestService(): IngestService {
  if (!serviceInstance) {
    const repository = getKnowledgeRepository();
    serviceInstance = new IngestService(repository);
  }
  return serviceInstance;
}
