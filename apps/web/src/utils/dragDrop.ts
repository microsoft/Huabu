export const SEDIMENT_DND_MIME = 'application/x-sediment-dnd';

export type WebDragPayload = {
  kind: 'web';
  data: {
    src: string;
    label?: string;
    favicon?: string;
    title?: string;
  };
};

export type NoteDragPayload = {
  kind: 'note';
  data: {
    content: string;
  };
};

export type DragPayload = WebDragPayload | NoteDragPayload;

export type SetDragPayloadOptions = {
  effectAllowed?: DataTransfer['effectAllowed'];
  fallbackText?: string;

  // If provided, will be used as a drag preview via dataTransfer.setDragImage.
  // We clone it to allow visual tweaks without affecting the live UI.
  dragImageElement?: HTMLElement | null;
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
  payload: DragPayload,
  options: SetDragPayloadOptions = {},
) => {
  e.dataTransfer.effectAllowed = options.effectAllowed ?? 'copy';
  e.dataTransfer.setData(SEDIMENT_DND_MIME, JSON.stringify(payload));

  if (options.fallbackText) {
    e.dataTransfer.setData('text/plain', options.fallbackText);
  }

  if (options.dragImageElement) {
    const { dragPreview, rect, cleanup } = createTransparentDragPreview(
      options.dragImageElement,
    );

    // The cursor might start outside of the drag image element.
    const offsetX = clamp(e.clientX - rect.left, 0, rect.width);
    const offsetY = clamp(e.clientY - rect.top, 0, rect.height);

    e.dataTransfer.setDragImage(dragPreview, offsetX, offsetY);

    // Keep the preview around long enough for the browser to snapshot it.
    window.setTimeout(cleanup, 0);
  }
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

    if (kind === 'web' && data && typeof data === 'object') {
      const src = (data as { src?: unknown }).src;
      const label = (data as { label?: unknown }).label;
      const favicon = (data as { favicon?: unknown }).favicon;
      const title = (data as { title?: unknown }).title;

      if (typeof src !== 'string' || src.trim() === '') return null;

      return {
        kind: 'web',
        data: {
          src: src.trim(),
          label: typeof label === 'string' ? label : undefined,
          favicon: typeof favicon === 'string' ? favicon : undefined,
          title: typeof title === 'string' ? title : undefined,
        },
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
      };
    }

    return null;
  } catch {
    return null;
  }
};
