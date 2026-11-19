// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared node download resolution and execution helpers.
 *
 * Design invariants:
 *  - `data.label` is treated strictly as an optional human-readable filename
 *    stem hint — never as a storage path or file-extension authority.
 *  - File extensions always derive from the canonical stored artifact key,
 *    inline `data:` MIME type, or node format (`.md` for Note).
 *  - Stored artifacts preflight `?check=true` via `apiFetch` so 401/403/404
 *    failures surface as in-app error toasts, then stream via native browser /
 *    Electron attachment download (`?download=1&filename=…`) without buffering
 *    large media in JS heap memory.
 */

import i18next from 'i18next';

import { parseArtifactRef } from '@huabu/shared';

import { apiFetch, apiUrl } from '../../api/_client';
import { routes } from '../../api/_routes';
import { toast } from '../../components/Common/Toast';

// eslint-disable-next-line no-control-regex
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|\x00-\x1F]/g;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_STEM_LENGTH = 120;

const EQUIVALENT_EXT_GROUPS: ReadonlyArray<readonly string[]> = [
  ['.jpg', '.jpeg'],
  ['.htm', '.html'],
];

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'text/html': '.html',
  'application/xhtml+xml': '.xhtml',
  'message/rfc822': '.mhtml',
  'multipart/related': '.mhtml',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
};

export type MediaDownloadTarget =
  | {
      kind: 'artifact';
      canvasId: string;
      key: string;
      filename: string;
    }
  | {
      kind: 'data-url';
      dataUrl: string;
      filename: string;
    }
  | {
      kind: 'blob-url';
      blobUrl: string;
      filename: string;
    };

function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function extnameOf(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) return '';
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/i.test(ext) ? ext : '';
}

function stemOf(filename: string): string {
  const ext = extnameOf(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripMatchingExtension(rawName: string, canonicalExt: string): string {
  if (!canonicalExt) return rawName;
  const lowerExt = canonicalExt.toLowerCase();
  const group = EQUIVALENT_EXT_GROUPS.find((exts) => exts.includes(lowerExt));
  const candidates = group ?? [lowerExt];
  const lowerName = rawName.toLowerCase();
  for (const candidate of candidates) {
    if (lowerName.endsWith(candidate)) {
      return rawName.slice(0, -candidate.length);
    }
  }
  return rawName;
}

function sanitizeStem(raw: string, fallback: string): string {
  const clean = (input: string): string => {
    let safe = input
      .normalize('NFC')
      .replace(ILLEGAL_FILENAME_CHARS_RE, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (!safe) return '';
    if (WIN_RESERVED_RE.test(safe)) safe = `_${safe}`;
    return safe.length > MAX_STEM_LENGTH
      ? safe.slice(0, MAX_STEM_LENGTH)
      : safe;
  };
  return clean(raw) || clean(fallback) || 'download';
}

/**
 * Build a safe Save-As filename using `label` only as an optional stem hint
 * while strictly preserving `canonicalExt`.
 */
export function resolveDownloadFilename(
  label: string | undefined,
  canonicalExt: string,
  fallbackStem: string,
): string {
  const ext = normalizeExt(canonicalExt);
  const rawLabel = label?.trim() ?? '';
  const stripped = rawLabel ? stripMatchingExtension(rawLabel, ext) : '';
  const safeStem = sanitizeStem(stripped, fallbackStem);
  return `${safeStem}${ext}`;
}

function extensionFromDataUrl(dataUrl: string, fallbackExt: string): string {
  const commaIdx = dataUrl.indexOf(',');
  const header = commaIdx >= 0 ? dataUrl.slice(5, commaIdx) : dataUrl.slice(5);
  const mime = (header.split(';')[0] ?? '').trim().toLowerCase();
  return MIME_TO_EXT[mime] ?? normalizeExt(fallbackExt);
}

/** Decode a `data:` URL into a `Blob` without network/CSP `fetch` calls. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1 || !dataUrl.startsWith('data:')) {
    throw new Error('Malformed data URL');
  }
  const header = dataUrl.slice(5, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  const parts = header.split(';');
  const mime = parts[0] || 'application/octet-stream';
  const isBase64 = parts.some((part) => part.trim().toLowerCase() === 'base64');
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

/** Trigger a native browser/Electron download from an in-memory `Blob`. */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

export function officeDefaultExtension(format?: string): string {
  if (format === 'pptx') return '.pptx';
  if (format === 'xlsx') return '.xlsx';
  return '.docx';
}

export function officeFallbackStem(format?: string): string {
  if (format === 'pptx') return 'presentation';
  if (format === 'xlsx') return 'workbook';
  return 'document';
}

/**
 * Whether `src` represents a Huabu-stored artifact or inline (`data:` /
 * `blob:`) media payload that can be reliably downloaded without cross-origin
 * navigation.
 */
export function canDownloadMediaSource(
  src: string | undefined,
  missing = false,
): boolean {
  if (missing) return false;
  const trimmed = src?.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return true;
  return parseArtifactRef(trimmed) !== null;
}

export interface ResolveMediaDownloadParams {
  src?: string;
  canvasId?: string | null;
  label?: string;
  defaultExt: string;
  fallbackStem: string;
  missing?: boolean;
}

export function resolveMediaDownloadTarget({
  src,
  canvasId,
  label,
  defaultExt,
  fallbackStem,
  missing = false,
}: ResolveMediaDownloadParams): MediaDownloadTarget | null {
  if (missing) return null;
  const trimmed = src?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('data:')) {
    const ext = extensionFromDataUrl(trimmed, defaultExt);
    return {
      kind: 'data-url',
      dataUrl: trimmed,
      filename: resolveDownloadFilename(label, ext, fallbackStem),
    };
  }

  if (trimmed.startsWith('blob:')) {
    return {
      kind: 'blob-url',
      blobUrl: trimmed,
      filename: resolveDownloadFilename(label, defaultExt, fallbackStem),
    };
  }

  const artifactRef = parseArtifactRef(trimmed);
  if (!artifactRef) return null;
  const ownerCanvasId = artifactRef.canvasId ?? canvasId ?? '';
  if (!ownerCanvasId) return null;
  const key = artifactRef.canvasId
    ? safeDecodeURIComponent(artifactRef.key)
    : artifactRef.key;
  const ext = extnameOf(key) || normalizeExt(defaultExt);
  const keyStem = stemOf(key) || fallbackStem;
  return {
    kind: 'artifact',
    canvasId: ownerCanvasId,
    key,
    filename: resolveDownloadFilename(label, ext, keyStem),
  };
}

export interface WebDownloadSourceParams {
  src?: string;
  mhtmlArtifact?: string;
  missing?: boolean;
}

/**
 * Web nodes are downloadable when backed by an uploaded HTML/MHTML artifact
 * (including Interactive View HTML artifacts), inline `data:text/html` markup,
 * or a captured `.mhtml` page snapshot. External URLs without snapshots are
 * excluded.
 */
export function canDownloadWebSource({
  src,
  mhtmlArtifact,
  missing = false,
}: WebDownloadSourceParams): boolean {
  if (missing) return false;
  if (canDownloadMediaSource(src, false)) return true;
  return Boolean(mhtmlArtifact && parseArtifactRef(mhtmlArtifact.trim()));
}

export interface ResolveWebDownloadParams extends WebDownloadSourceParams {
  canvasId?: string | null;
  label?: string;
}

export function resolveWebDownloadTarget({
  src,
  mhtmlArtifact,
  canvasId,
  label,
  missing = false,
}: ResolveWebDownloadParams): MediaDownloadTarget | null {
  if (missing) return null;
  const direct = resolveMediaDownloadTarget({
    src,
    canvasId,
    label,
    defaultExt: '.html',
    fallbackStem: 'page',
  });
  if (direct) return direct;
  if (!mhtmlArtifact?.trim()) return null;
  return resolveMediaDownloadTarget({
    src: mhtmlArtifact,
    canvasId,
    label,
    defaultExt: '.mhtml',
    fallbackStem: 'page',
  });
}

/** Execute a resolved media/artifact download target, throwing on failure. */
export async function downloadMediaTarget(
  target: MediaDownloadTarget,
): Promise<void> {
  if (target.kind === 'artifact') {
    const basePath = routes.canvasArtifactFile(target.canvasId, target.key);
    await apiFetch<void>(`${basePath}?check=true`);
    const params = new URLSearchParams({
      download: '1',
      filename: target.filename,
    });
    const link = document.createElement('a');
    link.href = apiUrl(`${basePath}?${params.toString()}`);
    link.download = target.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }

  if (target.kind === 'data-url') {
    const blob = dataUrlToBlob(target.dataUrl);
    triggerBlobDownload(blob, target.filename);
    return;
  }

  const link = document.createElement('a');
  link.href = target.blobUrl;
  link.download = target.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function defaultDownloadFailedMessage(): string {
  return i18next.isInitialized
    ? i18next.t('node.downloadFailed')
    : 'Failed to download file';
}

function notifyDownloadError(error: unknown): void {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : defaultDownloadFailedMessage();
  toast(message, { tone: 'danger' });
}

/** Fire-and-forget media download helper with user-visible toast feedback. */
export function triggerMediaDownload(params: ResolveMediaDownloadParams): void {
  const target = resolveMediaDownloadTarget(params);
  if (!target) {
    toast(defaultDownloadFailedMessage(), { tone: 'danger' });
    return;
  }
  void downloadMediaTarget(target).catch(notifyDownloadError);
}

/** Fire-and-forget Web node download helper with user-visible toast feedback. */
export function triggerWebDownload(params: ResolveWebDownloadParams): void {
  const target = resolveWebDownloadTarget(params);
  if (!target) {
    toast(defaultDownloadFailedMessage(), { tone: 'danger' });
    return;
  }
  void downloadMediaTarget(target).catch(notifyDownloadError);
}

/** Export a Note's pure Markdown body as a `.md` file without internal frontmatter. */
export function triggerNoteDownload(params: {
  content?: string;
  label?: string;
  missing?: boolean;
}): void {
  if (params.missing) {
    toast(defaultDownloadFailedMessage(), { tone: 'danger' });
    return;
  }
  try {
    const filename = resolveDownloadFilename(params.label, '.md', 'note');
    const blob = new Blob([params.content ?? ''], {
      type: 'text/markdown;charset=utf-8',
    });
    triggerBlobDownload(blob, filename);
  } catch (error) {
    notifyDownloadError(error);
  }
}
