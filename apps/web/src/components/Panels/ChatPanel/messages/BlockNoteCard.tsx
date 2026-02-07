import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  SideMenu,
  SideMenuController,
  useCreateBlockNote,
  useExtensionState,
  useSelectedBlocks,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useEffect, useRef, type FC } from 'react';

import {
  setDragPayload,
  type DragImageOffset,
} from '../../../../utils/dragDrop';
import { DragToCanvasHandleButton } from '../../../Common/DragToCanvasHandleButton';

interface BlockNoteMessageViewProps {
  content: string;
  debounceMs?: number;
}

type NoteDragHandleButtonProps = {
  editor: ReturnType<typeof useCreateBlockNote>;
  dragImageRootElement: HTMLElement | null;
};

const NoteDragHandleButton: FC<NoteDragHandleButtonProps> = (props) => {
  const editor = props.editor;
  const selectedBlocks = useSelectedBlocks(editor);
  const hoveredBlock = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });

  const getBlockDragImageElement = (blockId: string) => {
    const root = props.dragImageRootElement;
    if (!root || blockId.trim() === '') return root;

    // BlockNote renders blocks with `data-id` and `id` set to the block id.
    // Prefer `.bn-block` so the drag preview matches the visible content.
    const escapedId = CSS.escape(blockId);
    return (
      root.querySelector<HTMLElement>(`.bn-block[data-id="${escapedId}"]`) ??
      root.querySelector<HTMLElement>(
        `.bn-block-outer[data-id="${escapedId}"]`,
      ) ??
      root.querySelector<HTMLElement>(`#${escapedId}`) ??
      root
    );
  };

  const createSelectedBlocksDragImageElement = () => {
    const root = props.dragImageRootElement;
    if (!root) return null;

    const blockIds = selectedBlocks.map((block) => block.id);

    if (blockIds.length < 2) return null;

    const blockElements: HTMLElement[] = [];
    for (const blockId of blockIds) {
      const el = getBlockDragImageElement(blockId);
      if (el && el !== root) blockElements.push(el);
    }

    if (blockElements.length < 2) return null;

    // Build a temporary element for the drag preview.
    const container = document.createElement('div');
    const rootRect = root.getBoundingClientRect();
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    // Match the message width so wrapping looks like the source.
    if (rootRect.width > 0) container.style.width = `${rootRect.width}px`;

    const stripIds = (node: Node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      el.removeAttribute('id');
      for (const child of Array.from(el.children)) stripIds(child);
    };

    for (const el of blockElements) {
      const cloned = el.cloneNode(true);
      stripIds(cloned);
      container.appendChild(cloned);
    }

    return container;
  };

  return (
    <DragToCanvasHandleButton
      className="bn-button"
      onDragStart={(e) => {
        e.stopPropagation();

        let noteContent = '';
        let dragImageElement: HTMLElement | null = null;
        let dragImageOffset: DragImageOffset | undefined;
        // Prefer selected blocks when a selection exists, so we keep block-level structure.
        if (selectedBlocks.length > 1) {
          noteContent = editor.blocksToMarkdownLossy(selectedBlocks).trim();
          const selectedBlocksDragImage =
            createSelectedBlocksDragImageElement();
          dragImageElement = selectedBlocksDragImage;

          const firstSelectedId = (selectedBlocks[0] as { id?: unknown } | null)
            ?.id;
          if (typeof firstSelectedId === 'string' && dragImageElement) {
            const dragImageOffsetTarget =
              getBlockDragImageElement(firstSelectedId);
            const rect = dragImageOffsetTarget?.getBoundingClientRect();
            if (rect) {
              dragImageOffset = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
              };
            }
          }
        } else if (hoveredBlock) {
          noteContent = editor.blocksToMarkdownLossy([hoveredBlock]).trim();
          dragImageElement = getBlockDragImageElement(hoveredBlock.id);
        }
        if (noteContent.trim() === '') return;

        setDragPayload(
          e,
          {
            kind: 'note',
            data: {
              content: noteContent,
            },
          },
          {
            dragImageElement,
            dragImageOffset,
          },
        );
      }}
    />
  );
};

export const BlockNoteCard = ({
  content,
  debounceMs = 150,
}: BlockNoteMessageViewProps) => {
  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  const parseSeqRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const ReadOnlySideMenu: FC = () => {
    return (
      <SideMenu>
        <NoteDragHandleButton
          editor={editor}
          dragImageRootElement={wrapperRef.current}
        />
      </SideMenu>
    );
  };

  useEffect(() => {
    const mySeq = ++parseSeqRef.current;
    const handle = setTimeout(() => {
      void (async () => {
        const markdown = content.trim() === '' ? '\n' : content;
        let blocks = await editor.tryParseMarkdownToBlocks(markdown);

        // If the markdown parses into a single paragraph but contains newlines,
        // treat each line as its own paragraph block. This makes the per-block
        // side menu (handle) usable for "each line" content in chat messages.
        if (
          markdown.includes('\n') &&
          blocks.length === 1 &&
          (blocks[0] as { type?: unknown }).type === 'paragraph'
        ) {
          const lines = markdown.split(/\r?\n/);
          if (lines.length > 1) {
            const normalizedLines = lines
              .map((line) => line.trimEnd())
              .filter((line) => line.trim() !== '');

            // Re-parse as markdown paragraphs to get valid BlockNote blocks
            // (with ids/props) instead of constructing block objects manually.
            const reparsedMarkdown = normalizedLines.join('\n\n');
            blocks = await editor.tryParseMarkdownToBlocks(reparsedMarkdown);
          }
        }

        if (parseSeqRef.current !== mySeq) return;

        editor.replaceBlocks(editor.document, blocks);
      })();
    }, debounceMs);

    return () => {
      clearTimeout(handle);
    };
  }, [content, debounceMs, editor]);

  return (
    <div
      ref={wrapperRef}
      className="group relative"
      onBeforeInputCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDownCapture={(e) => {
        const isModifierOnly =
          e.key === 'Shift' ||
          e.key === 'Control' ||
          e.key === 'Alt' ||
          e.key === 'Meta';
        if (isModifierOnly) return;

        const navigationKeys = new Set([
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'Escape',
        ]);
        if (navigationKeys.has(e.key)) return;

        const key = e.key.toLowerCase();
        const isCopyOrSelectAll =
          (e.ctrlKey || e.metaKey) && (key === 'c' || key === 'a');
        if (isCopyOrSelectAll) return;

        e.preventDefault();
        e.stopPropagation();
      }}
      onPasteCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onCutCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragOverCapture={(e) => {
        // Do not call preventDefault here; that would make this a valid drop target.
        // We only want to prevent internal drag/drop editing behaviors.
        e.stopPropagation();
      }}
      onDropCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <BlockNoteView
        className="noteview-readonly"
        editor={editor}
        editable={true}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        emojiPicker={false}
        tableHandles={false}
        filePanel={false}
        sideMenu={false}
      >
        <SideMenuController sideMenu={ReadOnlySideMenu} />
      </BlockNoteView>
    </div>
  );
};
