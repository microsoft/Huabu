/**
 * Canvas-scoped artifact URL helpers.
 *
 * Pure runtime utilities — intentionally zod-free so the web bundle
 * can import them at runtime without dragging zod in. The matching
 * request schema (with zod) lives in `types/api/artifact.ts`.
 *
 * Canonical URL shape:
 *   `/api/canvas/<canvasId>/artifact/<key>`
 * where `<key>` is `<artifactId><ext>` (the on-disk filename).
 */

/**
 * Regex capturing `(canvasId, key)` from a canvas-scoped artifact URL.
 * Matches both relative paths and absolute URLs that embed the same path.
 */
export const ARTIFACT_URL_REGEX =
  /\/api\/canvas\/([^/?#]+)\/artifact\/([^/?#]+)/;

/** Build the canonical relative URL for a stored artifact. */
export function artifactApiPath(canvasId: string, filename: string): string {
  return `/api/canvas/${canvasId}/artifact/${filename}`;
}

/**
 * Parse a canvas-scoped artifact URL into its `(canvasId, key)` parts.
 * Returns `null` for unrelated URLs (data:, https://external, plain
 * paths). Accepts both relative paths and absolute URLs (the latter is
 * used by legacy data persisted with a hardcoded port).
 */
export function parseArtifactUrl(
  url: string,
): { canvasId: string; key: string } | null {
  if (!url || url.startsWith('data:')) return null;
  const match = ARTIFACT_URL_REGEX.exec(url);
  if (!match || !match[1] || !match[2]) return null;
  return { canvasId: match[1], key: match[2] };
}
