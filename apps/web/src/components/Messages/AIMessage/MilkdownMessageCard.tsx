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
 * Markdown image AND link syntax matcher: `![alt](src)` or `[text](src)`,
 * each with optional `"title"` suffix.
 *
 *  - `!` (capturing group 1, empty for plain links) distinguishes the two
 *    forms so the rewriter can preserve the original sigil.
 *  - `alt` / `text` may contain anything except `]`.
 *  - `src` is the bare URL/key (no whitespace, no closing paren).
 *  - optional `"title"` after one or more spaces.
 *
 * We promote bare artifact keys in BOTH forms because some agents emit
 * `[caption](art_xxx.png)` link syntax thinking it gives the user a
 * "download link" — without rewriting, the resulting `<a href>` points
 * to a non-resolvable bare key. After the rewrite the link at least
 * opens the image in a new tab; image embeds (`![]()`) keep working as
 * before.
 *
 * Stays intentionally simple: we don't try to skip code blocks because
 * (a) AI chat replies almost never embed `![...](...)` or
 * `[...](...)` inside fenced code aimed at the user, and (b)
 * `resolveArtifactUrl` is idempotent so a false-positive rewrite is
 * still legal markdown — only cosmetic.
 */
const MD_LINK_OR_IMAGE_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

/**
 * Rewrite `![alt](src)` images AND `[text](src)` links so bare
 * artifact keys (e.g. `art_xyz.png`, the form returned by the
 * `generate_image` tool) become fully-qualified
 * `/api/canvas/<id>/artifact/<key>` URLs the browser can actually
 * fetch.
 *
 * Pass-through for `data:` URLs, full `http(s)` URLs, and `/api/`
 * paths — `resolveArtifactUrl` handles every shape idempotently.
 */
export function rewriteChatImageUrls(
  markdown: string,
  canvasId: string | null,
): string {
  if (!markdown || !canvasId) return markdown;
  return markdown.replace(
    MD_LINK_OR_IMAGE_RE,
    (match, bang, alt, src, title) => {
      const resolved = resolveArtifactUrl(String(src), canvasId);
      if (resolved === src) return match;
      return `${bang}[${alt}](${resolved}${title ?? ''})`;
    },
  );
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
