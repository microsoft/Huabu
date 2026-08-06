// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stage 1 — Input Resolve
 *
 * Converts raw node snapshot data into a canonical `ResolvedInput` structure.
 * No external calls, no LLM, no persistence.
 *
 * Artifact-backed nodes record the blob *name* only. Turning that into a
 * readable path is I/O, so the pipeline does it (and releases it) around
 * this pure stage.
 */

import path from 'node:path';

import { normalizeUrl } from '../utils.js';

import type { ResolvedInput } from '../types.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

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

export function inputResolve(request: PreprocessNodeRequest): ResolvedInput {
  const { nodeId, nodeType, snapshot } = request;
  const base: ResolvedInput = {
    nodeId,
    nodeType,
    title: snapshot.title as string | undefined,
    labelSource: snapshot.labelSource as string | undefined,
  };

  switch (nodeType) {
    case 'note':
    case 'text':
    case 'question': {
      return {
        ...base,
        content: (snapshot.content as string) ?? '',
      };
    }

    case 'web': {
      const src = ((snapshot.src as string) ?? '').trim();
      // A web node's `src` can be one of three things:
      //   1. Remote URL (`http(s)://`) — fetched + Readability-extracted.
      //   2. `data:` URL — AI-generated HTML snippet baked into the src
      //      itself. Self-contained; Node's native `fetch()` supports
      //      `data:` URLs out of the box, so we route through the same
      //      remote-URL path. `normalizeUrl` is bypassed because URL
      //      normalisation is meaningless (and lossy) for data URLs.
      //   3. Local artifact key (e.g. `art_abc.html`) — uploaded by the
      //      user; the pipeline materializes it so extract() can read it.
      const isRemoteUrl = /^https?:\/\//i.test(src);
      if (isRemoteUrl) {
        return {
          ...base,
          normalizedUri: src ? normalizeUrl(src) : undefined,
          prefetchedContent: snapshot.content as string | undefined,
        };
      }
      const isDataUrl = /^data:/i.test(src);
      if (isDataUrl) {
        return {
          ...base,
          normalizedUri: src,
        };
      }
      return {
        ...base,
        artifactUri: src || undefined,
        artifactName: extractArtifactFilename(src) || undefined,
      };
    }

    case 'pdf':
    case 'office': {
      const src = ((snapshot.src as string) ?? '').trim();
      return {
        ...base,
        artifactUri: src || undefined,
        artifactName: extractArtifactFilename(src) || undefined,
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
