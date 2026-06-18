/**
 * Milkdown-backed renderer for AI chat messages.
 */

import { useMemo } from 'react';

import { resolveArtifactUrl } from '@/api/artifact';
import { MilkdownPreview } from '@/components/Milkdown';
import useCanvasStore from '@/store/canvasStore';
import { setDragPayload } from '@/utils/io/dragDrop';

import type { NoteDragPayload } from '@/utils/io/dragDrop';
import type { NodeOrigin } from '@sediment/shared';
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
 * Markdown image syntax matcher: `![alt](src)` or `![alt](src "title")`.
 *
 *  - `alt` may contain anything except `]` (greedy stops at first `]`)
 *  - `src` is the bare URL/key (no whitespace, no closing paren)
 *  - optional title in double quotes after one or more spaces
 *
 * Stays intentionally simple: we don't try to skip code blocks because
 * (a) AI chat replies almost never embed `![...](...)` inside fenced
 * code, and (b) even if they do, `resolveArtifactUrl` is idempotent so
 * a false-positive rewrite is still legal markdown — only cosmetic.
 */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

/**
 * Rewrite `![alt](src)` images so bare artifact keys (e.g.
 * `art_xyz.png`, the form returned by the `generate_image` tool)
 * become fully-qualified `/api/canvas/<id>/artifact/<key>` URLs the
 * browser can actually fetch.
 *
 * Pass-through for `data:` URLs, full `http(s)` URLs, and `/api/`
 * paths — `resolveArtifactUrl` handles every shape idempotently.
 */
export function rewriteChatImageUrls(
  markdown: string,
  canvasId: string | null,
): string {
  if (!markdown || !canvasId) return markdown;
  return markdown.replace(MD_IMAGE_RE, (match, alt, src, title) => {
    const resolved = resolveArtifactUrl(String(src), canvasId);
    if (resolved === src) return match;
    return `![${alt}](${resolved}${title ?? ''})`;
  });
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

export const MilkdownMessageCard: FC<MilkdownMessageCardProps> = ({
  content,
  threadId,
}) => {
  // Pull the active canvas id so we can rewrite bare artifact keys
  // (which the `generate_image` tool emits as `art_xxx.png`) into
  // fully-qualified `/api/canvas/<id>/artifact/<key>` URLs. Without
  // this, AI-generated images render as broken-image placeholders
  // in chat because the browser tries to GET `art_xxx.png` against
  // the SPA origin.
  const canvasId = useCanvasStore((s) => s.canvasId);
  const rewritten = useMemo(
    () => rewriteChatImageUrls(content, canvasId),
    [content, canvasId],
  );

  return (
    <MilkdownPreview
      markdown={rewritten}
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
