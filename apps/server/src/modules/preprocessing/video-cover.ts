// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { extractYoutubeVideoId } from './loaders/youtube-id.js';
import { canonicalVideoSrc, videoArtifactKey } from './video-source.js';

import type { PipelineDeps } from './pipeline.js';
import type {
  PreprocessDiagnostic,
  ResolvedInput,
  VideoCoverReference,
} from './types.js';
import type { BlobLease } from '../storage/index.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/** Fixed public image endpoint only: no redirects, credentials, captions or paid API. */
export async function fetchYoutubeCover(videoId: string): Promise<Buffer> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId))
    throw new Error('Invalid YouTube video ID');
  for (const size of ['maxresdefault', 'hqdefault']) {
    const response = await fetch(
      `https://i.ytimg.com/vi/${videoId}/${size}.jpg`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) continue;
      throw new Error(`YouTube thumbnail returned ${response.status}`);
    }
    if (
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('image/jpeg') ||
      Number(response.headers.get('content-length')) > MAX_THUMBNAIL_BYTES
    ) {
      await response.body?.cancel();
      throw new Error('Invalid or oversized YouTube thumbnail');
    }
    if (!response.body) throw new Error('Empty YouTube thumbnail');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_THUMBNAIL_BYTES)
          throw new Error('Oversized YouTube thumbnail');
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length < 3 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    )
      throw new Error('Invalid JPEG thumbnail');
    return bytes;
  }
  throw new Error('YouTube thumbnail unavailable');
}

/** Prepare a reference; only Persist may accept it against the live source. */
export async function extractVideoCover(
  request: PreprocessNodeRequest,
  resolved: ResolvedInput,
  deps: PipelineDeps,
  leases: BlobLease[],
  diagnostics: PreprocessDiagnostic[],
): Promise<VideoCoverReference | undefined> {
  if (request.options?.allowPersistence === false) return undefined;
  const src = canonicalVideoSrc(request.snapshot.src, request.canvasId);
  try {
    const existing = (await deps.nodes.read(request.nodeId))?.record;
    if (
      !existing ||
      existing.type !== 'video' ||
      canonicalVideoSrc(existing.src, request.canvasId) !== src
    )
      return undefined;
    const cover =
      typeof existing.coverUrl === 'string'
        ? videoArtifactKey(existing.coverUrl, request.canvasId)
        : undefined;
    if (
      !request.options?.force &&
      cover &&
      canonicalVideoSrc(existing.coverSourceSrc, request.canvasId) === src &&
      (await deps.artifacts.head(cover))
    ) {
      return { coverUrl: cover, coverSourceSrc: src };
    }
    let bytes: Buffer;
    const youtubeId = extractYoutubeVideoId(src);
    if (youtubeId) {
      bytes = await fetchYoutubeCover(youtubeId);
    } else if (resolved.artifactName) {
      const lease = await deps.artifacts.materialize(resolved.artifactName);
      if (!lease) throw new Error('Video artifact is missing');
      leases.push(lease);
      const { extractLocalVideoCover } =
        await import('./video-cover-decoder.js');
      bytes = await extractLocalVideoCover(lease.path);
    } else {
      throw new Error(
        'Cover extraction supports local video artifacts and YouTube only; direct remote video is not fetched',
      );
    }
    const blob = await deps.artifacts.put(`cover_${randomUUID()}.jpg`, bytes);
    return { coverUrl: blob.name, coverSourceSrc: src };
  } catch (error) {
    diagnostics.push({
      code: 'VIDEO_COVER_FAILED',
      level: 'warning',
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
    // A failed replacement must not keep a cover from the previous source.
    return {};
  }
}
