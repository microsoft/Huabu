import { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import type { PreviewComponentProps } from './NotePreview';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export const PDFPreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
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
              loading=""
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
