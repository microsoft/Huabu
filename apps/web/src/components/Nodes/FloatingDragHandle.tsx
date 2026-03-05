import clsx from 'clsx';
import { ImageIcon, Loader2, StickyNote } from 'lucide-react';

import { setDragPayload } from '@/utils/dragDrop';

import { DragToCanvasHandleButton } from '../Common/DragToCanvasHandleButton';
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
      data: { src: imageUrl },
    });
    setTimeout(onDismiss, 0);
  };

  const dragBtnClass = clsx(
    'flex shrink-0 cursor-grab items-center gap-1 px-2.5 py-1.5',
    'text-xs text-foreground',
    'hover:bg-theme-100 active:cursor-grabbing',
  );

  return (
    <Popover
      position={position}
      onDismiss={onDismiss}
      className="flex flex-col"
    >
      {/* ── Text drag button ── */}
      {hasText && (
        <DragToCanvasHandleButton
          iconSize={10}
          onDragStart={handleTextDragStart}
          className={dragBtnClass}
          title="Drag selected text as a note"
        >
          <StickyNote size={14} className="shrink-0" />
        </DragToCanvasHandleButton>
      )}

      {/* ── Image drag button (or status) ── */}
      {capturing && (
        <div className="text-muted-foreground flex items-center gap-1 text-xs">
          <Loader2 size={11} className="animate-spin" />
        </div>
      )}
      {isImageReady && (
        <DragToCanvasHandleButton
          iconSize={10}
          onDragStart={handleImageDragStart}
          className={dragBtnClass}
          title="Drag captured region as an image"
        >
          <ImageIcon size={14} className="shrink-0" />
        </DragToCanvasHandleButton>
      )}
    </Popover>
  );
};
