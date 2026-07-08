import { FloatingDelayGroup } from '@floating-ui/react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useBlocker,
} from 'react-router-dom';

import { Loading } from './components/Common/Loading';
import { ToastContainer } from './components/Common/Toast';
import { WindowChrome } from './components/Panels/WindowChrome';
import DocsPage from './docs/DocsPage';
import { useDisableBrowserZoom } from './hooks/useDisableBrowserZoom';
import { useInputModeListener } from './hooks/useInputMode';
import CanvasListPage from './pages/CanvasListPage';
import CanvasPage from './pages/CanvasPage/CanvasPage.tsx';
import ComponentShowcasePage from './pages/ComponentShowcasePage';
import ToolCallPlaygroundPage from './pages/ToolCallPlaygroundPage';
import WorkspaceSetupPage from './pages/WorkspaceSetupPage';
import { drainPendingSaves } from './store/canvasStore.ts';
import { useWorkspaceStore } from './store/workspaceStore';

/**
 * Loading spinner shown during workspace initialisation.
 */
function LoadingScreen() {
  return (
    <div className="bg-bg-default h-full">
      <Loading
        variant="brand"
        layout="block"
        size="md"
        message="Loading workspace…"
      />
    </div>
  );
}

/**
 * Carries the "still bootstrapping the workspace store" flag from the
 * `App` root down into route elements without forcing the router to
 * rebuild on state change. The router config is built once and frozen
 * (so URL/history aren't lost on every re-render); the components it
 * renders pull this value via context instead of via element props.
 */
const InitialisingContext = createContext(true);

/**
 * Top-level shell rendered as the data router's root layout. Provides
 * the Electron-only custom title bar and the flex container that
 * sizes the page area below it. All child routes render through the
 * `<Outlet />` here.
 *
 * This is also where the canvas-page navigation blocker lives. It
 * MUST be on a never-unmounting component: React.StrictMode double-
 * invokes effects, and react-router's `useBlocker` leaks a stale
 * entry in its internal `blockerFunctions` map on every remount.
 * Putting the blocker on a component that does unmount (e.g. the
 * route-scoped `CanvasPage`) leaves that stale entry pointing at a
 * dead drain handler, which then freezes the *next* navigation. The
 * router-root layout mounts exactly once for the app's lifetime, so
 * the StrictMode-double-mount artifact at startup is harmless — no
 * future unmount means no leak window.
 */
function RootLayout() {
  // Block any pathname change that's *leaving* a canvas route, so
  // pending debounced editor edits and the canvas-level structure
  // PUT have time to land before the captured `canvasId` becomes
  // stale. /canvas/X → /canvas/Y also blocks (then `switchCanvas`'s
  // internal drain becomes a no-op); pure search/hash changes don't
  // trigger because we compare `pathname` only.
  const [isDraining, setIsDraining] = useState(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname.startsWith('/canvas/') &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let cancelled = false;
    // Defer the overlay by a short grace window so a drain that
    // finishes in well under perceptible time (the common case —
    // debounce window is ~500 ms and most PUTs round-trip in <100 ms,
    // but if nothing is pending the drain is effectively instant)
    // never flashes a spinner. If the drain outruns the timer, we
    // skip turning the overlay on at all.
    const SHOW_OVERLAY_AFTER_MS = 150;
    const overlayTimer = window.setTimeout(() => {
      if (!cancelled) setIsDraining(true);
    }, SHOW_OVERLAY_AFTER_MS);
    void (async () => {
      try {
        // `drainPendingSaves` never throws — per-queue
        // `handleSaveFailure` already surfaces failures via toast +
        // console.error. We unconditionally proceed because trapping
        // the user on the canvas after a failed save helps nothing.
        await drainPendingSaves();
      } finally {
        // `cancelled` is only ever true here if some external code
        // resets the blocker mid-drain (nothing does today, but the
        // guard keeps us honest). Wrapping the cleanup in an `if`
        // rather than `return`-ing early satisfies
        // `no-unsafe-finally`.
        if (!cancelled) {
          window.clearTimeout(overlayTimer);
          setIsDraining(false);
          blocker.proceed?.();
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(overlayTimer);
    };
  }, [blocker]);

  return (
    <div className="flex h-screen flex-col">
      <WindowChrome />
      <div className="relative min-h-0 flex-1">
        <Outlet />
      </div>
      {/* Full-screen overlay shown while pending saves drain before a
          blocked route change proceeds. `Loading layout="block"`
          already provides the centered loading state. Rendered as a sibling
          of the page area so it stacks on top of whatever route is
          currently mounted. */}
      {isDraining && (
        <Loading
          variant="spinner"
          layout="block"
          size="md"
          message="Saving canvas…"
          indicatorClassName="text-fg-subtle"
        />
      )}
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
function WorkspaceGuardLayout() {
  const initialising = useContext(InitialisingContext);
  const isReady = useWorkspaceStore((s) => s.isReady);

  if (initialising) return <LoadingScreen />;
  if (!isReady) return <WorkspaceSetupPage />;
  return <Outlet />;
}

/**
 * Setup route element: shows the spinner while bootstrapping, then
 * hands off to the real setup page. Mirrors the previous inline
 * conditional in the route config so the route element itself stays
 * a plain `<SetupRoute />` and the router config can be frozen.
 */
function SetupRoute() {
  const initialising = useContext(InitialisingContext);
  return initialising ? <LoadingScreen /> : <WorkspaceSetupPage />;
}

export default function App() {
  useInputModeListener();
  useDisableBrowserZoom();

  const init = useWorkspaceStore((s) => s.init);
  const [initialising, setInitialising] = useState(true);

  useEffect(() => {
    void init().finally(() => setInitialising(false));
  }, [init]);

  // Build the data router exactly once for the lifetime of the app.
  // We need a data router (not the legacy `<BrowserRouter>`) so that
  // `useBlocker` inside `CanvasPage` can hold navigation while pending
  // saves drain. Rebuilding the router on every render would remount
  // `RouterProvider` and lose history/URL state, which is why
  // `initialising` is plumbed via `InitialisingContext` above rather
  // than baked into the route elements as props.
  const router = useMemo(
    () =>
      createBrowserRouter([
        {
          element: <RootLayout />,
          children: [
            // Setup route lives outside the guard so the user can still
            // reach it to switch workspaces in free mode. The page itself
            // redirects to "/" in managed mode.
            { path: '/setup', element: <SetupRoute /> },
            // User handbook — also outside the workspace guard so the
            // docs are reachable from a fresh install (e.g. before a
            // workspace folder has been chosen) and from a new browser
            // tab launched via the in-canvas handbook button.
            { path: '/docs/*', element: <DocsPage /> },
            {
              element: <WorkspaceGuardLayout />,
              children: [
                { path: '/', element: <CanvasListPage /> },
                {
                  path: '/playground/components',
                  element: <ComponentShowcasePage />,
                },
                {
                  path: '/playground/tool-calls',
                  element: <ToolCallPlaygroundPage />,
                },
                { path: '/canvas/:canvasId', element: <CanvasPage /> },
                { path: '*', element: <Navigate to="/" replace /> },
              ],
            },
          ],
        },
      ]),
    [],
  );

  return (
    <InitialisingContext.Provider value={initialising}>
      {/* All <Tooltip> instances opt into this group via `useDelayGroup`,
          which gives them singleton-ish behaviour: opening a new tooltip
          instantly hides any visible peer, and the close delay is shared
          so quick traversals between buttons feel snappy without flicker. */}
      <FloatingDelayGroup delay={{ open: 150, close: 0 }}>
        <RouterProvider router={router} />
        <ToastContainer />
      </FloatingDelayGroup>
    </InitialisingContext.Provider>
  );
}
