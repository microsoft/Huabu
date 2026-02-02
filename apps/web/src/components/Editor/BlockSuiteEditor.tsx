import { PageEditor, EdgelessEditor } from '@blocksuite/presets';
import React, { useEffect, useRef } from 'react';

import type { Doc } from '@blocksuite/store';

interface EditorProps {
  doc: Doc;
  mode: 'page' | 'edgeless';
}

export const BlockSuiteEditor: React.FC<EditorProps> = ({ doc, mode }) => {
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
    <div
      ref={containerRef}
      style={{ height: '100%', width: '100%', overflow: 'hidden' }}
    />
  );
};
