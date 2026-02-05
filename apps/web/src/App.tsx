import { Canvas } from './components/Editor/Canvas.tsx';
import { MainLayout } from './components/Layout/MainLayout';
import { ChatPanel } from './components/Panels/ChatPanel';
import { DataSourcePanel } from './components/Panels/DataSourcePanel';
import { Header } from './components/Panels/Header';

export default function App() {
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
