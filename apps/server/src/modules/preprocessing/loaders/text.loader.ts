// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { extractTitleFromText } from '../utils.js';

import type { IDocumentLoader, LoadResult } from './loader.interface.js';

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
