import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { type Node, type NodeProps, useStore } from '@xyflow/react';
import clsx from 'clsx';
import { Fullscreen } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { getSharedStyleNodes } from '@/components/BlockNote/shadowStyleCache.ts';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { useNodeScale } from '@/hooks/useNodeScale';
import useCanvasStore from '@/store/canvasStore';

import { loadBlockNoteContent } from '../../BlockNote/blockNoteContent';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasNoteNodeData } from '../types';

export type NoteNodeType = Node<CanvasNoteNodeData, 'note'>;

export const NoteNode = memo(
  ({ id, data, selected }: NodeProps<NoteNodeType>) => {
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const scale = useNodeScale(id, 'note');
    const hasFixedHeight = useStore(
      (s) =>
        (s.nodeLookup.get(id)?.style?.height as number | undefined) !==
        undefined,
    );
    const shadowHostRef = useRef<HTMLDivElement>(null);
    const shadowRootRef = useRef<ShadowRoot | null>(null);
    const reactRootRef = useRef<Root | null>(null);
    const editor = useCreateBlockNote({
      initialContent: [{ type: 'paragraph', content: '' }],
      trailingBlock: false,
    });

    const NoteToolbar = (
      <FloatingToolbar.Group>
        <FloatingToolbar.ActionButton
          title="Expand"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
        >
          <Fullscreen />
        </FloatingToolbar.ActionButton>
      </FloatingToolbar.Group>
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
      container.className = 'flex flex-col rounded bg-surface p-4';
      shadowRoot.appendChild(container);

      // Inject styles into Shadow DOM from shared cache — avoids cloning
      // every <link> and <style> from scratch for each NoteNode instance.
      const styleNodes = getSharedStyleNodes();
      styleNodes.forEach((node) => shadowRoot.appendChild(node));

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

    // Keep shadow DOM container class in sync with fixed/auto height mode
    useEffect(() => {
      const container = shadowRootRef.current?.querySelector('div');
      if (!container) return;
      container.className = hasFixedHeight
        ? 'flex h-full flex-col rounded bg-surface p-2'
        : 'flex flex-col rounded bg-surface p-2';
    }, [hasFixedHeight]);

    // Update Shadow DOM content when editor or data changes
    useEffect(() => {
      if (!reactRootRef.current) return;

      reactRootRef.current.render(
        <BlockNoteView
          className="block-note-view block-note-view-readonly pointer-events-none select-none"
          editor={editor}
          editable={false}
          sideMenu={false}
        />,
      );
    }, [editor]);

    // Update content when data changes.
    // Prefer contentJson (lossless BlockNote JSON) when available and in sync
    // with content (Markdown). Fall back to parsing content as Markdown.
    useEffect(() => {
      const markdown = typeof data.content === 'string' ? data.content : '';
      const contentJson =
        typeof data.contentJson === 'string' ? data.contentJson : null;
      const contentJsonSource =
        typeof data.contentJsonSource === 'string'
          ? data.contentJsonSource
          : null;

      void loadBlockNoteContent(
        editor,
        markdown,
        contentJson,
        contentJsonSource,
      );
    }, [data.content, data.contentJson, data.contentJsonSource, editor]);

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'note'}
        selected={selected}
        toolbar={NoteToolbar}
        keepAspectRatio={false}
      >
        <div
          className={clsx(
            'bg-surface w-full overflow-hidden',
            hasFixedHeight && 'h-full',
          )}
        >
          <div
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              width: `${100 / scale}%`,
              ...(hasFixedHeight ? { height: `${100 / scale}%` } : {}),
            }}
          >
            <div
              ref={shadowHostRef}
              className={clsx('w-full', hasFixedHeight ? 'h-full' : 'min-h-25')}
              style={!hasFixedHeight ? { maxHeight: 600 } : undefined}
            />
          </div>
        </div>
      </NodeWrapper>
    );
  },
);
