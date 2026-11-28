// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export {
  copyToClipboard,
  copyCanvasClipboard,
  copyImageToClipboard,
  parseHuabuClipboard,
  parseHuabuImageClipboard,
  type CanvasClipboardCopy,
  type HuabuClipboard,
  type HuabuClipboardImage,
} from './clipboard';

export { nodesToPlainText, type PlainTextNode } from './nodeToPlainText';

export {
  HUABU_DND_MIME,
  HUABU_DND_MOVABLE_MIME,
  type WebDragPayload,
  type NoteDragPayload,
  type ImageDragPayload,
  type DragPayload,
  type DragImageOffset,
  type SetDragPayloadOptions,
  createDragId,
  setDragPayload,
  canReadHuabuPayload,
  canMoveHuabuPayload,
  getHuabuPayload,
} from './dragDrop';

export {
  detectNodeType,
  looksLikeUrl,
  normalizeUrl,
  getImageDimensionsFromBlob,
} from './media';

export {
  resolveDownloadFilename,
  dataUrlToBlob,
  triggerBlobDownload,
  officeDefaultExtension,
  officeFallbackStem,
  canDownloadMediaSource,
  resolveMediaDownloadTarget,
  canDownloadWebSource,
  resolveWebDownloadTarget,
  downloadMediaTarget,
  triggerMediaDownload,
  triggerWebDownload,
  triggerNoteDownload,
  type MediaDownloadTarget,
  type ResolveMediaDownloadParams,
  type WebDownloadSourceParams,
  type ResolveWebDownloadParams,
} from './nodeDownload';
