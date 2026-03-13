import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import CanvasListPage from './components/Pages/CanvasListPage';
import CanvasPage from './components/Pages/CanvasPage';
import WorkspaceSetupPage from './components/Pages/WorkspaceSetupPage';
import { useWorkspaceStore } from './store/workspaceStore';

export default function App() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isReady = useWorkspaceStore((s) => s.isReady);
  const init = useWorkspaceStore((s) => s.init);
  const [initialising, setInitialising] = useState(true);

  useEffect(() => {
    void init().finally(() => setInitialising(false));
  }, [init]);

  // Show loading spinner while checking localStorage + syncing with server
  if (initialising) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
          <span className="text-sm text-gray-400">Loading workspace…</span>
        </div>
      </div>
    );
  }

  // No workspace configured — show setup screen
  if (!workspacePath || !isReady) {
    return <WorkspaceSetupPage />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CanvasListPage />} />
        <Route path="/canvas/:canvasId" element={<CanvasPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
