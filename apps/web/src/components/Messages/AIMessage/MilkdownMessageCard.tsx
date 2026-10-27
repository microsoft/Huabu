// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Milkdown-backed renderer for AI chat messages.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { parseArtifactUrl } from '@huabu/shared';

import { MilkdownPreview } from '@/components/Milkdown';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { copyToClipboard } from '@/utils/io/clipboard';
import { createDragId, setDragPayload } from '@/utils/io/dragDrop';
import { openDocumentLink } from '@/utils/openDocumentLink';

import { FragmentCommentPopover } from './FragmentCommentPopover';

import type { MilkdownPreviewSelection } from '@/components/Milkdown/MilkdownPreview';
import type { ImageDragPayload, NoteDragPayload } from '@/utils/io/dragDrop';
import type { NodeOrigin } from '@huabu/shared';

interface MilkdownMessageCardProps {
  content: string;
  /**
   * Thread id passed down by the parent message component. Threaded
   * through props (rather than re-read from `useChatStore` inside this
   * card) so the parent can keep a single subscription per message and
   * we don't subscribe N times for N rendered cards.
   */
  threadId: string;
  messageId?: string;
  segmentIndex?: number;
  enableComments?: boolean;
}

/**
 * Pure helper that turns a single block markdown into the
 * `setDragPayload` arguments. Extracted so it can be unit-tested
 * without mounting Crepe (which needs a real DOM).
 *
 * Returns `null` when the payload would be empty — callers should skip
 * `dataTransfer.setData` in that case.
 */
export function buildNoteDragPayload(
  markdown: string,
  threadId: string,
): {
  payload: Omit<NoteDragPayload & { origin: NodeOrigin }, 'dragId'>;
} | null {
  const trimmed = markdown.trim();
  if (!trimmed) return null;
  return {
    payload: {
      kind: 'note',
      origin: { type: 'user-from-chat', threadId },
      data: {
        content: trimmed,
      },
    },
  };
}

const PURE_IMAGE_BLOCK_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

export function buildImageDragPayload(
  markdown: string,
  threadId: string,
  canvasId: string | null,
): {
  payload: Omit<ImageDragPayload & { origin: NodeOrigin }, 'dragId'>;
} | null {
  const match = PURE_IMAGE_BLOCK_RE.exec(markdown);
  if (!match) return null;

  const alt = match[1] ?? '';
  const rawSrc = match[2] ?? '';
  if (!rawSrc) return null;

  const parsed = parseArtifactUrl(rawSrc);
  const src =
    parsed && canvasId && parsed.canvasId === canvasId ? parsed.key : rawSrc;

  const label = alt.trim() || undefined;

  return {
    payload: {
      kind: 'image',
      origin: { type: 'user-from-chat', threadId },
      data: {
        src,
        ...(label !== undefined ? { label } : {}),
      },
    },
  };
}

export const MilkdownMessageCard = memo(function MilkdownMessageCard({
  content,
  threadId,
  messageId,
  enableComments = false,
}: MilkdownMessageCardProps) {
  const canvasId = useCanvasStore((s) => s.canvasId);
  const [selection, setSelection] = useState<MilkdownPreviewSelection | null>(
    null,
  );
  const editingRef = useRef(false);
  const handleTextSelection = useCallback(
    (next: MilkdownPreviewSelection | null) => {
      if (!editingRef.current) setSelection(next);
    },
    [],
  );
  const dismissComment = useCallback(() => {
    editingRef.current = false;
    setSelection(null);
  }, []);
  useEffect(() => {
    if (!enableComments) dismissComment();
  }, [enableComments, dismissComment]);
  const handleLinkClick = useCallback(
    (href: string) => openDocumentLink(href, { threadId }),
    [threadId],
  );

  return (
    <>
      <MilkdownPreview
        markdown={content}
        canvasId={canvasId ?? undefined}
        onLinkClick={handleLinkClick}
        linkActivation="plain"
        onTextSelection={
          enableComments && messageId ? handleTextSelection : undefined
        }
        enableBlockDrag
        getTouchDragPayload={(markdown) => {
          const built =
            buildImageDragPayload(markdown, threadId, canvasId) ??
            buildNoteDragPayload(markdown, threadId);
          return built ? { ...built.payload, dragId: createDragId() } : null;
        }}
        onBlockDragStart={({ markdown, nativeEvent }) => {
          const built =
            buildImageDragPayload(markdown, threadId, canvasId) ??
            buildNoteDragPayload(markdown, threadId);
          if (!built) return;

          setDragPayload(
            nativeEvent as unknown as React.DragEvent,
            built.payload,
          );
        }}
      />
      {enableComments && messageId && selection ? (
        <FragmentCommentPopover
          selection={selection}
          onCopy={() => copyToClipboard(selection.text)}
          onSaveAsNote={() => {
            useCanvasStore.getState().addNode({
              nodeType: 'note',
              data: {
                content: selection.markdown,
                origin: { type: 'user-from-chat', threadId },
              },
            });
            dismissComment();
          }}
          onBegin={() => {
            editingRef.current = true;
          }}
          onDismiss={dismissComment}
          onAdd={(comment) => {
            useChatStore.getState().addQuotedComment(threadId, {
              quote: selection.text,
              contextBefore: selection.contextBefore,
              contextAfter: selection.contextAfter,
              comment,
            });
            dismissComment();
            usePanelStore.getState().requestFocusChatInput(threadId);
          }}
        />
      ) : null}
    </>
  );
});
