import type { IDocumentLoader, LoadResult } from './loader.interface.js';

/** Extract a title from plain text or markdown content. */
function extractTitleFromText(content: string): string | undefined {
  const lines = content.split('\n');
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) return heading[1].trim().slice(0, 50);
  }
  const firstLine = lines.find((l) => l.trim().length > 0)?.trim();
  return firstLine ? firstLine.slice(0, 50) : undefined;
}

export class TextLoader implements IDocumentLoader {
  supports(sourceType: string): boolean {
    return sourceType === 'text' || sourceType === 'note';
  }

  async load(
    source: string | Buffer,
    options?: Record<string, unknown>,
  ): Promise<LoadResult> {
    const text = typeof source === 'string' ? source : source.toString('utf-8');
    const extractedTitle = extractTitleFromText(text);

    return {
      content: text,
      title: extractedTitle ?? (options?.title as string | undefined),
      metadata: options?.metadata as Record<string, unknown> | undefined,
    };
  }
}
