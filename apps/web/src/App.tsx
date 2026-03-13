import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import CanvasListPage from './components/Pages/CanvasListPage';
import CanvasPage from './components/Pages/CanvasPage';
import WorkspaceSetupPage from './components/Pages/WorkspaceSetupPage';
import { useWorkspaceStore } from './store/workspaceStore';

/**
 * Loading spinner shown during workspace initialisation.
 */
function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
        <span className="text-sm text-gray-400">Loading workspace…</span>
      </div>
    </div>
  );
}

/**
 * Guard component that ensures a workspace is configured before
 * rendering child routes.  Keeps the BrowserRouter mounted at all
 * times so route history is preserved across workspace switches.
 */
function WorkspaceGuard({ children }: { children: React.ReactNode }) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isReady = useWorkspaceStore((s) => s.isReady);
  const init = useWorkspaceStore((s) => s.init);
  const [initialising, setInitialising] = useState(true);

  useEffect(() => {
    void init().finally(() => setInitialising(false));
  }, [init]);

  if (initialising) return <LoadingScreen />;
  if (!workspacePath || !isReady) return <WorkspaceSetupPage />;

  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <WorkspaceGuard>
        <Routes>
          <Route path="/" element={<CanvasListPage />} />
          <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </WorkspaceGuard>
    </BrowserRouter>
  );
}
