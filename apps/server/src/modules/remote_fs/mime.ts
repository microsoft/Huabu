// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Minimal extension → MIME map for RFS byte downloads.
 *
 * The RFS serves arbitrary canvas-relative files (node markdown, artifact
 * renders/uploads, staged payloads). We only need a small, dependency-free
 * lookup: node files are markdown, artifacts are the handful of image/doc
 * types the canvas produces, and anything unknown falls back to a safe
 * `application/octet-stream` so the browser/agent never mis-renders bytes.
 */

import path from 'node:path';

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Content-Type for a filename, defaulting to `application/octet-stream`. */
export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
