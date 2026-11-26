// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Builder functions that construct `AddNodeInput` from raw user input
 * (files, URLs, plain text). Shared by Canvas.tsx (drop) and
 * useCanvasShortcuts.ts (paste) to eliminate duplication.
 */

import { createId, type NodeOrigin } from '@huabu/shared';

import { toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useImportPlaceholderStore } from '@/store/importPlaceholderStore';
import { getCanvasViewportCenter } from '@/utils/canvasViewport';
import { pageLifecycle } from '@/utils/pageLifecycle';

import {
  computeMediaSize,
  viewportCenterAnchor,
} from './resolvers/resolveAddNodes';
import {
  uploadAudio,
  uploadHtml,
  uploadImage,
  uploadOffice,
  uploadPdf,
  uploadVideo,
} from '../../api/artifact';
import {
  detectFileNodeType,
  detectNodeType,
  detectOfficeFormat,
  getImageDimensionsFromBlob,
  getVideoDimensionsFromBlob,
  normalizeUrl,
} from '../../utils/io/media';

import type { AddNodeInput } from './uiIntent';

type Point = { x: number; y: number };

type Dimensions = { width: number; height: number };
type FileNodeType = NonNullable<ReturnType<typeof detectFileNodeType>>;

/** Read the intrinsic size of an image or video from the local file. */
function measureFile(
  file: File,
  type: FileNodeType,
): Promise<Dimensions | undefined> {
  if (type === 'image')
    return getImageDimensionsFromBlob(file).catch(() => undefined);
  // A codec the browser cannot decode still deserves a node — it just
  // falls back to the default size instead of the real aspect ratio.
  if (type === 'video')
    return getVideoDimensionsFromBlob(file).catch(() => undefined);
  return Promise.resolve(undefined);
}

/** Upload a file and return an `AddNodeInput` ready for `addNode`. */
async function uploadFileToNodeInput(
  file: File,
  type: FileNodeType,
  dimensions: Promise<Dimensions | undefined>,
  placementPoint: Point | undefined,
  origin: NodeOrigin,
  canvasId: string,
): Promise<AddNodeInput> {
  if (type === 'image' || type === 'video') {
    const [src, naturalDimensions] = await Promise.all([
      type === 'image'
        ? uploadImage(file, canvasId)
        : uploadVideo(file, canvasId),
      dimensions,
    ]);
    return {
      nodeType: type,
      placementPoint,
      data: { src, label: file.name, origin },
      naturalDimensions,
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

  // A local .html / .htm file is uploaded as an artifact and its key is
  // stored in `data.src` — the preprocess pipeline branch in input-resolve
  // detects the missing `http://` scheme and reads the file from disk.
  const upload = { audio: uploadAudio, pdf: uploadPdf, web: uploadHtml }[type];
  const src = await upload(file, canvasId);
  return {
    nodeType: type,
    placementPoint,
    data: { src, label: file.name, origin },
  };
}

/**
 * Put a card where the file's node will appear, and return its id. Without
 * a placement point the node is centred in the viewport, so the card is too;
 * when the viewport is not known yet no card is shown.
 */
function showImportPlaceholder(
  file: File,
  type: FileNodeType,
  placementPoint: Point | undefined,
  staggerIndex: number,
  canvasId: string,
  dimensions: Promise<Dimensions | undefined>,
): string | undefined {
  const center = placementPoint
    ? undefined
    : getCanvasViewportCenter(useCanvasStore.getState());
  const rectFor = (natural?: Dimensions) => {
    const size = computeMediaSize(
      type,
      natural?.width ?? 0,
      natural?.height ?? 0,
    );
    const position =
      placementPoint ??
      (center && viewportCenterAnchor(type, size, center, staggerIndex));
    return position && typeof size.height === 'number'
      ? { ...position, width: size.width, height: size.height }
      : undefined;
  };
  const rect = rectFor();
  if (!rect) return undefined;

  const { show, update } = useImportPlaceholderStore.getState();
  const id = createId('import');
  show({
    id,
    canvasId,
    nodeType: type,
    name: file.name,
    ...rect,
    ...(type === 'image' && { previewUrl: URL.createObjectURL(file) }),
  });
  void dimensions.then((natural) => {
    const measured = natural && rectFor(natural);
    if (measured) update(id, measured);
  });
  return id;
}

export async function importFilesAsNodes(
  files: File[],
  placementPoint: Point | undefined,
  origin: NodeOrigin,
  canvasId: string,
  addNodes: (inputs: AddNodeInput[]) => void,
): Promise<void> {
  const unsupported: File[] = [];
  const imports = files.flatMap((file, index) => {
    const type = detectFileNodeType(file);
    if (!type) {
      unsupported.push(file);
      return [];
    }
    const position = placementPoint && {
      x: placementPoint.x + index * 30,
      y: placementPoint.y + index * 30,
    };
    return [{ file, type, position, dimensions: measureFile(file, type) }];
  });
  if (unsupported.length)
    toast(
      i18n.t('node.unsupportedFileType', {
        names: unsupported.map((file) => file.name).join(', '),
      }),
      { tone: 'danger' },
    );
  // A note is read locally, so it needs no card while it "uploads".
  const placeholderIds = imports.map(
    ({ file, type, position, dimensions }, index) =>
      type === 'note'
        ? undefined
        : showImportPlaceholder(
            file,
            type,
            position,
            index,
            canvasId,
            dimensions,
          ),
  );
  const placeholders = useImportPlaceholderStore.getState();
  // A failed card already says what went wrong; a toast would repeat it.
  let failureIsOnCards = false;

  try {
    await pageLifecycle.run('importing', async () => {
      const results = await Promise.allSettled(
        imports.map(async ({ file, type, position, dimensions }) => {
          const input = await uploadFileToNodeInput(
            file,
            type,
            dimensions,
            position,
            origin,
            canvasId,
          );
          if (
            input.data &&
            origin.type === 'user-pasted' &&
            file.name === 'pasted-image'
          )
            delete input.data.label;
          return input;
        }),
      );
      const inputs = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      if (inputs.length) addNodes(inputs);
      // The nodes and the cards change in one render: a card that succeeded
      // gives way to its node, a card that failed stays and offers a retry.
      results.forEach((result, index) => {
        const id = placeholderIds[index];
        if (!id) return;
        if (result.status === 'fulfilled') return placeholders.remove(id);
        const { file, position } = imports[index];
        placeholders.update(id, {
          error: failureMessage(result.reason),
          retry: () => {
            placeholders.remove(id);
            void importFilesAsNodes(
              [file],
              position,
              origin,
              canvasId,
              addNodes,
            );
          },
        });
      });
      const failed = results.find((result) => result.status === 'rejected');
      failureIsOnCards = results.every(
        (result, index) =>
          result.status === 'fulfilled' || placeholderIds[index],
      );
      if (failed?.status === 'rejected') throw failed.reason;
    });
  } catch (error) {
    console.error('[import] Could not import files:', error);
    if (!failureIsOnCards) toast(failureMessage(error), { tone: 'danger' });
  }
}

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : i18n.t('node.uploadFailed');

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
