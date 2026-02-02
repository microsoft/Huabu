import { PageEditor, EdgelessEditor } from '@blocksuite/presets';
import React, { useEffect, useState, useRef } from 'react';

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
    <div style={{ height: '100%', width: '100%' }}>
      <div
        style={{
          display: 'flex',
          gap: '8px',
          background: 'rgba(255, 255, 255, 0.8)',
          padding: '4px',
          borderRadius: '4px',
        }}
      >
        <button
          onClick={() => setMode('page')}
          style={{
            fontWeight: mode === 'page' ? 'bold' : 'normal',
            padding: '5px 10px',
            cursor: 'pointer',
            border: '1px solid #ccc',
            background: mode === 'page' ? '#eee' : '#fff',
            borderRadius: '4px',
          }}
        >
          Page Mode
        </button>
        <button
          onClick={() => setMode('edgeless')}
          style={{
            fontWeight: mode === 'edgeless' ? 'bold' : 'normal',
            padding: '5px 10px',
            cursor: 'pointer',
            border: '1px solid #ccc',
            background: mode === 'edgeless' ? '#eee' : '#fff',
            borderRadius: '4px',
          }}
        >
          Edgeless Mode
        </button>
      </div>
      <div
        ref={containerRef}
        style={{ height: '100%', width: '100%', overflow: 'hidden' }}
      />
    </div>
  );
};
