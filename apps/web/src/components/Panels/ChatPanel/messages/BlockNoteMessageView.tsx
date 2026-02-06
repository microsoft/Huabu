import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  SideMenu,
  SideMenuController,
  useCreateBlockNote,
  useBlockNoteEditor,
  useExtensionState,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { GripVertical } from 'lucide-react';
import { useEffect, useRef, type FC } from 'react';

import { setDragPayload } from '../../../../utils/dragDrop';

interface BlockNoteMessageViewProps {
  content: string;
  debounceMs?: number;
}

const blockToPlainText = (block: unknown): string => {
  if (!block || typeof block !== 'object') return '';

  const content = (block as { content?: unknown }).content;
  const children = (block as { children?: unknown }).children;

  const inlineToText = (inline: unknown): string => {
    if (inline === null || inline === undefined) return '';
    if (typeof inline === 'string') return inline;
    if (typeof inline !== 'object') return '';

    const text = (inline as { text?: unknown }).text;
    if (typeof text === 'string') return text;

    const nested = (inline as { content?: unknown }).content;
    if (Array.isArray(nested)) return nested.map(inlineToText).join('');

    return '';
  };

  const thisBlockText =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
      ? content.map(inlineToText).join('')
      : '';

  const childrenText = Array.isArray(children)
    ? children
        .map(blockToPlainText)
        .map((t) => t.trim())
        .filter(Boolean)
        .join('\n')
    : '';

  if (!childrenText) return thisBlockText;
  if (!thisBlockText) return childrenText;
  return `${thisBlockText}\n${childrenText}`;
};

type NoteDragHandleButtonProps = {
  getSelectedText: () => string;
  onCacheSelection: () => void;
  dragImageRootElement: HTMLElement | null;
};

const NoteDragHandleButton: FC<NoteDragHandleButtonProps> = (props) => {
  const editor = useBlockNoteEditor<any, any, any>();
  const hoveredBlock = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });

  const getHoveredBlockDragImageElement = () => {
    const root = props.dragImageRootElement;
    const blockId = (hoveredBlock as { id?: unknown } | undefined)?.id;
    if (!root || typeof blockId !== 'string' || blockId.trim() === '') {
      return root;
    }

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

  return (
    <button
      type="button"
      aria-label="Drag block to canvas"
      draggable
      className="bn-button"
      onMouseDownCapture={(e) => {
        props.onCacheSelection();
        e.stopPropagation();
      }}
      onDragStart={(e) => {
        e.stopPropagation();

        const selection = props.getSelectedText().trim();
        const hoveredBlockText = blockToPlainText(hoveredBlock).trim();
        const noteContent = selection !== '' ? selection : hoveredBlockText;
        if (noteContent.trim() === '') return;

        const dragImageElement = getHoveredBlockDragImageElement();

        setDragPayload(
          e,
          {
            kind: 'note',
            data: {
              content: noteContent,
            },
          },
          {
            fallbackText: noteContent,
            dragImageElement,
          },
        );
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <GripVertical size={16} />
    </button>
  );
};

export const BlockNoteMessageView = ({
  content,
  debounceMs = 150,
}: BlockNoteMessageViewProps) => {
  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  const parseSeqRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const selectedTextRef = useRef<string>('');

  const getSelectedText = () => {
    try {
      const selection = window.getSelection?.();
      if (!selection) return '';

      const text = selection.toString() ?? '';
      if (text.trim() === '') return '';

      const container = wrapperRef.current;
      if (!container) return '';

      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (!anchorNode || !focusNode) return '';

      // Only treat it as a "selection" if it's within this message.
      if (!container.contains(anchorNode) || !container.contains(focusNode)) {
        return '';
      }

      return text;
    } catch {
      return '';
    }
  };

  const cacheSelection = () => {
    selectedTextRef.current = getSelectedText();
  };

  const ReadOnlySideMenu: FC = () => {
    return (
      <SideMenu>
        <NoteDragHandleButton
          getSelectedText={() => selectedTextRef.current}
          onCacheSelection={cacheSelection}
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
            blocks = lines
              .map((line) => line.trimEnd())
              .filter((line) => line.trim() !== '')
              .map((line) => ({ type: 'paragraph', content: line }));
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
