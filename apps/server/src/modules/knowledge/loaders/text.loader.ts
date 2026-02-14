import type { IDocumentLoader, LoadResult } from './loader.interface.js';

export class TextLoader implements IDocumentLoader {
  supports(sourceType: string): boolean {
    return sourceType === 'text' || sourceType === 'note';
  }

  async load(
    source: string | Buffer,
    options?: Record<string, unknown>,
  ): Promise<LoadResult> {
    if (typeof source !== 'string') {
      // In some cases we might read text from a file buffer, so we handle buffer too
      if (Buffer.isBuffer(source)) {
        return {
          content: source.toString('utf-8'),
          metadata: options?.metadata as Record<string, unknown> | undefined,
          title: options?.title as string | undefined,
        };
      }
      throw new Error(
        'Invalid source for Text loader. Expected string content or Buffer.',
      );
    }

    return {
      content: source,
      title: options?.title as string | undefined,
      metadata: options?.metadata as Record<string, unknown> | undefined,
    };
  }
}
