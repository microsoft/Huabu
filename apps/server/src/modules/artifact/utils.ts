import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ARTIFACT_URL_REGEX } from '@sediment/shared';

import { IMAGE_MIME_MAP } from '../../utils/mime.js';

// Re-export the canonical wire helpers so existing server-side imports
// (`./utils.js`) keep working without each call site reaching into the
// shared package directly.
export { ARTIFACT_URL_REGEX, artifactApiPath } from '@sediment/shared';

/**
 * Resolve an artifact image URL to a base64 data URL.
 *
 * Local canvas-scoped artifact URLs are read from disk and converted to
 * inline data URLs so the LLM API can see them. Already-valid data URLs or
 * remote URLs are returned as-is. The `resolvePath` callback may return
 * `null` to signal that the URL key has no matching stored artifact (e.g.
 * a stale URL after the file was deleted), in which case the original URL
 * is returned unchanged.
 */
export async function resolveArtifactImageUrl(
  url: string,
  resolvePath: (canvasId: string, filename: string) => string | null,
): Promise<string> {
  if (url.startsWith('data:')) return url;

  const match = ARTIFACT_URL_REGEX.exec(url);
  if (!match) return url;

  const canvasId = match[1];
  const filename = path.basename(match[2]);
  const filePath = resolvePath(canvasId, filename);
  if (!filePath) return url;

  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = IMAGE_MIME_MAP[ext] ?? 'image/png';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.warn(`Failed to read artifact: ${filePath}`, err);
    return url;
  }
}
