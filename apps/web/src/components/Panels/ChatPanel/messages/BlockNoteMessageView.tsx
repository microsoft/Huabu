import {
  DragHandleButton,
  SideMenu,
  SideMenuController,
  type SideMenuProps,
  useCreateBlockNote,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useEffect, useRef, type FC } from 'react';

interface BlockNoteMessageViewProps {
  content: string;
  debounceMs?: number;
}

const EmptyDragHandleMenu: FC = () => null;

const ReadOnlyDragHandleSideMenu: FC<SideMenuProps> = (props) => {
  return (
    <SideMenu {...props}>
      <DragHandleButton dragHandleMenu={EmptyDragHandleMenu} />
    </SideMenu>
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

  useEffect(() => {
    const mySeq = ++parseSeqRef.current;
    const handle = setTimeout(() => {
      void (async () => {
        const markdown = content.trim() === '' ? '\n' : content;
        const blocks = await editor.tryParseMarkdownToBlocks(markdown);

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
        <SideMenuController sideMenu={ReadOnlyDragHandleSideMenu} />
      </BlockNoteView>
    </div>
  );
};
