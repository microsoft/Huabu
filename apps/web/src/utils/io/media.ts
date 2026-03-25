/**
 * Shared utilities for detecting media types and handling file/URL classification.
 * Used by CanvasToolbar (link/file upload) and Canvas (paste/drop).
 */

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov'];

/**
 * URL patterns for services that serve PDF content directly but without a
 * `.pdf` file extension (e.g. arXiv abstract/PDF endpoints).
 */
const PDF_URL_PATTERNS: RegExp[] = [
  // arXiv: https://arxiv.org/pdf/<id> or https://arxiv.org/pdf/<id>v<n>
  /^https?:\/\/arxiv\.org\/pdf\//i,
];

/**
 * Classify a filename or URL into a canvas node type based on file extension.
 * Strips query strings and hashes before checking.
 * Also matches known PDF-serving URL patterns for extensionless PDF URLs.
 */
export const detectNodeType = (
  filename: string,
): 'image' | 'pdf' | 'video' | 'web' => {
  if (PDF_URL_PATTERNS.some((pattern) => pattern.test(filename))) return 'pdf';

  const cleanPath = filename.split('?')[0].split('#')[0];
  const ext = cleanPath.split('.').pop()?.toLowerCase();

  if (!ext) return 'web';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return 'web';
};

/**
 * Classify a MIME type string into a canvas node type.
 */
export const detectNodeTypeFromMime = (
  mimeType: string,
): 'image' | 'pdf' | 'video' | 'web' => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('video/')) return 'video';
  return 'web';
};

const URL_PATTERN =
  /^(https?:\/\/[^\s]+|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+([/?#][^\s]*)?)$/i;

/**
 * Check whether a trimmed line looks like a URL (http(s) or bare domain).
 */
export const looksLikeUrl = (text: string): boolean =>
  URL_PATTERN.test(text.trim());

/**
 * Normalise a URL string: prepend https:// if no protocol present.
 */
export const normalizeUrl = (url: string): string => {
  const trimmed = url.trim();
  return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
};

/**
 * Get natural dimensions of an image from a Blob/File.
 */
export const getImageDimensionsFromBlob = (
  blob: Blob,
): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
