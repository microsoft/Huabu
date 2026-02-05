import { createEmptyDoc } from '@blocksuite/presets';
import { useState, useEffect } from 'react';

import { BlockSuiteEditor } from './components/Editor/BlockSuiteEditor';
import { MainLayout } from './components/Layout/MainLayout';
import { ChatPanel } from './components/Panels/ChatPanel';
import { DataSourcePanel } from './components/Panels/DataSourcePanel';
import { Header } from './components/Panels/Header';

import type { Doc } from '@blocksuite/store';

export default function App() {
  const [doc, setDoc] = useState<Doc | null>(null);

  useEffect(() => {
    // Initialize document
    const newDoc = createEmptyDoc().init();

    setDoc(newDoc);
  }, []);

  if (!doc) {
    return <div>Loading...</div>;
  }

  return (
    <MainLayout
      header={<Header />}
      leftPanel={<DataSourcePanel />}
      rightPanel={<ChatPanel />}
    >
      <BlockSuiteEditor doc={doc} />
    </MainLayout>
  );
}
