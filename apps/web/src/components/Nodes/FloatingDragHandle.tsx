// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { MessageSquare, Plus, Star } from 'lucide-react';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  selectActiveNodeId,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';
import { setDragPayload } from '@/utils/io/dragDrop';

import { NODE_ICON } from '../../config/nodeIcons';
import { Button } from '../Common/Button';
import { DragToCanvasHandleButton } from '../Common/DragToCanvasHandleButton';
import { Loading } from '../Common/Loading';
import { Popover } from '../Common/Popover';

import type { ChatAttachment } from '@huabu/shared';
import type { FC } from 'react';

type FloatingDragHandleProps = {
  /** Screen-space position (clientX/Y from the triggering pointerup) */
  position: { x: number; y: number };

  /** Text extracted from the selected region via pdfjs getTextContent(). Empty string = no text found. */
  text: string;

  /** Parent canvas node id this capture was taken from (e.g. a PDF node). */
  excerptFromNodeId?: string;

  /** Uploaded image URL. Null while still capturing. */
  imageUrl?: string | null;
  capturing?: boolean;

  onDismiss: () => void;
  /** Called when the user clicks "Send to Chat". */
  onSendToChat?: (attachment: ChatAttachment) => void;
  /** Called when the user clicks "Set as Cover" to use the captured image as the PDF node cover. */
  onSetCover?: (imageUrl: string) => void;
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
  excerptFromNodeId,
  imageUrl,
  capturing = false,
  onDismiss,
  onSendToChat,
  onSetCover,
}) => {
  const { t } = useTranslation();
  const hasText = text.trim().length > 0;
  const isImageReady = !!imageUrl && !capturing;

  // Carried on excerpt attachments so Chat can trace them back to their
  // source node.
  const expandedNodeId = usePreviewWorkspaceStore(selectActiveNodeId);

  // Track whether a drag is in progress so we can suppress Popover's
  // outside-click dismiss until the drop completes.
  const draggingRef = useRef(false);

  const handleTextDragStart = (e: React.DragEvent) => {
    draggingRef.current = true;
    setDragPayload(e, {
      kind: 'note',
      origin: { type: 'user-excerpt', excerptFromNodeId },
      data: { content: text },
    });
  };

  const handleImageDragStart = (e: React.DragEvent) => {
    if (!imageUrl) return;
    draggingRef.current = true;
    setDragPayload(e, {
      kind: 'image',
      origin: { type: 'user-excerpt', excerptFromNodeId },
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
      source: 'excerpt',
      url: imageUrl,
      content: hasText ? text : undefined,
      label: t('node.pdfCapture'),
      originNodeId: expandedNodeId ?? undefined,
    };
    onSendToChat(attachment);
    onDismiss();
  }, [onSendToChat, imageUrl, hasText, text, expandedNodeId, onDismiss, t]);

  const handleSetCover = useCallback(() => {
    if (!onSetCover || !imageUrl) return;
    onSetCover(imageUrl);
    onDismiss();
  }, [onSetCover, imageUrl, onDismiss]);

  const dragBtnClass = clsx(
    'flex shrink-0 items-center justify-center gap-1 px-2.5 py-1.5',
    'text-xs text-fg-default',
    'hover:bg-info-bg',
    'cursor-grab active:cursor-grabbing',
  );

  return (
    <Popover
      position={position}
      onDismiss={guardedDismiss}
      className="grid auto-rows-auto"
    >
      {/* ── Text button: drag to canvas ── */}
      {hasText && (
        <DragToCanvasHandleButton
          iconSize={10}
          onDragStart={handleTextDragStart}
          onDragEnd={handleDragEnd}
          className={dragBtnClass}
          title={t('node.dragSelectedTextAsNote')}
        >
          <NODE_ICON.note size={14} className="shrink-0" />
        </DragToCanvasHandleButton>
      )}

      {/* ── Image button (or status) ── */}
      {capturing && (
        <div className="text-fg-subtle flex items-center gap-1 text-xs">
          <Loading layout="inline" size="xs" />
        </div>
      )}
      {isImageReady && (
        <DragToCanvasHandleButton
          iconSize={10}
          onDragStart={handleImageDragStart}
          onDragEnd={handleDragEnd}
          className={dragBtnClass}
          title={t('node.dragCapturedAreaAsImage')}
        >
          <NODE_ICON.image size={14} className="shrink-0" />
        </DragToCanvasHandleButton>
      )}

      {/* ── Send to Chat button ── */}
      {isImageReady && onSendToChat && imageUrl && (
        <Button
          variant="ghost"
          iconOnly
          className={clsx(dragBtnClass, '[&_svg]:h-auto [&_svg]:w-auto')}
          title={t('node.sendCapturedAreaToChat')}
          onClick={handleSendToChat}
        >
          {/* Plus icon matching the GripVertical icon width in DragToCanvasHandleButton */}
          <Plus size={10} className="shrink-0" />
          <MessageSquare size={14} className="shrink-0" />
        </Button>
      )}

      {/* ── Set as Cover button ── */}
      {isImageReady && onSetCover && imageUrl && (
        <Button
          variant="ghost"
          iconOnly
          className={clsx(dragBtnClass, '[&_svg]:h-auto [&_svg]:w-auto')}
          title={t('node.setCapturedAreaAsPdfCover')}
          onClick={handleSetCover}
        >
          <Plus size={10} className="shrink-0" />
          <Star size={14} className="shrink-0" />
        </Button>
      )}
    </Popover>
  );
};
