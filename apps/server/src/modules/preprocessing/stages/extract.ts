/**
 * Stage 2 — Extract
 *
 * Performs content extraction using existing document loaders.
 * No LLM, no persistence.
 */

import { DocumentLoaderFactory } from '../../knowledge/loaders/index.js';

import type { ResolvedInput, ExtractResult } from '../types.js';

export async function extract(resolved: ResolvedInput): Promise<ExtractResult> {
  const { nodeType } = resolved;

  // Node types without textual extraction
  if (nodeType === 'image' || nodeType === 'frame') {
    return { skipped: true };
  }

  // note / text — use TextLoader
  if (nodeType === 'note' || nodeType === 'text') {
    const content = resolved.content ?? '';
    if (content.trim().length === 0) {
      return { content: '', skipped: true };
    }
    const loader = DocumentLoaderFactory.getLoader(nodeType);
    const result = await loader.load(content, { title: resolved.title });
    return {
      content: result.content,
      title: result.title,
      metadata: result.metadata,
    };
  }

  // web — use WebLoader
  if (nodeType === 'web') {
    const src = resolved.normalizedUri;
    if (!src) {
      throw new Error('Missing URI for web source extraction');
    }
    const loader = DocumentLoaderFactory.getLoader('web');
    const result = await loader.load(src, {
      content: resolved.prefetchedContent,
      title: resolved.title,
    });
    return {
      content: result.content,
      title: result.title,
      metadata: result.metadata,
    };
  }

  // pdf — use PdfLoader
  if (nodeType === 'pdf') {
    const filePath = resolved.filePath;
    if (!filePath) {
      throw new Error('Missing file path for PDF source extraction');
    }
    const loader = DocumentLoaderFactory.getLoader('pdf');
    const result = await loader.load(filePath);
    return {
      content: result.content,
      title: result.title,
      metadata: result.metadata,
    };
  }

  // video — future: YoutubeLoader
  if (nodeType === 'video') {
    return { skipped: true };
  }

  return { skipped: true };
}
