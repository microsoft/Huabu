import { useEffect } from 'react';

import { Canvas } from './components/Editor/Canvas.tsx';
import { MainLayout } from './components/Layout/MainLayout';
import { ChatPanel } from './components/Panels/ChatPanel';
import { DataSourcePanel } from './components/Panels/DataSourcePanel';
import { Header } from './components/Panels/Header';
import useStore from './store/canvasStore';

export default function App() {
  const loadCanvas = useStore((state) => state.loadCanvas);

  useEffect(() => {
    loadCanvas();
  }, [loadCanvas]);

  return (
    <MainLayout
      header={<Header />}
      leftPanel={<DataSourcePanel />}
      rightPanel={<ChatPanel />}
    >
      <Canvas />
    </MainLayout>
  );
}
