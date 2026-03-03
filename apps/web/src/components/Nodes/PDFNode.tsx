import { type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { FileText, Download, Fullscreen } from 'lucide-react';
import { useCallback, useState, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { NodeWrapper } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';

import type { CanvasPdfNodeData } from './types.ts';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export type PDFNodeType = Node<CanvasPdfNodeData, 'pdf'>;

export const PDFNode = ({ id, data, selected }: NodeProps<PDFNodeType>) => {
  const openExpanded = useCanvasStore((s) => s.openExpanded);

  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState<number | null>(null);

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
      resizable
      keepAspectRatio={false}
      className={clsx('bg-white transition-all duration-300 ease-in-out')}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
    >
      <div
        ref={containerRef}
        className="bg-border relative flex h-full w-full flex-col overflow-hidden rounded"
      >
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
      </div>
    </NodeWrapper>
  );
};
