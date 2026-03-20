/**
 * Builder functions that construct `AddNodeInput` from raw user input
 * (files, URLs, plain text). Shared by Canvas.tsx (drop) and
 * useCanvasShortcuts.ts (paste) to eliminate duplication.
 */

import {
  detectNodeType,
  detectNodeTypeFromMime,
  getImageDimensionsFromBlob,
  normalizeUrl,
} from './media';
import { uploadImage, uploadPdf, uploadVideo } from '../../api/artifact';

import type { AddNodeInput } from '../../canvas/uiIntent';
import type { NodeOrigin } from '@sediment/shared';

type Point = { x: number; y: number };

/**
 * Upload a file and return an `AddNodeInput` ready for `addNode`.
 * Returns `null` for unsupported file types or on upload failure.
 */
export async function uploadFileToNodeInput(
  file: File,
  placementPoint: Point,
  origin: NodeOrigin,
): Promise<AddNodeInput | null> {
  const type = file.type
    ? detectNodeTypeFromMime(file.type)
    : detectNodeType(file.name);

  try {
    if (type === 'image') {
      const [src, naturalDimensions] = await Promise.all([
        uploadImage(file),
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
      const src = await uploadVideo(file);
      return {
        nodeType: 'video',
        placementPoint,
        data: { src, label: file.name, origin },
      };
    }

    if (type === 'pdf') {
      const src = await uploadPdf(file);
      return {
        nodeType: 'pdf',
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
  const nodeType = detectNodeType(finalUrl);
  return {
    nodeType,
    placementPoint,
    data: { src: finalUrl, origin },
  };
}

/**
 * Build an `AddNodeInput` for a plain-text note node.
 */
export function textToNodeInput(
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
