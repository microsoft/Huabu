// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface LoadResult {
  content: string;
  metadata?: Record<string, unknown>;
  title?: string;
  /**
   * Raw payload as returned by the source (only populated by loaders
   * that fetch over the network and want downstream stages to persist
   * an unmodified snapshot). The web loader sets this to the original
   * HTML so the pipeline can write a one-shot `.mhtml` artifact.
   */
  rawHtml?: string;
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
