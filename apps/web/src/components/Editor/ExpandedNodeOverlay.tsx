import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { type Node, useReactFlow } from '@xyflow/react';
import { Expand, FileText, Globe, StickyNote, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Document, Page, pdfjs } from 'react-pdf';

import useStore from '../../store/canvasStore.ts';
import { blockNoteShadcnOverrides } from '../BlockNote/shadcnOverrides.tsx';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type ExpandedRendererProps = {
  node: Node;
};

const OverlayShell = (props: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
}) => {
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    focusRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // Close on backdrop click.
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="bg-background/80 absolute inset-0" />

      <div className="absolute inset-0 flex items-center justify-center p-6">
        <div
          ref={focusRef}
          tabIndex={-1}
          className="border-border shadow-bottom flex h-full max-h-[90vh] w-full max-w-275 flex-col overflow-hidden rounded-md border bg-white outline-none"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose();
            e.stopPropagation();
          }}
        >
          <div className="border-border flex h-10 shrink-0 items-center justify-between gap-3 border-b bg-white px-3">
            <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs font-medium">
              <span className="shrink-0">{props.icon}</span>
              <span className="truncate">{props.title}</span>
            </div>

            <div className="text-muted-foreground flex items-center gap-2">
              <div className="bg-border h-3 w-px" />
              <button
                className="hover:text-main"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose();
                }}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">{props.children}</div>
        </div>
      </div>
    </div>
  );
};

const NoteExpandedView = ({ node }: ExpandedRendererProps) => {
  const { updateNodeData } = useReactFlow();
  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  const lastAppliedMarkdownRef = useRef<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  const content =
    typeof node.data?.content === 'string' ? node.data.content : '';

  useEffect(() => {
    const raw = content ?? '';
    if (lastAppliedMarkdownRef.current === raw) return;

    lastAppliedMarkdownRef.current = raw;

    void (async () => {
      const markdown = raw.trim() === '' ? '\n' : raw;
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      editor.replaceBlocks(editor.document, blocks);
    })();
  }, [content, editor]);

  return (
    <div className="custom-scrollbar h-full w-full overflow-auto bg-white p-4">
      <BlockNoteView
        editor={editor}
        editable={true}
        shadCNComponents={blockNoteShadcnOverrides}
        onChange={() => {
          if (debounceRef.current) window.clearTimeout(debounceRef.current);
          debounceRef.current = window.setTimeout(() => {
            const markdown = editor
              .blocksToMarkdownLossy(editor.document)
              .trim();
            lastAppliedMarkdownRef.current = markdown;
            updateNodeData(node.id, { content: markdown });
          }, 150);
        }}
      />
    </div>
  );
};

const WebExpandedView = ({ node }: ExpandedRendererProps) => {
  const src = typeof node.data?.src === 'string' ? node.data.src : '';

  return (
    <div className="flex h-full w-full flex-col bg-white p-3">
      <div className="relative h-full w-full overflow-hidden rounded bg-white">
        {src ? (
          <iframe
            src={src}
            className="nodrag h-full w-full"
            title="Web Preview"
            sandbox="allow-scripts allow-same-origin"
          />
        ) : (
          <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
            Invalid URL
          </div>
        )}
      </div>
    </div>
  );
};

const PDFExpandedView = ({ node }: ExpandedRendererProps) => {
  const src = typeof node.data?.src === 'string' ? node.data.src : '';
  const [numPages, setNumPages] = useState<number | null>(null);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  return (
    <div className="custom-scrollbar h-full w-full overflow-auto bg-white p-4">
      {src ? (
        <Document
          file={src}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={
            <div className="text-muted-foreground p-4 text-xs">Loading...</div>
          }
          error={
            <div className="p-4 text-xs text-red-300">Error loading PDF</div>
          }
          className="flex flex-col items-center gap-4"
        >
          {Array.from(new Array(numPages ?? 0), (_el, index) => (
            <Page
              key={`page_${index + 1}`}
              pageNumber={index + 1}
              scale={1.15}
              renderAnnotationLayer={false}
              renderTextLayer={true}
              loading={''}
            />
          ))}
        </Document>
      ) : (
        <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
          No PDF Source
        </div>
      )}
    </div>
  );
};

const getOverlayMeta = (node: Node) => {
  const type = typeof node.type === 'string' ? node.type : '';
  if (type === 'note') {
    return {
      title: 'Note',
      icon: <StickyNote size={14} />,
    };
  }
  if (type === 'web') {
    const src = typeof node.data?.src === 'string' ? node.data.src : '';
    return {
      title: src || 'Web',
      icon: <Globe size={14} />,
    };
  }
  if (type === 'pdf') {
    const label = typeof node.data?.label === 'string' ? node.data.label : '';
    return {
      title: label || 'PDF',
      icon: <FileText size={14} />,
    };
  }
  return {
    title: 'Expanded View',
    icon: <Expand size={14} />,
  };
};

export const ExpandedNodeOverlay = () => {
  const expandedNodeId = useStore((s) => s.expandedNodeId);
  const closeExpanded = useStore((s) => s.closeExpanded);

  const { getNode } = useReactFlow();

  const node = useMemo(() => {
    if (!expandedNodeId) return null;
    return getNode(expandedNodeId) ?? null;
  }, [expandedNodeId, getNode]);

  const portalTarget = typeof document !== 'undefined' ? document.body : null;

  useEffect(() => {
    if (!expandedNodeId) return;
    if (node) return;
    closeExpanded();
  }, [closeExpanded, expandedNodeId, node]);

  useEffect(() => {
    if (!expandedNodeId || !node) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeExpanded();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [closeExpanded, expandedNodeId, node]);

  if (!expandedNodeId || !node || !portalTarget) return null;

  const meta = getOverlayMeta(node);

  let content: React.ReactNode = null;
  if (node.type === 'note') content = <NoteExpandedView node={node} />;
  else if (node.type === 'web') content = <WebExpandedView node={node} />;
  else if (node.type === 'pdf') content = <PDFExpandedView node={node} />;
  else {
    content = (
      <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
        Unsupported node type
      </div>
    );
  }

  return createPortal(
    <OverlayShell title={meta.title} icon={meta.icon} onClose={closeExpanded}>
      {content}
    </OverlayShell>,
    portalTarget,
  );
};
