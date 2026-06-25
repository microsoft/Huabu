import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ARTIFACT_URL_REGEX } from '@sediment/shared';

import { getLogger } from '../../utils/logger.js';
import { IMAGE_MIME_MAP } from '../../utils/mime.js';

const log = getLogger('artifact');

// Re-export the canonical wire helpers so existing server-side imports
// (`./utils.js`) keep working without each call site reaching into the
// shared package directly.
export { ARTIFACT_URL_REGEX, artifactApiPath } from '@sediment/shared';

/**
 * Resolve an artifact image URL to a base64 data URL.
 *
 * Three input shapes are recognised:
 *
 *   1. Bare artifact key (`<artifactId><ext>`) — combined with
 *      `defaultCanvasId` to locate the file. This is the canonical form
 *      that the front-end persists in `data.src` after the bare-key
 *      migration.
 *   2. Full canvas-scoped URL (`/api/canvas/<id>/artifact/<key>`) —
 *      `canvasId` is read directly from the URL. Legacy data, but still
 *      flowing in from external sources / older clients.
 *   3. Anything else (data: URLs, absolute http(s) URLs, unrelated
 *      paths) — returned verbatim.
 *
 * The `resolvePath` callback may return `null` to signal that the URL
 * key has no matching stored artifact (e.g. a stale URL after the file
 * was deleted), in which case the original URL is returned unchanged.
 */
export async function resolveArtifactImageUrl(
  url: string,
  resolvePath: (canvasId: string, filename: string) => string | null,
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

  const filePath = resolvePath(canvasId, filename);
  if (!filePath) return url;

  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = IMAGE_MIME_MAP[ext] ?? 'image/png';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    log.warn({ err, filePath }, 'Failed to read artifact');
    return url;
  }
}
