// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { normalizeOrigin } from '@huabu/shared';

import type { NodeOrigin } from '@huabu/shared';

export const HUABU_DND_MIME = 'application/x-huabu-dnd';

/**
 * Sentinel MIME that is present on the `DataTransfer` _types_ list when
 * the drag source supports MOVE semantics (i.e. it knows how to delete
 * the dragged range from its origin). It carries no value — its mere
 * presence is the signal. We need a separate MIME because `getData`
 * is gated until `drop`, so `onDragOver` cannot inspect the JSON
 * payload to decide whether to render the move-or-copy cursor.
 */
export const HUABU_DND_MOVABLE_MIME = 'application/x-huabu-dnd-movable';

// TODO: the attribute data should be consistent with NodeData
export type WebDragPayload = {
  kind: 'web';
  data: {
    src: string;
  };
};

export type NoteDragPayload = {
  kind: 'note';
  data: {
    content: string;
    // Source note id + post-MOVE markdown snapshot, present when the
    // drag originated from an editable note (NotePreview). Required
    // for the Shift+drop MOVE path.
    sourceNodeId?: string;
    sourceContentAfterMove?: string;
  };
};

export type ImageDragPayload = {
  kind: 'image';
  data: {
    src: string;
    label?: string;
  };
};

export type DragPayload = {
  // Unique identifier for a single drag gesture. Used to dedupe duplicate drop events.
  dragId: string;
  // Where the drag originated from, e.g. 'user-from-chat', 'user-from-library', 'user-excerpt'.
  origin: NodeOrigin;
} & (WebDragPayload | NoteDragPayload | ImageDragPayload);

export const createDragId = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;

  return `drag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export type DragImageOffset = {
  x: number;
  y: number;
};

export type SetDragPayloadOptions = {
  effectAllowed?: DataTransfer['effectAllowed'];

  // If provided, will be used as a drag preview via dataTransfer.setDragImage.
  // We clone it to allow visual tweaks without affecting the live UI.
  dragImageElement?: HTMLElement | null;

  // If provided, used as the cursor offset for setDragImage.
  // This is required when `dragImageElement` is an offscreen preview element.
  dragImageOffset?: DragImageOffset;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const createTransparentDragPreview = (sourceEl: HTMLElement) => {
  const rect = sourceEl.getBoundingClientRect();
  const dragPreview = sourceEl.cloneNode(true) as HTMLElement;

  dragPreview.style.position = 'fixed';
  dragPreview.style.top = '-10000px';
  dragPreview.style.left = '-10000px';
  dragPreview.style.pointerEvents = 'none';
  dragPreview.style.background = 'transparent';
  dragPreview.style.backgroundColor = 'transparent';
  dragPreview.style.width = `${rect.width}px`;
  dragPreview.style.height = `${rect.height}px`;

  document.body.appendChild(dragPreview);

  return {
    dragPreview,
    rect,
    cleanup: () => dragPreview.remove(),
  };
};

export const setDragPayload = (
  e: React.DragEvent,
  payload: Omit<DragPayload, 'dragId'>,
  options: SetDragPayloadOptions = {},
) => {
  e.dataTransfer.effectAllowed = options.effectAllowed ?? 'copy';

  const enrichedPayload = {
    ...payload,
    dragId: createDragId(),
  } as DragPayload;
  e.dataTransfer.setData(HUABU_DND_MIME, JSON.stringify(enrichedPayload));

  // Expose the "this drag supports MOVE" flag via a separate MIME so
  // `onDragOver` listeners can pick the right `dropEffect` without
  // peeking at the JSON payload. Only note drags coming from an
  // editable surface (NotePreview) carry the source bookkeeping.
  if (
    enrichedPayload.kind === 'note' &&
    typeof enrichedPayload.data.sourceNodeId === 'string' &&
    typeof enrichedPayload.data.sourceContentAfterMove === 'string'
  ) {
    e.dataTransfer.setData(HUABU_DND_MOVABLE_MIME, '1');
  }

  const dragImageElement = options.dragImageElement;
  if (!dragImageElement) return;

  const isPreviewElement = !dragImageElement.isConnected;
  const desiredOffset = options.dragImageOffset;

  // If the caller built a dedicated preview element (not yet connected),
  // use it directly and clean it up after the browser snapshots it.
  if (isPreviewElement) {
    dragImageElement.style.position = 'fixed';
    dragImageElement.style.top = '-10000px';
    dragImageElement.style.left = '-10000px';
    dragImageElement.style.pointerEvents = 'none';
    dragImageElement.style.background = 'transparent';
    dragImageElement.style.backgroundColor = 'transparent';
    document.body.appendChild(dragImageElement);

    const previewRect = dragImageElement.getBoundingClientRect();
    const offsetX = desiredOffset
      ? clamp(desiredOffset.x, 0, previewRect.width)
      : 0;
    const offsetY = desiredOffset
      ? clamp(desiredOffset.y, 0, previewRect.height)
      : 0;

    e.dataTransfer.setDragImage(dragImageElement, offsetX, offsetY);

    // Keep it around long enough for the browser to snapshot it.
    window.setTimeout(() => dragImageElement.remove(), 0);
    return;
  }

  const { dragPreview, rect, cleanup } =
    createTransparentDragPreview(dragImageElement);

  const offsetX = desiredOffset
    ? clamp(desiredOffset.x, 0, rect.width)
    : clamp(e.clientX - rect.left, 0, rect.width);
  const offsetY = desiredOffset
    ? clamp(desiredOffset.y, 0, rect.height)
    : clamp(e.clientY - rect.top, 0, rect.height);

  e.dataTransfer.setDragImage(dragPreview, offsetX, offsetY);

  // Keep the preview around long enough for the browser to snapshot it.
  window.setTimeout(cleanup, 0);
};

export const canReadHuabuPayload = (dt: DataTransfer) =>
  dt.types.includes(HUABU_DND_MIME);

/**
 * True when the current drag's source declared MOVE support via
 * `HUABU_DND_MOVABLE_MIME`. Safe to call from `onDragOver`.
 */
export const canMoveHuabuPayload = (dt: DataTransfer) =>
  dt.types.includes(HUABU_DND_MOVABLE_MIME);

export const getHuabuPayload = (dt: DataTransfer): DragPayload | null => {
  const raw = dt.getData(HUABU_DND_MIME);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const kind = (parsed as { kind?: unknown }).kind;
    const data = (parsed as { data?: unknown }).data;
    const dragId = (parsed as { dragId?: unknown }).dragId;
    const origin = (parsed as { origin?: unknown }).origin;

    if (typeof dragId !== 'string' || dragId.trim() === '') return null;
    const normalizedDragId = dragId.trim();
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) {
      console.warn(
        '[dragDrop] Dropped payload is missing a valid "origin" field.',
        { kind, dragId: normalizedDragId, origin },
      );
      return null;
    }

    if (kind === 'web' && data && typeof data === 'object') {
      const src = (data as { src?: unknown }).src;

      if (typeof src !== 'string' || src.trim() === '') return null;

      return {
        kind: 'web',
        data: {
          src: src.trim(),
        },
        dragId: normalizedDragId,
        origin: normalizedOrigin,
      };
    }

    if (kind === 'note' && data && typeof data === 'object') {
      const content = (data as { content?: unknown }).content;
      if (typeof content !== 'string' || content.trim() === '') return null;

      const sourceNodeIdRaw = (data as { sourceNodeId?: unknown }).sourceNodeId;
      const sourceContentAfterMoveRaw = (
        data as { sourceContentAfterMove?: unknown }
      ).sourceContentAfterMove;
      const sourceNodeId =
        typeof sourceNodeIdRaw === 'string' && sourceNodeIdRaw.trim() !== ''
          ? sourceNodeIdRaw
          : undefined;
      // Accept empty string here — user may have dragged out the
      // entire note, leaving the source legitimately empty.
      const sourceContentAfterMove =
        typeof sourceContentAfterMoveRaw === 'string'
          ? sourceContentAfterMoveRaw
          : undefined;

      return {
        kind: 'note',
        data: {
          content,
          ...(sourceNodeId !== undefined ? { sourceNodeId } : {}),
          ...(sourceContentAfterMove !== undefined
            ? { sourceContentAfterMove }
            : {}),
        },
        dragId: normalizedDragId,
        origin: normalizedOrigin,
      };
    }

    if (kind === 'image' && data && typeof data === 'object') {
      const src = (data as { src?: unknown }).src;
      if (typeof src !== 'string' || src.trim() === '') return null;

      const label = (data as { label?: unknown }).label;

      return {
        kind: 'image',
        data: {
          src: src.trim(),
          label: typeof label === 'string' ? label : undefined,
        },
        dragId: normalizedDragId,
        origin: normalizedOrigin,
      };
    }

    return null;
  } catch {
    return null;
  }
};
