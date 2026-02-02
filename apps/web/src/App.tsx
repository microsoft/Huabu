import { createEmptyDoc } from '@blocksuite/presets';
import React, { useState, useEffect } from 'react';

import { BlockSuiteEditor } from './components/Editor/BlockSuiteEditor';

import type { Doc } from '@blocksuite/store';

export default function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [mode, setMode] = useState<'page' | 'edgeless'>('page');

  useEffect(() => {
    // Initialize document
    const newDoc = createEmptyDoc().init();

    setDoc(newDoc);
  }, []);

  if (!doc) {
    return <div>Loading BlockSuite...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          padding: '10px',
          borderBottom: '1px solid #ccc',
          display: 'flex',
          gap: '10px',
          alignItems: 'center',
        }}
      >
        <h2 style={{ margin: 0 }}>Sediment Editor</h2>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setMode('page')}
          style={{
            fontWeight: mode === 'page' ? 'bold' : 'normal',
            padding: '5px 10px',
          }}
        >
          Page Mode
        </button>
        <button
          onClick={() => setMode('edgeless')}
          style={{
            fontWeight: mode === 'edgeless' ? 'bold' : 'normal',
            padding: '5px 10px',
          }}
        >
          Edgeless Mode
        </button>
      </header>

      <div style={{ flex: 1, position: 'relative' }}>
        <BlockSuiteEditor doc={doc} mode={mode} />
      </div>
    </div>
  );
}
