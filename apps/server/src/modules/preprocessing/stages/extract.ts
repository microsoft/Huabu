// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stage 2 — Extract
 *
 * Performs content extraction using existing document loaders.
 * No LLM, no persistence.
 */

import { DocumentLoaderFactory } from '../loaders/index.js';

import type { ResolvedInput, ExtractResult } from '../types.js';

const REMOTE_URL_RE = /^https?:\/\//i;

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
    const loader = DocumentLoaderFactory.getLoader('web');
    // Local HTML artifact: pass the absolute file path through to the loader.
    if (resolved.filePath) {
      // Do NOT pass resolved.title — it may contain an auto-generated label
      // like "Web 1" which would shadow the real HTML <title>.
      const result = await loader.load(resolved.filePath);
      return {
        content: result.content,
        title: result.title,
        metadata: result.metadata,
        rawHtml: result.rawHtml,
      };
    }
    // Remote URL: hand off to the loader which fetches + Readability-extracts.
    const src = resolved.normalizedUri;
    if (!src) {
      throw new Error('Missing URI for web source extraction');
    }
    const result = await loader.load(src, {
      content: resolved.prefetchedContent,
    });
    return {
      content: result.content,
      title: result.title,
      metadata: result.metadata,
      rawHtml: result.rawHtml,
    };
  }

  // pdf — use PdfLoader
  if (nodeType === 'pdf') {
    const artifactUri = resolved.artifactUri;
    const filePath = resolved.filePath;

    // Handle remote PDF URLs (e.g. arXiv: https://arxiv.org/pdf/<id>)
    if (artifactUri && REMOTE_URL_RE.test(artifactUri)) {
      const response = await fetch(artifactUri);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch remote PDF: ${response.status} ${response.statusText}`,
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const loader = DocumentLoaderFactory.getLoader('pdf');
      const result = await loader.load(buffer);
      return {
        content: result.content,
        title: result.title,
        metadata: result.metadata,
        rawPdf: buffer,
      };
    }

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

  // office — use OfficeLoader (Word / Excel / PowerPoint)
  if (nodeType === 'office') {
    const filePath = resolved.filePath;
    if (!filePath) {
      throw new Error('Missing file path for Office source extraction');
    }
    // Derive the format hint from the file extension so the loader can
    // pick the right parser when magic-bytes detection is ambiguous.
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    const loader = DocumentLoaderFactory.getLoader('office');
    const result = await loader.load(filePath, { fileType: ext });
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
