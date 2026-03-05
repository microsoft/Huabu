import clsx from 'clsx';
import { GripVertical, ImageIcon, Loader2, Type } from 'lucide-react';

import { setDragPayload } from '@/utils/dragDrop';

import { Popover } from '../Common/Popover';

import type { FC } from 'react';

type FloatingDragHandleProps = {
  /** Screen-space position (clientX/Y from the triggering pointerup) */
  position: { x: number; y: number };

  /** Text extracted from the selected region via pdfjs getTextContent(). Empty string = no text found. */
  text: string;

  /** Source ID of the parent node being captured from (e.g. a PDF node). */
  sourceId?: string;

  /** Uploaded image URL. Null while still capturing. */
  imageUrl?: string | null;
  capturing?: boolean;
  uploadError?: boolean;
  onRetry?: () => void;

  onDismiss: () => void;
};

/**
 * FloatingDragHandle
 *
 * Renders a small panel near the cursor (via Popover) after the user
 * draws a capture region in the PDF preview.  Shows up to two drag handles:
 *  - "Text" drag (if text was found in the region)
 *  - "Image" drag (once the cropped bitmap has been uploaded)
 */
export const FloatingDragHandle: FC<FloatingDragHandleProps> = ({
  position,
  text,
  sourceId,
  imageUrl,
  capturing = false,
  uploadError = false,
  onRetry,
  onDismiss,
}) => {
  const hasText = text.trim().length > 0;
  const isImageReady = !!imageUrl && !capturing;

  const handleTextDragStart = (e: React.DragEvent) => {
    setDragPayload(e, {
      kind: 'note',
      origin: { type: 'user-drag-capture', sourceId },
      data: { content: text },
    });
    setTimeout(onDismiss, 0);
  };

  const handleImageDragStart = (e: React.DragEvent) => {
    if (!imageUrl) return;
    setDragPayload(e, {
      kind: 'image',
      origin: { type: 'user-drag-capture', sourceId },
      data: { src: imageUrl, label: 'PDF Capture' },
    });
    setTimeout(onDismiss, 0);
  };

  const dragBtnClass = clsx(
    'flex shrink-0 cursor-grab items-center gap-0.5 rounded px-1.5 py-0.5',
    'bg-muted text-foreground text-xs font-medium',
    'hover:bg-muted/80 active:cursor-grabbing',
  );

  return (
    <Popover
      position={position}
      onDismiss={onDismiss}
      className="flex flex-col gap-1.5 px-2.5 py-2"
    >
      {/* ── Text drag button ── */}
      {hasText && (
        <div
          draggable
          onDragStart={handleTextDragStart}
          className={dragBtnClass}
          title="Drag selected text to canvas as a note"
        >
          <Type size={11} className="shrink-0" />
          <GripVertical size={11} className="shrink-0" />
          <span>Drag text</span>
        </div>
      )}

      {/* ── Image drag button (or status) ── */}
      {capturing && (
        <div className="text-muted-foreground flex items-center gap-1 text-xs">
          <Loader2 size={11} className="animate-spin" />
          <span>Capturing…</span>
        </div>
      )}
      {uploadError && (
        <div className="flex items-center gap-1 text-xs text-red-400">
          <span>Upload failed</span>
          {onRetry && (
            <button className="underline" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {isImageReady && (
        <div
          draggable
          onDragStart={handleImageDragStart}
          className={dragBtnClass}
          title="Drag captured region to canvas as an image"
        >
          <ImageIcon size={11} className="shrink-0" />
          <GripVertical size={11} className="shrink-0" />
          <span>Drag image</span>
        </div>
      )}
    </Popover>
  );
};
