export const SEDIMENT_DND_MIME = 'application/x-sediment-dnd';

// TODO: the attribute data should be consistent with NodeDataProps
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
  };
};

export type SourceDragPayload = {
  kind: 'source';
  data: {
    sourceId: string;
    type?: string;
    label?: string;
    src?: string;
    [key: string]: unknown;
  };
};

export type DragPayload = {
  // Unique identifier for a single drag gesture. Used to dedupe duplicate drop events.
  dragId: string;
} & (WebDragPayload | NoteDragPayload | SourceDragPayload);

const createDragId = () => {
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
  payload: WebDragPayload | NoteDragPayload | SourceDragPayload,
  options: SetDragPayloadOptions = {},
) => {
  e.dataTransfer.effectAllowed = options.effectAllowed ?? 'copy';

  const enrichedPayload: { dragId: string } & typeof payload = {
    ...payload,
    dragId: createDragId(),
  };
  e.dataTransfer.setData(SEDIMENT_DND_MIME, JSON.stringify(enrichedPayload));

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

export const canReadSedimentPayload = (dt: DataTransfer) =>
  dt.types.includes(SEDIMENT_DND_MIME);

export const getSedimentPayload = (dt: DataTransfer): DragPayload | null => {
  const raw = dt.getData(SEDIMENT_DND_MIME);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const kind = (parsed as { kind?: unknown }).kind;
    const data = (parsed as { data?: unknown }).data;
    const dragId = (parsed as { dragId?: unknown }).dragId;

    if (typeof dragId !== 'string' || dragId.trim() === '') return null;
    const normalizedDragId = dragId.trim();

    if (kind === 'web' && data && typeof data === 'object') {
      const src = (data as { src?: unknown }).src;

      if (typeof src !== 'string' || src.trim() === '') return null;

      return {
        kind: 'web',
        data: {
          src: src.trim(),
        },
        dragId: normalizedDragId,
      };
    }

    if (kind === 'note' && data && typeof data === 'object') {
      const content = (data as { content?: unknown }).content;
      if (typeof content !== 'string' || content.trim() === '') return null;

      return {
        kind: 'note',
        data: {
          content,
        },
        dragId: normalizedDragId,
      };
    }

    if (kind === 'source' && data && typeof data === 'object') {
      const sourceId = (data as { sourceId?: unknown }).sourceId;
      if (typeof sourceId !== 'string' || sourceId.trim() === '') return null;

      const type = (data as { type?: unknown }).type;
      const label = (data as { label?: unknown }).label;

      return {
        kind: 'source',
        data: {
          ...(data as Record<string, unknown>),
          sourceId: sourceId.trim(),
          type: typeof type === 'string' ? type : undefined,
          label: typeof label === 'string' ? label : undefined,
        },
        dragId: normalizedDragId,
      };
    }

    return null;
  } catch {
    return null;
  }
};
