import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Re-export artifact directory path from workspace module.
 */
export { getArtifactsDir } from '../workspace.js';

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Resolve an artifact image URL to a base64 data URL.
 * Local artifact URLs (e.g. http://localhost:3000/api/artifact/xxx.png) are
 * read from disk and converted to inline data URLs so the LLM API can see them.
 * Already-valid data URLs or remote URLs are returned as-is.
 */
export async function resolveArtifactImageUrl(
  url: string,
  artifactsDir: string,
): Promise<string> {
  if (url.startsWith('data:')) return url;

  // Match local artifact path: .../api/artifact/<filename>
  const artifactMatch = /\/api\/artifact\/([^/?#]+)/.exec(url);
  if (artifactMatch) {
    const filename = path.basename(artifactMatch[1]);
    const filePath = path.resolve(artifactsDir, filename);

    // Guard against path traversal
    if (!filePath.startsWith(path.resolve(artifactsDir))) {
      console.warn(`Blocked path traversal attempt: ${artifactMatch[1]}`);
      return url;
    }

    try {
      const buffer = await readFile(filePath);
      const ext = path.extname(filename).toLowerCase();
      const mime = MIME_MAP[ext] ?? 'image/png';
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (err) {
      console.warn(`Failed to read artifact: ${filePath}`, err);
      return url;
    }
  }

  // External URL — return as-is (may fail if not reachable by the LLM API)
  return url;
}
