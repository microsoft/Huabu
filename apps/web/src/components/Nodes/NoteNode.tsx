import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { type Node, type NodeProps } from '@xyflow/react';
import { StickyNote, Copy, Check, Fullscreen } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NodeWrapper } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';
import { copyToClipboard } from '../../utils/clipboard.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { NodeDataProps } from './types.ts';

type NoteNodeData = NodeDataProps & {
  content?: string;
};
export type NoteNodeType = Node<NoteNodeData, 'note'>;

export const NoteNode = ({ id, data, selected }: NodeProps<NoteNodeType>) => {
  const [copied, setCopied] = useState(false);
  const openExpanded = useCanvasStore((s) => s.openExpanded);
  const shadowHostRef = useRef<HTMLDivElement>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);
  const reactRootRef = useRef<Root | null>(null);
  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  const handleCopy = () => {
    if (data.content) {
      copyToClipboard(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const NoteToolbar = (
    <div className="flex w-full items-center justify-between gap-2">
      {/* Label */}
      <div className="text-muted-foreground">
        <StickyNote size={14} />
      </div>
      {/* spliter */}
      <div className="bg-border h-3 w-px" />
      {/* Tools */}
      <div className="text-muted-foreground flex items-center gap-1">
        <GhostButton
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen size={14} />
        </GhostButton>

        <GhostButton title="Copy Content" onClick={handleCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </GhostButton>
      </div>
    </div>
  );

  // Initialize Shadow DOM
  useEffect(() => {
    if (!shadowHostRef.current) return;

    // Check if shadow root already exists on the DOM element
    if (shadowHostRef.current.shadowRoot) {
      shadowRootRef.current = shadowHostRef.current.shadowRoot;
      return;
    }

    // Create Shadow DOM
    const shadowRoot = shadowHostRef.current.attachShadow({ mode: 'open' });
    shadowRootRef.current = shadowRoot;

    // Create container for React content
    const container = document.createElement('div');
    container.className = 'flex h-full flex-col rounded bg-white p-4';
    shadowRoot.appendChild(container);

    // Inject styles into Shadow DOM using link tags for external stylesheets
    // and inline styles for embedded styles
    const existingStyleLinks = document.querySelectorAll(
      'link[rel="stylesheet"]',
    );
    existingStyleLinks.forEach((link) => {
      const clonedLink = link.cloneNode(true) as HTMLLinkElement;
      shadowRoot.appendChild(clonedLink);
    });

    // Also copy inline styles
    const existingStyles = document.querySelectorAll('style');
    existingStyles.forEach((style) => {
      const clonedStyle = style.cloneNode(true) as HTMLStyleElement;
      shadowRoot.appendChild(clonedStyle);
    });

    // Create React root in Shadow DOM
    reactRootRef.current = createRoot(container);

    return () => {
      // Cleanup on unmount
      if (reactRootRef.current) {
        setTimeout(() => {
          reactRootRef.current?.unmount();
        }, 0);
        reactRootRef.current = null;
      }
      shadowRootRef.current = null;
    };
  }, []); // Empty deps - only run once on mount

  // Update Shadow DOM content when editor or data changes
  useEffect(() => {
    if (!reactRootRef.current) return;

    reactRootRef.current.render(
      <BlockNoteView
        className="noteview-readonly pointer-events-none select-none"
        editor={editor}
        editable={false}
        sideMenu={false}
      />,
    );
  }, [editor]);

  // Update content when data changes
  useEffect(() => {
    void (async () => {
      const raw = data.content ?? '';
      const markdown = raw.trim() === '' ? '\n' : raw;
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      editor.replaceBlocks(editor.document, blocks);
    })();
  }, [data.content, editor]);

  return (
    <NodeWrapper
      id={id}
      data={data}
      type={'note'}
      selected={selected}
      toolbar={NoteToolbar}
      keepAspectRatio={false}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
    >
      <div ref={shadowHostRef} className="h-full w-full" />
    </NodeWrapper>
  );
};
