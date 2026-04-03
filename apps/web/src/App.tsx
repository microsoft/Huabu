import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { ToastContainer } from './components/Common/Toast';
import { useInputModeListener } from './hooks/useInputMode';
import CanvasListPage from './pages/CanvasListPage';
import CanvasPage from './pages/CanvasPage/CanvasPage.tsx';
import ComponentShowcasePage from './pages/ComponentShowcasePage';
import SourceListPage from './pages/SourceListPage';
import WorkspaceSetupPage from './pages/WorkspaceSetupPage';
import { useWorkspaceStore } from './store/workspaceStore';

/**
 * Loading spinner shown during workspace initialisation.
 */
function LoadingScreen() {
  return (
    <div className="bg-bg-default flex h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <span className="border-fg-subtle inline-block h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" />
        <span className="text-fg-subtle text-sm">Loading workspace…</span>
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
  useInputModeListener();

  return (
    <BrowserRouter>
      <WorkspaceGuard>
        <Routes>
          <Route path="/" element={<CanvasListPage />} />
          <Route path="/sources" element={<SourceListPage />} />
          <Route
            path="/playground/components"
            element={<ComponentShowcasePage />}
          />
          <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </WorkspaceGuard>
      <ToastContainer />
    </BrowserRouter>
  );
}
