import { PageEditor, EdgelessEditor } from '@blocksuite/presets';
import React, { useEffect, useState, useRef } from 'react';

import { SegmentedControl } from '../Common/SegmentedControl';

import type { Doc } from '@blocksuite/store';

interface EditorProps {
  doc: Doc;
}

export const BlockSuiteEditor: React.FC<EditorProps> = ({ doc }) => {
  const [mode, setMode] = useState<'page' | 'edgeless'>('page');
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PageEditor | EdgelessEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    // Clean up old instance
    containerRef.current.innerHTML = '';

    // Initialize editor based on mode
    if (mode === 'page') {
      editorRef.current = new PageEditor();
    } else {
      editorRef.current = new EdgelessEditor();
    }

    // Mount document
    editorRef.current.doc = doc;

    // Mount to DOM
    containerRef.current.appendChild(editorRef.current);

    return () => {
      // Cleanup on unmount. Usually manual destruction of Web Component is not needed,
      // as disconnectedCallback is automatically triggered when DOM is removed
      editorRef.current = null;
    };
  }, [doc, mode]);

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="absolute top-4 left-1/2 z-10 w-fit -translate-x-1/2">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: 'page', label: 'Page Mode' },
            { value: 'edgeless', label: 'Edgeless Mode' },
          ]}
        />
      </div>
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
};
