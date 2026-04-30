export interface LoadResult {
  content: string;
  metadata?: Record<string, unknown>;
  title?: string;
}

export interface IDocumentLoader {
  /**
   * Check if this loader supports the given source type
   */
  supports(sourceType: string): boolean;

  /**
   * Load content from the source
   * @param source - The source to load from (file path, URL, or content string)
   * @param options - Optional loader-specific options
   */
  load(
    source: string | Buffer,
    options?: Record<string, unknown>,
  ): Promise<LoadResult>;
}
