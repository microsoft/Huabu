import type { IDocumentLoader, LoadResult } from './loader.interface.js';

/** Strip common inline Markdown formatting so the title reads as plain text. */
function stripInlineMarkdown(text: string): string {
  return (
    text
      // leading blockquote >
      .replace(/^(?:>\s*)+/, '')
      // leading list markers (- * + 1.)  — must run before bold/italic
      // so that `* **bold**` doesn't mis-pair the list `*` with bold.
      .replace(/^(?:[-*+]|\d+\.)\s+/, '')
      // images ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // links [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // bold / italic  ** __ * _
      .replace(/\*{1,3}(.+?)\*{1,3}/g, '$1')
      .replace(/_{1,3}(.+?)_{1,3}/g, '$1')
      // strikethrough ~~text~~
      .replace(/~~(.+?)~~/g, '$1')
      // inline code `code`
      .replace(/`(.+?)`/g, '$1')
      .trim()
  );
}

/** Extract a title from plain text or markdown content. */
function extractTitleFromText(content: string): string | undefined {
  const lines = content.split('\n');
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) return stripInlineMarkdown(heading[1]).slice(0, 50);
  }
  const firstLine = lines.find((l) => l.trim().length > 0)?.trim();
  return firstLine ? stripInlineMarkdown(firstLine).slice(0, 50) : undefined;
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
