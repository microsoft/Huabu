import {
  type Node,
  type NodeProps,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { clsx } from 'clsx';
import {
  FileText,
  Download,
  Maximize2,
  Minimize2,
  Fullscreen,
} from 'lucide-react';
import { useCallback, useState, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { NodeWrapper } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { NodeDataProps } from './types.ts';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type PDFNodeData = NodeDataProps & {
  src: string;
  label?: string;
};
type CustomPDFNode = Node<PDFNodeData, 'pdf'> & {
  isExpanded?: boolean;
};
export type PDFNodeType = CustomPDFNode;

export const PDFNode = ({ id, data, selected }: NodeProps<PDFNodeType>) => {
  const { setNodes } = useReactFlow();
  const openExpanded = useCanvasStore((s) => s.openExpanded);

  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState<number | null>(null);

  const isExpanded = useStore(
    useCallback(
      (state) => {
        const node = state.nodeLookup?.get(id);
        return (node as CustomPDFNode)?.isExpanded ?? true;
      },
      [id],
    ),
  );

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!data.src) return;
      const link = document.createElement('a');
      link.href = data.src;
      link.download = data.label || data.src.split('/').pop() || 'document.pdf';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [data.src, data.label],
  );

  const toggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const newExpandedState = !isExpanded;
      setNodes((nodes) =>
        nodes.map((node) => {
          if (node.id === id) {
            return {
              ...node,
              isExpanded: newExpandedState,
              style: {
                ...node.style,
                width: newExpandedState ? 400 : 260,
                height: newExpandedState ? 300 : 80,
              },
            };
          }
          return node;
        }),
      );
    },
    [id, isExpanded, setNodes],
  );

  const PDFToolbar = (
    <div className="flex w-full items-center justify-between gap-3">
      {/* Label */}
      <div className="text-muted-foreground">
        <FileText size={14} />
      </div>
      {/* splitter  */}
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
        <GhostButton title="Download" onClick={handleDownload}>
          <Download size={14} />
        </GhostButton>
        <GhostButton
          title={isExpanded ? 'Collapse' : 'Expand'}
          onClick={toggleExpand}
        >
          {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </GhostButton>
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      type={'pdf'}
      selected={selected}
      toolbar={PDFToolbar}
      resizable={isExpanded}
      keepAspectRatio={false}
      className={clsx(
        'bg-white transition-all duration-300 ease-in-out',
        isExpanded ? 'h-125 w-115' : 'border-border! h-20 w-65',
      )}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
    >
      <div
        ref={containerRef}
        className="bg-border relative flex h-full w-full flex-col overflow-hidden rounded"
      >
        {!isExpanded && (
          <div className="flex h-full w-full items-center justify-center gap-3 bg-white p-4">
            <div className="bg-theme-50 text-theme-500 flex h-10 w-10 items-center justify-center rounded-md">
              <FileText size={20} />
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="text-main w-full truncate text-sm font-bold">
                {data.label || 'PDF Document'}
              </span>
              <span className="text-muted-foreground text-xs">PDF File</span>
            </div>
          </div>
        )}

        {isExpanded && (
          <>
            <div
              className={clsx(
                'custom-scrollbar flex h-full w-full flex-col items-center overflow-auto',
                'cursor-grab select-none',
              )}
            >
              {data?.src ? (
                <Document
                  file={data.src}
                  onLoadSuccess={onDocumentLoadSuccess}
                  loading={
                    <div className="text-muted-foreground p-4 text-xs">
                      Loading...
                    </div>
                  }
                  error={
                    <div className="text-danger p-4 text-xs">
                      Error loading PDF.
                    </div>
                  }
                  className="flex flex-col gap-4"
                >
                  {Array.from(new Array(numPages), (_el, index) => (
                    <Page
                      key={`page_${index + 1}`}
                      pageNumber={index + 1}
                      scale={0.7}
                      renderAnnotationLayer={false}
                      renderTextLayer={false}
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
          </>
        )}
      </div>
    </NodeWrapper>
  );
};
