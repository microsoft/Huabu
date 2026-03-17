/**
 * Centralized MIME type mappings used throughout the server.
 *
 * Avoids duplicating extension ↔ MIME maps in every route / utility.
 */

// ---------------------------------------------------------------------------
// Extension → MIME (images only)
// ---------------------------------------------------------------------------

/** Common image extension → MIME type mapping. */
export const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

// ---------------------------------------------------------------------------
// Extension → MIME (all media – images + documents + video)
// ---------------------------------------------------------------------------

/** Extended extension → MIME type mapping (images, documents, video). */
export const MEDIA_MIME_MAP: Record<string, string> = {
  ...IMAGE_MIME_MAP,
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

// ---------------------------------------------------------------------------
// MIME → Extension (images, for reverse lookup)
// ---------------------------------------------------------------------------

/** Image MIME type → extension mapping (reverse of IMAGE_MIME_MAP). */
export const IMAGE_EXT_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Get the MIME type for a filename / extension string.
 * Falls back to `application/octet-stream` when unknown.
 */
export function getMimeType(
  filename: string,
  fallback = 'application/octet-stream',
): string {
  const ext = filename.includes('.')
    ? `.${filename.split('.').pop()?.toLowerCase() ?? ''}`
    : filename.toLowerCase();
  return MEDIA_MIME_MAP[ext] ?? fallback;
}

/**
 * Get the file extension for an image MIME type.
 * Falls back to `.png` when unknown.
 */
export function getExtFromMime(mime: string, fallback = '.png'): string {
  return IMAGE_EXT_MAP[mime] ?? fallback;
}
