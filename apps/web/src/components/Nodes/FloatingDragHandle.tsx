import clsx from 'clsx';
import { Loader2, MessageSquare, Plus } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { setDragPayload } from '@/utils/dragDrop';

import { NODE_ICON } from '../../config/nodeIcons';
import { DragToCanvasHandleButton } from '../Common/DragToCanvasHandleButton';
import { GhostButton } from '../Common/GhostButton';
import { Popover } from '../Common/Popover';

import type { ChatAttachment } from '@sediment/shared';
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
  /** Called when the user clicks "Send to Chat". */
  onSendToChat?: (attachment: ChatAttachment) => void;
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
  onSendToChat,
}) => {
  const hasText = text.trim().length > 0;
  const isImageReady = !!imageUrl && !capturing;

  // Track whether a drag is in progress so we can suppress Popover's
  // outside-click dismiss until the drop completes.
  const draggingRef = useRef(false);

  const handleTextDragStart = (e: React.DragEvent) => {
    draggingRef.current = true;
    setDragPayload(e, {
      kind: 'note',
      origin: { type: 'user-drag-capture', sourceId },
      data: { content: text },
    });
  };

  const handleImageDragStart = (e: React.DragEvent) => {
    if (!imageUrl) return;
    draggingRef.current = true;
    setDragPayload(e, {
      kind: 'image',
      origin: { type: 'user-drag-capture', sourceId },
      data: { src: imageUrl },
    });
  };

  // Dismiss only after the drag operation finishes (drop or cancel)
  const handleDragEnd = useCallback(() => {
    draggingRef.current = false;
    onDismiss();
  }, [onDismiss]);

  // Guard dismiss: ignore outside-click while a drag is active
  const guardedDismiss = useCallback(() => {
    if (draggingRef.current) return;
    onDismiss();
  }, [onDismiss]);

  const handleSendToChat = useCallback(() => {
    if (!onSendToChat || !imageUrl) return;
    const attachment: ChatAttachment = {
      type: 'image',
      url: imageUrl,
      extractedText: hasText ? text : undefined,
      label: 'PDF capture',
      originSourceId: sourceId,
    };
    onSendToChat(attachment);
    onDismiss();
  }, [onSendToChat, imageUrl, hasText, text, sourceId, onDismiss]);

  const dragBtnClass = clsx(
    'flex shrink-0 cursor-grab items-center justify-center gap-1 px-2.5 py-1.5',
    'text-xs text-foreground',
    'hover:bg-theme-100 active:cursor-grabbing',
  );

  return (
    <Popover
      position={position}
      onDismiss={guardedDismiss}
      className="grid auto-rows-auto"
    >
      {/* ── Text drag button ── */}
      {hasText && (
        <DragToCanvasHandleButton
          iconSize={10}
          onDragStart={handleTextDragStart}
          onDragEnd={handleDragEnd}
          className={dragBtnClass}
          title="Drag selected text as a note"
        >
          <NODE_ICON.note size={14} className="shrink-0" />
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
          onDragEnd={handleDragEnd}
          className={dragBtnClass}
          title="Drag captured area as an image"
        >
          <NODE_ICON.image size={14} className="shrink-0" />
        </DragToCanvasHandleButton>
      )}

      {/* ── Send to Chat button ── */}
      {isImageReady && onSendToChat && imageUrl && (
        <GhostButton
          className={dragBtnClass}
          title="Send captured area to chat"
          onClick={handleSendToChat}
        >
          {/* Plus icon matching the GripVertical icon width in DragToCanvasHandleButton */}
          <Plus size={10} className="shrink-0" />
          <MessageSquare size={14} className="shrink-0" />
        </GhostButton>
      )}
    </Popover>
  );
};
