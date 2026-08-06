// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Builder functions that construct `AddNodeInput` from raw user input
 * (files, URLs, plain text). Shared by Canvas.tsx (drop) and
 * useCanvasShortcuts.ts (paste) to eliminate duplication.
 */

import {
  uploadHtml,
  uploadImage,
  uploadOffice,
  uploadPdf,
  uploadVideo,
} from '../../api/artifact';
import {
  detectNodeType,
  detectNodeTypeFromMime,
  detectOfficeFormat,
  getImageDimensionsFromBlob,
  normalizeUrl,
} from '../../utils/io/media';

import type { AddNodeInput } from './uiIntent';
import type { NodeOrigin } from '@huabu/shared';

type Point = { x: number; y: number };

/**
 * Upload a file and return an `AddNodeInput` ready for `addNode`.
 * Returns `null` for unsupported file types or on upload failure.
 */
export async function uploadFileToNodeInput(
  file: File,
  placementPoint: Point,
  origin: NodeOrigin,
  canvasId: string,
): Promise<AddNodeInput | null> {
  // Prefer MIME-based detection, but fall back to filename when MIME is
  // absent or yields the generic 'web' bucket (e.g. .md reported as text/plain).
  const mimeType = file.type ? detectNodeTypeFromMime(file.type) : 'web';
  const type = mimeType === 'web' ? detectNodeType(file.name) : mimeType;

  try {
    if (type === 'image') {
      const [src, naturalDimensions] = await Promise.all([
        uploadImage(file, canvasId),
        getImageDimensionsFromBlob(file),
      ]);
      return {
        nodeType: 'image',
        placementPoint,
        data: { src, label: file.name, origin },
        naturalDimensions,
      };
    }

    if (type === 'video') {
      const src = await uploadVideo(file, canvasId);
      return {
        nodeType: 'video',
        placementPoint,
        data: { src, label: file.name, origin },
      };
    }

    if (type === 'pdf') {
      const src = await uploadPdf(file, canvasId);
      return {
        nodeType: 'pdf',
        placementPoint,
        data: { src, label: file.name, origin },
      };
    }

    if (type === 'office') {
      // Derive the concrete Office format from the file extension so
      // the renderer can pick the right icon without re-parsing `src`.
      // Fall back to `docx` only if extension detection somehow fails
      // — the upload would still succeed and the server-side parser
      // auto-detects format from magic bytes.
      const format = detectOfficeFormat(file.name) ?? 'docx';
      const src = await uploadOffice(file, canvasId);
      return {
        nodeType: 'office',
        placementPoint,
        data: { src, format, label: file.name, origin },
      };
    }

    if (type === 'note') {
      const content = await file.text();
      return {
        nodeType: 'note',
        placementPoint,
        data: { content, label: file.name, origin },
      };
    }

    if (type === 'web') {
      // Local .html / .htm file dropped onto the canvas. Upload as an
      // artifact and store the resulting key in `data.src` — the
      // preprocess pipeline branch in input-resolve detects the missing
      // `http://` scheme and reads the file from disk.
      const src = await uploadHtml(file, canvasId);
      return {
        nodeType: 'web',
        placementPoint,
        data: { src, label: file.name, origin },
      };
    }
  } catch (error) {
    console.error(`Failed to process file ${file.name}:`, error);
  }

  return null;
}

/**
 * Build an `AddNodeInput` from a URL string.
 * Auto-detects the node type (image / video / pdf / web).
 */
export function urlToNodeInput(
  url: string,
  placementPoint: Point,
  origin: NodeOrigin,
): AddNodeInput {
  const finalUrl = normalizeUrl(url);
  const detected = detectNodeType(finalUrl);
  // Remote Office files are uncommon and cannot be ingested without a
  // local copy; surface them as a generic web node so the link still
  // round-trips through the canvas.
  const nodeType = detected === 'office' ? 'web' : detected;
  return {
    nodeType,
    placementPoint,
    data: { src: finalUrl, origin },
  };
}

/**
 * Build an `AddNodeInput` for a `note` node holding the given plain text.
 * Use this for multi-line / longer text where rich formatting may be needed.
 */
export function textToNoteNodeInput(
  text: string,
  placementPoint: Point,
  origin: NodeOrigin,
): AddNodeInput {
  return {
    nodeType: 'note',
    placementPoint,
    data: { content: text, origin },
  };
}

/**
 * Build an `AddNodeInput` for a lightweight text node (single short line).
 */
export function textToTextNodeInput(
  text: string,
  placementPoint: Point,
  origin: NodeOrigin,
): AddNodeInput {
  return {
    nodeType: 'text',
    placementPoint,
    data: { content: text, origin },
  };
}
