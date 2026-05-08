import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
} from 'react-router-dom';

import { ToastContainer } from './components/Common/Toast';
import { useInputModeListener } from './hooks/useInputMode';
import CanvasListPage from './pages/CanvasListPage';
import CanvasPage from './pages/CanvasPage/CanvasPage.tsx';
import ComponentShowcasePage from './pages/ComponentShowcasePage';
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
 * Layout-route guard: renders the workspace setup page or the matched
 * child route via `<Outlet/>`. Initialisation is driven by the top-level
 * `App` effect so that `/setup` (which lives outside this layout) also
 * sees a populated store — otherwise managed-mode users who land on
 * `/setup` directly would be stuck on the free-mode UI because the
 * managed-mode redirect depends on `mode` being known.
 */
function WorkspaceGuardLayout({ initialising }: { initialising: boolean }) {
  const isReady = useWorkspaceStore((s) => s.isReady);

  if (initialising) return <LoadingScreen />;
  if (!isReady) return <WorkspaceSetupPage />;
  return <Outlet />;
}

export default function App() {
  useInputModeListener();

  const init = useWorkspaceStore((s) => s.init);
  const [initialising, setInitialising] = useState(true);

  useEffect(() => {
    void init().finally(() => setInitialising(false));
  }, [init]);

  return (
    <BrowserRouter>
      <Routes>
        {/* Setup route lives outside the guard so the user can still
            reach it to switch workspaces in free mode. The page itself
            redirects to "/" in managed mode. */}
        <Route
          path="/setup"
          element={initialising ? <LoadingScreen /> : <WorkspaceSetupPage />}
        />

        <Route element={<WorkspaceGuardLayout initialising={initialising} />}>
          <Route path="/" element={<CanvasListPage />} />
          <Route
            path="/playground/components"
            element={<ComponentShowcasePage />}
          />
          <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}
