import { getKnowledgeRepository } from './knowledge.repository.js';

/**
 * Source with its content for context building
 */
export interface SourceWithContent {
  sourceId: string;
  type: 'web' | 'pdf' | 'note' | 'text';
  title?: string;
  src?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Build LLM context from selected source IDs
 *
 * Loads sources from the knowledge store and formats them into a
 * structured context string suitable for LLM consumption.
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

  const repository = await getKnowledgeRepository();
  const sources: SourceWithContent[] = [];

  for (const sourceId of sourceIds) {
    const source = repository.findSourceById(sourceId);
    if (!source) {
      // Source not found, skip
      continue;
    }

    sources.push({
      sourceId: source.sourceId,
      type: source.type as 'web' | 'pdf' | 'note' | 'text',
      title: source.title ?? undefined,
      src: source.src ?? undefined,
      content: source.content,
      metadata: includeMetadata ? parseMetadata(source.metaJson) : undefined,
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

    if (source.src) {
      lines.push(`  src: ${source.src}`);
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
