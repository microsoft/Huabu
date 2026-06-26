/**
 * Convert a Sediment drag payload to a Markdown snippet that can be
 * inserted into a Note.
 *
 * Used by the note-side drop handlers (`NotePreview` for precise
 * cursor insertion, `NoteNode` for end-of-document append) so all
 * payload kinds map through one place.
 *
 * The mapping is deliberately simple:
 *  - `note`  → the payload's markdown content verbatim.
 *  - `image` → a Markdown image (`![label](src)`); falls back to the
 *               bare src as a paragraph when no label is present. When
 *               a `canvasId` is supplied the src is run through
 *               `resolveArtifactUrl` first so artifact-key payloads
 *               (e.g. chat-image drags carrying `art_xxx.png`) end up
 *               with a fetchable HTTP URL — without this the
 *               resulting `<img>` would silently fail to load inside
 *               the note's markdown renderer.
 *  - `web`   → a Markdown autolink (`<src>`). The user can wrap or
 *               retitle it later; we don't fabricate a label.
 *
 * Returns `null` when the payload kind has nothing meaningful to
 * embed (e.g. a future payload kind we don't recognise).
 */

import { resolveArtifactUrl } from '@/api/artifact';

import type { DragPayload } from './dragDrop';

export interface PayloadToMarkdownOptions {
  /**
   * Canvas id used to resolve artifact-key srcs (e.g. `art_abc.png`)
   * into fetchable HTTP URLs. When omitted, image srcs are emitted
   * verbatim — only safe when the caller knows the payload already
   * carries an absolute URL.
   */
  canvasId?: string;
}

/**
 * Escape Markdown-control characters in a label so it can safely
 * appear inside an image-alt or link-text. Conservative: we only
 * escape the chars that would change the meaning of the surrounding
 * markup, not every Markdown special character.
 */
function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/g, (m) => `\\${m}`);
}

export function dragPayloadToMarkdown(
  payload: DragPayload,
  options: PayloadToMarkdownOptions = {},
): string | null {
  switch (payload.kind) {
    case 'note': {
      const content = payload.data.content.trim();
      return content === '' ? null : content;
    }
    case 'image': {
      const rawSrc = payload.data.src.trim();
      if (rawSrc === '') return null;
      const src = options.canvasId
        ? resolveArtifactUrl(rawSrc, options.canvasId)
        : rawSrc;
      const rawLabel =
        typeof payload.data.label === 'string' ? payload.data.label.trim() : '';
      const alt = rawLabel === '' ? '' : escapeLabel(rawLabel);
      return `![${alt}](${src})`;
    }
    case 'web': {
      const src = payload.data.src.trim();
      if (src === '') return null;
      // Markdown autolink — renders as a clickable link with the URL
      // as its visible text. Easier to retitle later than a bare URL.
      return `<${src}>`;
    }
    default: {
      // Exhaustiveness check — TypeScript will complain if a new
      // payload kind is added to the union but not handled here.
      const _exhaustive: never = payload;
      void _exhaustive;
      return null;
    }
  }
}
