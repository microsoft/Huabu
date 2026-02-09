import { type Node, type NodeProps, useReactFlow } from '@xyflow/react';
import { clsx } from 'clsx';
import {
  FileText,
  ArrowUpRight,
  Download,
  Maximize2,
  Minimize2,
  Fullscreen,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';
import useStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type PDFNodeData = NodeDataProps & {
  isExpanded?: boolean;
};
export type PDFNodeType = Node<PDFNodeData, 'pdf'>;

export const PDFNode = ({ id, data, selected }: NodeProps<PDFNodeType>) => {
  const { updateNodeData, updateNode } = useReactFlow();
  const openExpanded = useStore((s) => s.openExpanded);

  const [isInteractive, setIsInteractive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [numPages, setNumPages] = useState<number | null>(null);
  const [scale, setScale] = useState(0.7);

  const isExpanded = data.isExpanded ?? true;

  useEffect(() => {
    if (!selected) {
      setIsInteractive(false);
    }
  }, [selected]);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => Math.min(prev + 0.1, 3.0));
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => Math.max(prev - 0.1, 0.5));
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
      setIsInteractive(false);

      const newExpandedState = !isExpanded;

      updateNodeData(id, { isExpanded: newExpandedState });

      updateNode(id, {
        style: newExpandedState
          ? { width: 460, height: 500 }
          : { width: 260, height: 80 },
      });
    },
    [id, isExpanded, updateNodeData, updateNode],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isExpanded) {
        e.stopPropagation();
        setIsInteractive(true);
      }
    },
    [isExpanded],
  );

  const PDFToolbar = (
    <div className="flex w-full items-center justify-between gap-3">
      <a
        href={data?.src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="nodrag text-muted-foreground hover:text-theme-500 flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
      >
        <FileText size={14} className={!isExpanded ? 'text-icon' : ''} />
        <span className="max-w-30 truncate">
          {data.label || 'Document.pdf'}
        </span>
        <ArrowUpRight size={14} strokeWidth={2} />
      </a>

      <div className="text-muted-foreground flex items-center gap-3">
        <div className="bg-border h-3 w-px" />
        <GhostButton
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            setIsInteractive(false);
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

        {isExpanded && (
          <div className="text-muted-foreground animate-in fade-in slide-in-from-left-2 flex items-center gap-3 duration-200">
            <div className="bg-border mx-1 h-3 w-px" />
            <GhostButton
              aria-label="Zoom out"
              title="Zoom out"
              className="rounded disabled:opacity-30"
              onClick={handleZoomOut}
              disabled={scale <= 0.5}
            >
              <ZoomOut size={14} />
            </GhostButton>
            <span className="text-muted-foreground w-8 text-center font-mono text-[10px]">
              {Math.round(scale * 100)}%
            </span>
            <GhostButton
              aria-label="Zoom in"
              title="Zoom in"
              className="rounded disabled:opacity-30"
              onClick={handleZoomIn}
              disabled={scale >= 3.0}
            >
              <ZoomIn size={14} />
            </GhostButton>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected}
      toolbar={PDFToolbar}
      resizable={isExpanded}
      keepAspectRatio={false}
      className={clsx(
        'bg-white transition-all duration-300 ease-in-out',
        isExpanded ? 'h-125 w-115' : 'border-border! h-20 w-65',
        isInteractive && isExpanded ? 'ring-theme-500/20 ring-2' : '',
      )}
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
              onWheel={(e) => {
                if (isInteractive) e.stopPropagation();
              }}
              className={clsx(
                'custom-scrollbar flex h-full w-full flex-col items-center overflow-auto p-4',
                isInteractive
                  ? 'nodrag nowheel cursor-text select-text'
                  : 'cursor-grab select-none',
              )}
            >
              {data?.src ? (
                <Document
                  file={data.src}
                  onLoadSuccess={onDocumentLoadSuccess}
                  loading={
                    <div className="p-4 text-xs text-white">Loading...</div>
                  }
                  error={
                    <div className="p-4 text-xs text-red-300">
                      Error loading PDF
                    </div>
                  }
                  className="flex flex-col gap-4"
                >
                  {Array.from(new Array(numPages), (_el, index) => (
                    <Page
                      key={`page_${index + 1}`}
                      pageNumber={index + 1}
                      scale={scale}
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

            {!isInteractive && (
              <div
                className="absolute inset-0 z-10 cursor-grab"
                onDoubleClick={handleDoubleClick}
              />
            )}
          </>
        )}
      </div>
    </NodeWrapper>
  );
};
