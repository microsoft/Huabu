/**
 * Stage 1 — Input Resolve
 *
 * Converts raw node snapshot data into a canonical `ResolvedInput` structure.
 * No external calls, no LLM, no persistence.
 */

import path from 'node:path';

import { normalizeUrl } from '../utils.js';

import type { ResolvedInput } from '../types.js';
import type { PreprocessNodeRequest } from '@sediment/shared';

/**
 * Extract a bare filename from an artifact URI such as
 * `artifact://files/abc123.pdf` or a plain path segment.
 */
function extractArtifactFilename(artifactUri: string): string {
  if (!artifactUri) return '';
  const artifactPath = (() => {
    try {
      return new URL(artifactUri).pathname;
    } catch {
      return artifactUri;
    }
  })();
  const rawFilename = artifactPath.split('/').pop();
  return rawFilename ? path.basename(rawFilename) : '';
}

export function inputResolve(
  request: PreprocessNodeRequest,
  artifactsDir?: string,
): ResolvedInput {
  const { nodeId, nodeType, snapshot } = request;
  const base: ResolvedInput = {
    nodeId,
    nodeType,
    title: snapshot.title as string | undefined,
    labelSource: snapshot.labelSource as string | undefined,
  };

  switch (nodeType) {
    case 'note':
    case 'text': {
      return {
        ...base,
        content: (snapshot.content as string) ?? '',
      };
    }

    case 'web': {
      const src = ((snapshot.src as string) ?? '').trim();
      return {
        ...base,
        normalizedUri: src ? normalizeUrl(src) : undefined,
        prefetchedContent: snapshot.content as string | undefined,
      };
    }

    case 'pdf': {
      const src = ((snapshot.src as string) ?? '').trim();
      const filename = extractArtifactFilename(src);
      const filePath =
        filename && artifactsDir
          ? path.join(artifactsDir, filename)
          : undefined;
      return {
        ...base,
        artifactUri: src || undefined,
        filePath,
      };
    }

    case 'image': {
      return {
        ...base,
        imageSrc: (snapshot.src as string) || undefined,
      };
    }

    case 'video': {
      return {
        ...base,
        normalizedUri: (snapshot.src as string) || undefined,
      };
    }

    case 'frame': {
      return {
        ...base,
        childLabels: (snapshot.childLabels as string[]) ?? [],
      };
    }

    default:
      return base;
  }
}
