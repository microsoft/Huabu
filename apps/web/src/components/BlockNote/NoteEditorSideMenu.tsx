import { SideMenuExtension, SuggestionMenu } from '@blocknote/core/extensions';
import {
  SideMenu,
  useBlockNoteEditor,
  useExtension,
  useExtensionState,
  useSelectedBlocks,
} from '@blocknote/react';
import clsx from 'clsx';
import { GripVertical, Plus } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, type FC } from 'react';

import { GhostButton } from '@/components/Common/GhostButton';
import {
  SEDIMENT_DND_MIME,
  createDragId,
  type DragPayload,
  type NoteDragPayload,
} from '@/utils/io/dragDrop';

/**
 * Context that supplies the knowledge-base sourceId to the side menu.
 * Provided by the parent NotePreview so the drag payload records correct
 * provenance without an expensive store lookup.
 */
const NoteSourceIdContext = createContext<string | undefined>(undefined);
export const NoteSourceIdProvider = NoteSourceIdContext.Provider;

const ICON_SIZE = 16;
const BTN_CLASS =
  'bn-button h-4.5 w-4.5 p-px! text-icon hover:text-main flex items-center justify-center rounded';

/**
 * Custom "Add block" button that matches our compact style.
 * Inserts a new paragraph below the hovered block and opens the slash menu.
 */
const AddBlockButton: FC = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = useBlockNoteEditor<any, any, any>();
  const suggestionMenu = useExtension(SuggestionMenu);
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });

  const onClick = useCallback(() => {
    if (!block) return;

    const blockContent = block.content;
    const isEmpty =
      blockContent !== undefined &&
      Array.isArray(blockContent) &&
      blockContent.length === 0;

    if (isEmpty) {
      editor.setTextCursorPosition(block);
      suggestionMenu.openSuggestionMenu('/');
    } else {
      const inserted = editor.insertBlocks(
        [{ type: 'paragraph' }],
        block,
        'after',
      )[0];
      editor.setTextCursorPosition(inserted);
      suggestionMenu.openSuggestionMenu('/');
    }
  }, [block, editor, suggestionMenu]);

  if (!block) return null;

  return (
    <GhostButton aria-label="Add block" className={BTN_CLASS} onClick={onClick}>
      <Plus size={ICON_SIZE} className="shrink-0" />
    </GhostButton>
  );
};

/**
 * Custom drag-handle button that supports BOTH internal block reorder
 * (ProseMirror native) AND drag-to-canvas (Sediment DnD payload).
 *
 * Flow:
 * 1. `blockDragStart` sets up the PM selection, creates a drag image from the
 *    block DOM content, and populates dataTransfer with blocknote MIME data.
 *    It also marks `isDragOrigin = true` on the SideMenu plugin view.
 * 2. We stop propagation so ProseMirror's own dragstart handler does NOT fire
 *    (it would `clearData()`, wiping our Sediment payload).
 * 3. We manually set `view.dragging` (normally done by PM's handler) so that
 *    PM's internal drop handler can process in-editor reorder drops.
 * 4. We override `effectAllowed` from `"move"` to `"copyMove"` so the canvas
 *    drop target (which sets `dropEffect = "copy"`) can accept the drop.
 * 5. We attach the Sediment DnD payload for the canvas to recognise.
 * 6. In `onDragEnd`, if the browser reports `dropEffect === "copy"` (canvas
 *    accepted the drop), we collapse the PM selection. BlockNote's document-
 *    level `onDrop` capture handler has already scheduled
 *    `setTimeout(deleteSelection, 0)` — by collapsing the selection NOW
 *    (synchronously, before that timeout fires), the pending deletion becomes
 *    a no-op, preserving the source content in the editor.
 */
const DragHandleButton: FC = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = useBlockNoteEditor<any, any, any>();
  const sideMenu = useExtension(SideMenuExtension);
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });
  const selectedBlocks = useSelectedBlocks(editor);
  const sourceId = useContext(NoteSourceIdContext);

  // Capture the block reference at drag-start so we can use it in drag-end
  // even if the SideMenu state changes mid-drag.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dragBlockRef = useRef<any>(null);

  if (!block) return null;

  return (
    <GhostButton
      aria-label="Drag handle"
      draggable
      className={clsx(BTN_CLASS, 'mr-1 cursor-grab active:cursor-grabbing')}
      onDragStart={(e) => {
        // Prevent PM's own dragstart handler from firing — it calls
        // clearData() which would wipe our Sediment payload.
        e.stopPropagation();

        dragBlockRef.current = block;

        // --- 1. BlockNote native drag setup ---
        // Sets PM selection on block(s), creates drag image from the block
        // DOM content, populates dataTransfer with blocknote/html + text/*,
        // and sets isDragOrigin = true.
        sideMenu.blockDragStart(e.nativeEvent, block);

        // --- 2. Allow both move (internal reorder) and copy (canvas) ---
        e.dataTransfer.effectAllowed = 'copyMove';

        // --- 3. Set view.dragging for PM internal drop handling ---
        // PM's own dragstart handler normally does this, but we stopped
        // propagation. Without it PM's drop handler ignores internal drops.
        const view = editor.prosemirrorView;
        const slice = view.state.selection.content();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (view as any).dragging = { slice, move: true };

        // --- 4. Add Sediment DnD payload for canvas drop ---
        const dragBlocks = selectedBlocks.length > 1 ? selectedBlocks : [block];
        const md = editor.blocksToMarkdownLossy(dragBlocks).trim();
        if (!md) return;

        const payload: Omit<DragPayload, 'dragId'> & NoteDragPayload = {
          kind: 'note',
          origin: {
            type: 'user-drag-capture',
            ...(sourceId ? { sourceId } : {}),
          },
          data: {
            content: md,
            contentJson: JSON.stringify(dragBlocks),
          },
        };

        e.dataTransfer.setData(
          SEDIMENT_DND_MIME,
          JSON.stringify({ ...payload, dragId: createDragId() }),
        );
      }}
      onDragEnd={(e) => {
        if (e.dataTransfer.dropEffect === 'copy') {
          // Dropped on canvas. BlockNote's document-level onDrop (capture)
          // already scheduled `setTimeout(deleteSelection, 0)` because
          // isDragOrigin was true and isDropPoint was false.
          //
          // Collapse the PM selection NOW so that the pending
          // deleteSelection() becomes a no-op (empty selection = nothing
          // to delete).
          try {
            if (dragBlockRef.current) {
              editor.setTextCursorPosition(dragBlockRef.current, 'start');
            }
          } catch {
            // Block may no longer exist — safe to ignore.
          }
        }

        sideMenu.blockDragEnd();
        dragBlockRef.current = null;
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <GripVertical size={ICON_SIZE} className="shrink-0" />
    </GhostButton>
  );
};

/**
 * A compact SideMenu for the NotePreview editor.
 * Visually matches the drag handle used in BlockNoteCard.
 */
export const NoteEditorSideMenu: FC = () => {
  return (
    <SideMenu>
      <AddBlockButton />
      <DragHandleButton />
    </SideMenu>
  );
};
