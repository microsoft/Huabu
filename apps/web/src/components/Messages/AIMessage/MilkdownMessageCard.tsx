// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Milkdown-backed renderer for AI chat messages.
 */

import { parseArtifactUrl } from '@huabu/shared';

import { MilkdownPreview } from '@/components/Milkdown';
import useCanvasStore from '@/store/canvasStore';
import { setDragPayload } from '@/utils/io/dragDrop';

import type { ImageDragPayload, NoteDragPayload } from '@/utils/io/dragDrop';
import type { NodeOrigin } from '@huabu/shared';
import type { FC } from 'react';

interface MilkdownMessageCardProps {
  content: string;
  /**
   * Thread id passed down by the parent message component. Threaded
   * through props (rather than re-read from `useChatStore` inside this
   * card) so the parent can keep a single subscription per message and
   * we don't subscribe N times for N rendered cards.
   */
  threadId: string;
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

export const MilkdownMessageCard: FC<MilkdownMessageCardProps> = ({
  content,
  threadId,
}) => {
  const canvasId = useCanvasStore((s) => s.canvasId);

  return (
    <MilkdownPreview
      markdown={content}
      canvasId={canvasId ?? undefined}
      enableBlockDrag
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
  );
};
