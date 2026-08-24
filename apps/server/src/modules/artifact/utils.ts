// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import { ARTIFACT_URL_REGEX } from '@huabu/shared';

import { getLogger } from '../../utils/logger.js';
import { IMAGE_MIME_MAP } from '../../utils/mime.js';
import { space } from '../storage/index.js';

const log = getLogger('artifact');

// Re-export the canonical wire helpers so existing server-side imports
// (`./utils.js`) keep working without each call site reaching into the
// shared package directly.
export { ARTIFACT_URL_REGEX, artifactApiPath } from '@huabu/shared';

/**
 * Resolve an artifact image URL to a base64 data URL.
 *
 * Three input shapes are recognised:
 *
 *   1. Bare artifact key (`<artifactId><ext>`) — combined with
 *      `defaultCanvasId` to locate the blob. This is the canonical form
 *      that the front-end persists in `data.src` after the bare-key
 *      migration.
 *   2. Full canvas-scoped URL (`/api/canvas/<id>/artifact/<key>`) —
 *      `canvasId` is read directly from the URL. Legacy data, but still
 *      flowing in from external sources / older clients.
 *   3. Anything else (data: URLs, absolute http(s) URLs, unrelated
 *      paths) — returned verbatim.
 *
 * A URL whose key has no stored blob (e.g. a stale reference after the
 * artifact was deleted) is returned unchanged.
 */
export async function resolveArtifactImageUrl(
  url: string,
  defaultCanvasId: string | null = null,
): Promise<string> {
  if (!url || url.startsWith('data:')) return url;

  let canvasId: string | null = null;
  let filename: string | null = null;

  const match = ARTIFACT_URL_REGEX.exec(url);
  if (match) {
    canvasId = match[1] ?? null;
    filename = path.basename(match[2] ?? '');
  } else if (defaultCanvasId && !/^https?:/i.test(url) && !url.includes('/')) {
    // Bare artifact key — pair it with the caller-supplied canvas id.
    canvasId = defaultCanvasId;
    filename = url;
  }

  if (!canvasId || !filename) return url;

  try {
    const buffer = await space(canvasId).blobs.read(filename);
    if (!buffer) return url;
    const ext = path.extname(filename).toLowerCase();
    // Never guess `image/png` for an unknown extension: callers forward this
    // MIME to the LLM, which sniffs the real bytes and rejects the whole
    // request when the declared type doesn't match.
    const mime = IMAGE_MIME_MAP[ext] ?? 'application/octet-stream';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    log.warn({ err, canvasId, filename }, 'Failed to read artifact');
    return url;
  }
}
