import { getKnowledgeRepository } from './knowledge.repository.js';

import type { SourceRow, SourceRevisionRow } from './types.js';

/**
 * Source with its content for context building
 */
export interface SourceWithContent {
  sourceId: string;
  type: 'web' | 'pdf' | 'note' | 'text';
  title?: string;
  uri?: string;
  content: string;
  revisionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Build LLM context from selected source IDs
 *
 * This is a simplified v1 implementation that:
 * 1. Loads sources from knowledge DB
 * 2. For Note/Text, gets latest revision
 * 3. Truncates content to avoid prompt overflow
 * 4. Returns formatted context string
 *
 * v2 will add vector retrieval with chunking
 *
 * @param sourceIds - Array of source IDs to include in context
 * @param options - Optional configuration
 * @returns Formatted context string for LLM
 */
export async function buildContext(
  sourceIds: string[],
  options: {
    includeMetadata?: boolean;
  } = {},
): Promise<{
  context: string;
  sources: SourceWithContent[];
}> {
  const { includeMetadata = false } = options;

  const repository = getKnowledgeRepository();
  const sources: SourceWithContent[] = [];

  for (const sourceId of sourceIds) {
    const source = repository.findSourceById(sourceId);
    if (!source) {
      // Source not found, skip
      continue;
    }

    let content = '';
    let revisionId: string | undefined;

    // For Note/Text, get latest revision
    if (source.type === 'note' || source.type === 'text') {
      const revision = repository.findLatestRevision(sourceId);
      if (revision) {
        content = getContentFromRow(revision);
        revisionId = revision.revision_id;
      } else {
        // No revision found, use source content (shouldn't happen normally)
        content = getContentFromRow(source);
      }
    } else {
      // For Web/PDF, use source content directly
      content = getContentFromRow(source);
    }

    sources.push({
      sourceId: source.source_id,
      type: source.type as 'web' | 'pdf' | 'note' | 'text',
      title: source.title ?? undefined,
      uri: source.uri ?? undefined,
      content,
      revisionId,
      metadata: includeMetadata ? parseMetadata(source.meta_json) : undefined,
    });
  }

  // Format context string
  const context = formatContextString(sources);

  return {
    context,
    sources,
  };
}

/**
 * Get content from source or revision row
 * Handles both content_text and content_artifact_uri
 */
function getContentFromRow(row: SourceRow | SourceRevisionRow): string {
  if (row.content_text) {
    return row.content_text;
  }

  if (row.content_artifact_uri) {
    // TODO: Implement artifact retrieval
    return '[Content stored in artifact store - retrieval not yet implemented]';
  }

  return '';
}

/**
 * Parse JSON metadata safely
 */
function parseMetadata(
  metaJson: string | null,
): Record<string, unknown> | undefined {
  if (!metaJson) return undefined;

  try {
    return JSON.parse(metaJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Format sources into context string for LLM
 *
 * Format (conceptual):
 * ## SELECTED SOURCES
 *
 * - sourceId: src_123
 *   type: note
 *   title: Example Note
 *   content: ...
 *
 * - sourceId: src_456
 *   type: web
 *   title: Example Website
 *   uri: https://example.com
 *   content: ...
 */
function formatContextString(sources: SourceWithContent[]): string {
  if (sources.length === 0) {
    return '';
  }

  const lines: string[] = ['## SELECTED SOURCES', ''];

  for (const source of sources) {
    lines.push(`- sourceId: ${source.sourceId}`);
    lines.push(`  type: ${source.type}`);

    if (source.title) {
      lines.push(`  title: ${source.title}`);
    }

    if (source.uri) {
      lines.push(`  uri: ${source.uri}`);
    }

    if (source.revisionId) {
      lines.push(`  revisionId: ${source.revisionId}`);
    }

    // Add content with proper indentation
    const contentLines = source.content.split('\n');
    lines.push('  content: |');
    for (const line of contentLines) {
      lines.push(`    ${line}`);
    }

    lines.push(''); // Empty line between sources
  }

  return lines.join('\n');
}
