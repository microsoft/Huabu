// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { parseArtifactUrl } from '@huabu/shared';

import { apiFetch, apiUrl } from './_client';
import { routes } from './_routes';
import { API_CONFIG } from '../config/api';

import type {
  ArtifactUploadResponse,
  CloneArtifactRequest,
} from '@huabu/shared';

// Re-export the canonical wire helper from shared so the rest of the
// web bundle has one obvious place to import from.
export { parseArtifactUrl };

type ArtifactType = 'image' | 'pdf' | 'office' | 'video' | 'audio' | 'html';

/**
 * Resolve a stored artifact reference into a fully-qualified URL that
 * the browser can fetch.
 *
 * Three input shapes are accepted, in priority order:
 *
 *  1. **Bare artifact key** (`<artifactId><ext>`, e.g. `art_abc.pdf`) —
 *     the canonical form that the front-end now persists in
 *     `data.src` / `data.coverUrl`. Combined with `canvasId` to build
 *     `/api/canvas/<canvasId>/artifact/<key>`.
 *  2. **Canvas-scoped API path** (`/api/canvas/<id>/artifact/<key>`) —
 *     legacy data persisted before the bare-key migration. Re-based
 *     onto the current API origin.
 *  3. **Absolute URL** (`http(s)://…`) — either an external resource or
 *     a legacy absolute artifact URL whose hardcoded port has drifted.
 *     For the artifact case we strip the origin and re-base; everything
 *     else is returned untouched.
 *
 * `data:` URLs are passed through unchanged.
 *
 * `canvasId` is optional only to keep older call sites compiling — when
 * a bare key is passed without a canvas id we fall back to the input
 * verbatim so the caller can see the misconfiguration in the network
 * panel rather than silently rendering nothing.
 */
export function resolveArtifactUrl(src: string, canvasId?: string): string {
  if (!src) return src;
  if (src.startsWith('data:')) return src;
  // Object URLs are session-local and must never be treated as a bare
  // artifact key (that would build a nonsensical
  // `/api/canvas/<id>/artifact/blob:…` path). Pass them through so an
  // in-flight paste still previews; persistence replaces them with the
  // uploaded artifact key.
  if (src.startsWith('blob:')) return src;

  if (/^https?:\/\//.test(src)) {
    try {
      const { pathname } = new URL(src);
      if (
        pathname.startsWith('/api/canvas/') ||
        pathname.startsWith('/api/artifact/')
      ) {
        return `${API_CONFIG.BASE_URL}${pathname}`;
      }
    } catch {
      /* malformed URL — fall through */
    }
    return src;
  }

  if (src.startsWith('/api/')) {
    return `${API_CONFIG.BASE_URL}${src}`;
  }

  // Bare artifact key path: needs a canvas id to construct the URL.
  if (!canvasId) return src;
  return `${API_CONFIG.BASE_URL}/api/canvas/${canvasId}/artifact/${src}`;
}

async function uploadArtifact(
  file: File,
  type: ArtifactType,
  canvasId: string,
): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);

  const data = await apiFetch<ArtifactUploadResponse>(
    routes.canvasArtifact(canvasId, type),
    {
      method: 'POST',
      formData,
      fallbackMessage: `Failed to upload ${type}`,
    },
  );
  return data.uri;
}

export async function uploadImage(
  file: File,
  canvasId: string,
): Promise<string> {
  return uploadArtifact(file, 'image', canvasId);
}

export async function uploadPdf(file: File, canvasId: string): Promise<string> {
  return uploadArtifact(file, 'pdf', canvasId);
}

export async function uploadOffice(
  file: File,
  canvasId: string,
): Promise<string> {
  return uploadArtifact(file, 'office', canvasId);
}

export async function uploadVideo(
  file: File,
  canvasId: string,
): Promise<string> {
  return uploadArtifact(file, 'video', canvasId);
}

export async function uploadAudio(
  file: File,
  canvasId: string,
): Promise<string> {
  return uploadArtifact(file, 'audio', canvasId);
}

export async function uploadHtml(
  file: File,
  canvasId: string,
): Promise<string> {
  return uploadArtifact(file, 'html', canvasId);
}

// `apiUrl` is re-exported so callers (e.g. download links) can build the
// same absolute URLs the API helpers use without importing the config.
export { apiUrl };

/**
 * Copy an artifact from one canvas into another. Returns the new
 * artifact storage key (the bare `<id><ext>` filename) which the caller
 * can drop into the pasted node's `data.src` / `data.coverUrl`.
 *
 * Returns `null` when `srcKey` is empty (caller should leave the field
 * untouched). Returns the original key unchanged when `srcCanvasId`
 * equals `dstCanvasId`, since a same-canvas paste keeps sharing the
 * original artifact (no need to duplicate the file on disk).
 */
export async function cloneArtifactToCanvas(
  srcCanvasId: string,
  srcKey: string,
  dstCanvasId: string,
): Promise<string | null> {
  if (!srcKey) return null;
  if (srcCanvasId === dstCanvasId) return srcKey;

  const body: CloneArtifactRequest = {
    srcCanvasId,
    srcKey,
  };
  const data = await apiFetch<ArtifactUploadResponse>(
    routes.canvasArtifactCloneFrom(dstCanvasId),
    {
      method: 'POST',
      json: body,
      fallbackMessage: 'Failed to clone artifact',
    },
  );
  return data.uri;
}
