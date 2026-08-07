// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  '.avif': 'image/avif',
};

// ---------------------------------------------------------------------------
// Vision (LLM) support
// ---------------------------------------------------------------------------

/**
 * Image MIME types every vision-capable provider we target accepts.
 *
 * Anything outside this set (`image/svg+xml`, `image/bmp`, `image/avif`, …)
 * must never reach a model: the provider rejects the whole request with
 * `image media type not supported`, losing the user's entire turn rather
 * than just the one unusable image.
 */
export const VISION_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Whether image bytes of this MIME type can be sent as vision content. */
export function isVisionImageMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return VISION_IMAGE_MIME_TYPES.has(mime.split(';')[0].trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// resvg rasterization support
// ---------------------------------------------------------------------------

/**
 * Image extensions resvg can decode from an `<image href="data:...">` embed,
 * i.e. the source types `snapshot_nodes` can re-render or downscale.
 *
 * A strict subset of {@link VISION_IMAGE_MIME_TYPES}: anything a model
 * refuses is also something snapshotting cannot rescue, so `snapshot_nodes`
 * must never be offered as a recovery path for those.
 */
export const RASTERIZABLE_IMAGE_EXT_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/** Whether `snapshot_nodes` can rasterize source bytes of this MIME type. */
export function isRasterizableImageMime(
  mime: string | null | undefined,
): boolean {
  if (!mime) return false;
  const normalized = mime.split(';')[0].trim().toLowerCase();
  return Object.values(RASTERIZABLE_IMAGE_EXT_MIME).includes(normalized);
}

// ---------------------------------------------------------------------------
// Extension → MIME (all media – images + documents + video)
// ---------------------------------------------------------------------------

/**
 * Extended extension → MIME type mapping.
 *
 * Covers every type the artifact upload route accepts (image, pdf, video,
 * audio, html, office) plus the common variants a user's own filename can
 * carry. Anything outside the map falls back to `application/octet-stream`,
 * which browsers download rather than render — acceptable for a type the
 * app has no renderer for anyway.
 */
export const MEDIA_MIME_MAP: Record<string, string> = {
  ...IMAGE_MIME_MAP,
  '.pdf': 'application/pdf',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  // Markup / text
  '.html': 'text/html',
  '.htm': 'text/html',
  '.mhtml': 'message/rfc822',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  // Office
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
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
