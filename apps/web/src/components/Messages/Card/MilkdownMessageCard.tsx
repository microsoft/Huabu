/**
 * Milkdown-backed replacement for `BlockNoteCard`.
 *
 * Selected via the `VITE_MESSAGE_RENDERER` feature flag in
 * `AIMessage.tsx` (default `milkdown`). The legacy BlockNote-based card
 * is kept on disk so we can flip back to it at any time during the
 * migration; Phase 6 of `docs/milkdown-migration-plan.md` removes it.
 */

import { MilkdownPreview } from '@/components/Milkdown';
import { useChatStore } from '@/store/chatStore';
import { setDragPayload } from '@/utils/io/dragDrop';

import type { NoteDragPayload } from '@/utils/io/dragDrop';
import type { NodeOrigin } from '@sediment/shared';
import type { FC } from 'react';

interface MilkdownMessageCardProps {
  content: string;
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
        // Phase 2 ships markdown-only; the legacy `contentJson` field
        // is preserved on the wire for back-compat but no longer
        // produced. See Phase 6 in the migration plan.
        content: trimmed,
      },
    },
  };
}

export const MilkdownMessageCard: FC<MilkdownMessageCardProps> = ({
  content,
}) => {
  const threadId = useChatStore((s) => s.threadId);

  return (
    <MilkdownPreview
      markdown={content}
      enableBlockDrag
      onBlockDragStart={({ markdown, nativeEvent }) => {
        const built = buildNoteDragPayload(markdown, threadId);
        if (!built) return;

        // `nativeEvent.dataTransfer` is non-null inside a dragstart
        // fired by HTML5 native drag (which is what Crepe's
        // BlockService uses). `setDragPayload` accepts both React and
        // native DragEvent — it only reads `dataTransfer`, `clientX`,
        // and `clientY`.
        //
        // `MilkdownPreview` owns the drag image: it clones the dragged
        // block(s) into a `document.body`-mounted host (light DOM,
        // because Chromium's drag-image rasterizer has known issues
        // snapshotting Shadow DOM contents) and rebuilds the
        // `.milkdown .ProseMirror` ancestor chain so theme + KaTeX
        // styles in `document.head` still apply. We only contribute
        // the SEDIMENT-mime payload here.
        setDragPayload(
          nativeEvent as unknown as React.DragEvent,
          built.payload,
        );
      }}
    />
  );
};
