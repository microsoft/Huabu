// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared utilities for detecting media types and handling file/URL classification.
 * Used by CanvasToolbar (link/file upload) and Canvas (paste/drop).
 */

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov'];
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga'];
const WEB_EXTS = ['html', 'htm', 'mhtml'];
const OFFICE_EXTS = ['docx', 'pptx', 'xlsx'];

/** Map an Office file extension onto the canonical `OfficeFormat` value. */
export const detectOfficeFormat = (
  filename: string,
): 'docx' | 'pptx' | 'xlsx' | null => {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'xlsx') return 'xlsx';
  return null;
};

/**
 * URL patterns for services that serve PDF content directly but without a
 * `.pdf` file extension (e.g. arXiv abstract/PDF endpoints).
 */
const PDF_URL_PATTERNS: RegExp[] = [
  // arXiv: https://arxiv.org/pdf/<id> or https://arxiv.org/pdf/<id>v<n>
  /^https?:\/\/arxiv\.org\/pdf\//i,
];

type FileNodeType =
  | 'image'
  | 'pdf'
  | 'office'
  | 'video'
  | 'audio'
  | 'note'
  | 'web';

/** Classify a name by its extension; `null` when the extension is unknown. */
const detectTypeFromExtension = (name: string): FileNodeType | null => {
  const ext = name.split('.').pop()?.toLowerCase();

  if (!ext) return null;
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXTS.includes(ext)) return 'office';
  if (ext === 'md' || ext === 'markdown') return 'note';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  // Local .html / .htm files and saved .mhtml snapshots are surfaced as web
  // nodes — the uploader stores them as an artifact and the preprocessing
  // pipeline extracts their content the same way it does for remote URLs.
  if (WEB_EXTS.includes(ext)) return 'web';
  return null;
};

/** Classify a MIME type; `null` when no node type renders it. */
const detectTypeFromMime = (mimeType: string): FileNodeType | null => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/markdown') return 'note';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'text/html') return 'web';
  // Modern Office (OOXML) MIME types.
  if (
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'office';
  }
  return null;
};

/**
 * Classify a URL into a canvas node type based on file extension.
 * Strips query strings and hashes before checking.
 * Also matches known PDF-serving URL patterns for extensionless PDF URLs.
 * Anything unrecognised is a web page; so is a remote audio file, because
 * an audio node only plays an uploaded artifact.
 */
export const detectNodeType = (
  url: string,
): 'image' | 'pdf' | 'office' | 'video' | 'note' | 'web' => {
  if (PDF_URL_PATTERNS.some((pattern) => pattern.test(url))) return 'pdf';
  const type = detectTypeFromExtension(url.split('?')[0].split('#')[0]);
  return !type || type === 'audio' ? 'web' : type;
};

/**
 * Classify a local file into a canvas node type, or `null` when no node
 * type can hold it. MIME wins; the filename decides when the MIME is absent
 * or unrecognised (e.g. `.md` reported as `text/plain`).
 */
export const detectFileNodeType = (
  file: Pick<File, 'name' | 'type'>,
): FileNodeType | null =>
  detectTypeFromMime(file.type) ?? detectTypeFromExtension(file.name);

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

/**
 * Get intrinsic dimensions of a video from a Blob/File.
 *
 * Only the container metadata is needed, hence `preload = 'metadata'`.
 * Callers use this to size a new video node to the real aspect ratio —
 * without it the node falls back to the generic 4:3 default.
 */
export const getVideoDimensionsFromBlob = (
  blob: Blob,
): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load video'));
    };
    video.src = url;
  });
