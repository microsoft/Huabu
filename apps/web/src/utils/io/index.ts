// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export {
  copyToClipboard,
  copyCanvasClipboard,
  parseSedimentClipboard,
  parseSedimentImageClipboard,
  type CanvasClipboardCopy,
  type SedimentClipboard,
  type SedimentClipboardImage,
} from './clipboard';

export { nodesToPlainText, type PlainTextNode } from './nodeToPlainText';

export {
  SEDIMENT_DND_MIME,
  SEDIMENT_DND_MOVABLE_MIME,
  type WebDragPayload,
  type NoteDragPayload,
  type ImageDragPayload,
  type DragPayload,
  type DragImageOffset,
  type SetDragPayloadOptions,
  createDragId,
  setDragPayload,
  canReadSedimentPayload,
  canMoveSedimentPayload,
  getSedimentPayload,
} from './dragDrop';

export {
  detectNodeType,
  detectNodeTypeFromMime,
  looksLikeUrl,
  normalizeUrl,
  getImageDimensionsFromBlob,
} from './media';
