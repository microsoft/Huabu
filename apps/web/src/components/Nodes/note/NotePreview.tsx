/**
 * Milkdown-backed note preview.
 *
 * Replaces the legacy BlockNote implementation. The contract with the
 * sibling preview components (`PreviewComponentProps`) is unchanged so
 * the rest of the canvas / agent stack continues to work without
 * modification.
 *
 * Phase 3 specifically:
 *  - Reads only `data.content` (Markdown). The legacy auxiliary
 *    fields `data.contentJson` / `data.contentJsonSource` may still
 *    exist on historical records but are NEITHER read NOR written
 *    here (per `docs/milkdown-migration-plan.md` §3.1 destructive
 *    schema migration is reserved for Phase 6).
 *  - Inline diff / Accept-Reject / SideMenu UI from the BlockNote
 *    version is intentionally absent: provenance is a Phase 4
 *    concern. The server may still send `data.provenance` payloads;
 *    they are passed through to disk unchanged so Phase 4 can light
 *    them up later, but no UI surfaces them yet.
 *  - Block drag-out onto the canvas is wired via
 *    `MilkdownEditor.onBlockDragStart` (shared helper, same drag
 *    image as the chat-card `MilkdownPreview`).
 */

import { useCallback, useRef } from 'react';

import { MilkdownEditor } from '@/components/Milkdown';
import { setDragPayload } from '@/utils/io/dragDrop';

import type { MilkdownBlockDragEvent } from '@/components/Milkdown';
import type { NoteDragPayload } from '@/utils/io/dragDrop';
import type { NodeOrigin } from '@sediment/shared';

export interface PreviewComponentProps {
  /** Canvas node id, when this preview is bound to a real node. */
  id?: string;
  data: Record<string, unknown>;
  readOnly?: boolean;
  /** Called with a plain string for backward-compat consumers. */
  onContentChange?: (newContent: string) => void;
  /**
   * Preferred over `onContentChange` when available.
   *
   * The patch shape is intentionally minimal in Phase 3 — only
   * `content` (Markdown) is written. Historical `contentJson` /
   * `contentJsonSource` fields are NOT touched (neither set nor
   * cleared) so Phase 6 can do the destructive removal in its own PR.
   */
  onDataChange?: (patch: Record<string, unknown>) => void;
}

export const NotePreview = ({
  id,
  data,
  readOnly,
  onContentChange,
  onDataChange,
}: PreviewComponentProps) => {
  // `content` is the canonical Markdown string. Brand-new note records
  // may have it absent or non-string; normalise to empty.
  const markdown = typeof data.content === 'string' ? data.content : '';

  // Defense-in-depth dedup: if the user's edit happens to round-trip
  // back through the parent and re-arrive identical to what we just
  // emitted, short-circuit instead of looping. `MilkdownEditor` already
  // does this internally via `lastSyncedRef`, but keeping a local copy
  // hardens against parents that mutate the data shape mid-flight.
  const lastEmittedMarkdownRef = useRef<string>(markdown);
  lastEmittedMarkdownRef.current = markdown;

  const writePatch = useCallback(
    (newMarkdown: string) => {
      if (onDataChange) {
        onDataChange({ content: newMarkdown });
      } else if (onContentChange) {
        onContentChange(newMarkdown);
      }
    },
    [onDataChange, onContentChange],
  );

  const handleEditorChange = useCallback(
    (next: string) => {
      if (readOnly) return;
      if (!onContentChange && !onDataChange) return;
      if (next === lastEmittedMarkdownRef.current) return;

      lastEmittedMarkdownRef.current = next;
      writePatch(next);
    },
    [readOnly, onContentChange, onDataChange, writePatch],
  );

  const handleBlockDragStart = useCallback(
    (event: MilkdownBlockDragEvent) => {
      const trimmed = event.markdown.trim();
      if (!trimmed) return;

      // Mirror the legacy BlockNote SideMenu origin so the canvas drop
      // handler can link the new node back to its source.
      const origin: NodeOrigin = id
        ? { type: 'user-excerpt', excerptFromNodeId: id }
        : { type: 'user-excerpt' };

      const payload: Omit<NoteDragPayload & { origin: NodeOrigin }, 'dragId'> =
        {
          kind: 'note',
          origin,
          data: { content: trimmed },
        };

      // `nativeEvent.dataTransfer` is non-null inside a dragstart fired
      // by HTML5 native drag (which is what Crepe's BlockService uses).
      // Type mismatch: `MilkdownBlockDragEvent.nativeEvent` is native
      // `DragEvent`, but `setDragPayload` expects `React.DragEvent`.
      // Both have the required `dataTransfer` / `clientX` / `clientY` props,
      // so we cast through `unknown` to satisfy TypeScript.
      //
      // The drag image is owned by `attachBlockDragListeners` inside
      // the Milkdown wrapper — we only contribute the SEDIMENT-mime
      // payload here.
      setDragPayload(event.nativeEvent as unknown as React.DragEvent, payload);
    },
    [id],
  );

  return (
    <div className="bg-surface relative h-full w-full">
      <div className="custom-scrollbar relative h-full w-full overflow-auto py-3">
        <MilkdownEditor
          markdown={markdown}
          editable={!readOnly}
          onChange={handleEditorChange}
          onBlockDragStart={readOnly ? undefined : handleBlockDragStart}
          className="milkdown-note-preview"
        />
      </div>
    </div>
  );
};
