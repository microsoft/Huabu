// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Serve a blob over HTTP.
 *
 * Replaces `reply.sendFile()` on the artifact route now that bytes come
 * from the {@link BlobScope} port instead of a directory. `sendFile`
 * supplied conditional requests and byte ranges for free; dropping them
 * would make every canvas load re-download its images and would break
 * seeking in video and audio nodes, so both are reimplemented here against
 * the port.
 *
 * Backend-independent by construction: it uses only `head()` and ranged
 * `open()`, so it works unchanged against a remote blob backend.
 */

import { Readable } from 'node:stream';

import { getMimeType } from '../../utils/mime.js';

import type { BlobInfo, BlobScope } from '../storage/index.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** `bytes=<start>-<end>`, the only form browsers send for media seeking. */
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

interface ResolvedRange {
  start: number;
  end: number;
}

const CACHE_CONTROL = 'public, max-age=0';

/**
 * Resolve a `Range` header against a known size.
 *
 * Returns `null` when there is no usable range (absent, malformed, or a
 * form we don't support) so the caller serves the whole blob, and
 * `'unsatisfiable'` when the client asked for bytes that don't exist.
 */
export function resolveRange(
  header: string | undefined,
  size: number,
): ResolvedRange | null | 'unsatisfiable' {
  if (!header) return null;
  const match = RANGE_RE.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    // `bytes=-N` — the final N bytes.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** Weak validator — size and mtime are all any backend reliably exposes. */
function etagFor(info: BlobInfo): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.updatedAt).toString(16)}"`;
}

function matchesEtagList(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === etag || `W/${tag}` === etag;
  });
}

function preconditionFailed(
  request: FastifyRequest,
  lastModified: string,
  etag: string,
): boolean {
  const ifMatch = request.headers['if-match'];
  if (ifMatch && !matchesEtagList(ifMatch, etag)) return true;

  const ifUnmodifiedSince = request.headers['if-unmodified-since'];
  if (ifUnmodifiedSince) {
    const since = Date.parse(ifUnmodifiedSince);
    if (!Number.isNaN(since) && Date.parse(lastModified) > since) return true;
  }
  return false;
}

function isFresh(
  request: FastifyRequest,
  info: BlobInfo,
  etag: string,
): boolean {
  if (request.headers['cache-control']?.includes('no-cache')) return false;

  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch) {
    return matchesEtagList(ifNoneMatch, etag);
  }

  const ifModifiedSince = request.headers['if-modified-since'];
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have one-second resolution, so compare at that grain.
    if (!Number.isNaN(since)) {
      return Math.floor(info.updatedAt / 1000) * 1000 <= since;
    }
  }
  return false;
}

function isRangeFresh(
  header: string | string[] | undefined,
  lastModified: string,
  etag: string,
): boolean {
  const ifRange = Array.isArray(header) ? header[0] : header;
  if (!ifRange) return true;
  if (ifRange.includes('"')) return ifRange.includes(etag);

  const since = Date.parse(ifRange);
  return !Number.isNaN(since) && Date.parse(lastModified) <= since;
}

function contentTypeFor(name: string): string {
  const type = getMimeType(name);
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/javascript'
  ) {
    return `${type}; charset=utf-8`;
  }
  return type;
}

/**
 * Stream one blob to the client, honouring conditional requests and byte
 * ranges. Returns false when the blob is absent so the caller can 404.
 */
export async function sendBlob(
  request: FastifyRequest,
  reply: FastifyReply,
  blobs: BlobScope,
  name: string,
): Promise<boolean> {
  const info = await blobs.head(name);
  if (!info) return false;

  const etag = etagFor(info);
  const lastModified = new Date(info.updatedAt).toUTCString();
  // Validators apply to every outcome, including 304. The blob's own
  // Content-Type is set only on the paths that actually send its bytes —
  // setting it up front would make Fastify try to serialize the 416 JSON
  // body as an image.
  reply
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', CACHE_CONTROL)
    .header('ETag', etag)
    .header('Last-Modified', lastModified)
    .header('X-Content-Type-Options', 'nosniff');

  if (preconditionFailed(request, lastModified, etag)) {
    await reply.code(412).send({ message: 'Precondition failed' });
    return true;
  }

  if (isFresh(request, info, etag)) {
    await reply.code(304).send();
    return true;
  }

  const range = resolveRange(
    isRangeFresh(request.headers['if-range'], lastModified, etag)
      ? request.headers['range']
      : undefined,
    info.size,
  );

  if (range === 'unsatisfiable') {
    await reply
      .code(416)
      .header('Content-Range', `bytes */${info.size}`)
      .send({ message: 'Requested range not satisfiable' });
    return true;
  }

  const contentType = contentTypeFor(info.name);

  if (range) {
    if (request.method === 'HEAD') {
      await reply
        .code(206)
        .header('Content-Type', contentType)
        .header(
          'Content-Range',
          `bytes ${range.start}-${range.end}/${info.size}`,
        )
        .header('Content-Length', String(range.end - range.start + 1))
        .send(Readable.from([]));
      return true;
    }
    const opened = await blobs.open(name, range);
    if (!opened) return false;
    await reply
      .code(206)
      .header('Content-Type', contentType)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
      .header('Content-Length', String(range.end - range.start + 1))
      .send(opened.body);
    return true;
  }

  if (request.method === 'HEAD') {
    await reply
      .header('Content-Type', contentType)
      .header('Content-Length', String(info.size))
      .send(Readable.from([]));
    return true;
  }
  const opened = await blobs.open(name);
  if (!opened) return false;
  await reply
    .header('Content-Type', contentType)
    .header('Content-Length', String(info.size))
    .send(opened.body);
  return true;
}
