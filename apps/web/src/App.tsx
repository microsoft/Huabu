// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FloatingDelayGroup } from '@floating-ui/react';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useBlocker,
} from 'react-router-dom';

import { Loading } from './components/Common/Loading';
import { ToastContainer } from './components/Common/Toast';
import { GlobalModals } from './components/Shell/GlobalModals';
import { NativeMenuBridge } from './components/Shell/NativeMenuBridge';
import { WindowChrome } from './components/Shell/WindowChrome';
import { useDisableBrowserZoom } from './hooks/useDisableBrowserZoom';
import { useInputModeListener } from './hooks/useInputMode';
import CanvasListPage from './pages/CanvasListPage';
import { WorkspaceLoadingScreen } from './pages/WorkspaceLoadingScreen';
import WorkspaceSetupPage from './pages/WorkspaceSetupPage';
import { drainPendingSaves } from './store/canvasStore.ts';
import { useWorkspaceStore } from './store/workspaceStore';

/**
 * Loaded on demand so the editor, PDF and KaTeX vendor chunks — roughly 3 MB
 * of JavaScript that only the canvas needs — stay out of the entry graph.
 * Everything Vite reaches statically from `main.tsx` ends up as a
 * `modulepreload` in `index.html` and must be parsed before the first React
 * paint, which is the single largest contributor to desktop cold-start time.
 */
const CanvasPage = lazy(() => import('./pages/CanvasPage/CanvasPage.tsx'));

const playgroundRoutes = import.meta.env.DEV
  ? [
      {
        path: '/playground/components',
        lazy: async () => ({
          Component: (await import('./pages/playground/ComponentShowcasePage'))
            .default,
        }),
      },
      {
        path: '/playground/tool-calls',
        lazy: async () => ({
          Component: (await import('./pages/playground/ToolCallPlaygroundPage'))
            .default,
        }),
      },
      {
        path: '/playground/agent-nodes',
        lazy: async () => ({
          Component: (
            await import('./pages/playground/AgentNodePlaygroundPage')
          ).default,
        }),
      },
    ]
  : [];

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
  const { t } = useTranslation();
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
    // `h-full` (not `h-screen`/`100vh`) so the app tracks the *visible*
    // viewport. On mobile Safari `100vh` resolves to the large viewport,
    // overflowing the `overflow: hidden` `#root` (which is `100%` of the
    // visible viewport) and clipping the bottom toolbar. Desktop is
    // unaffected since both values match there.
    <div className="flex h-full flex-col">
      <WindowChrome />
      {/* Bridges the native macOS menu bar to the in-app action
          handlers. Renders nothing off macOS. */}
      <NativeMenuBridge />
      <div className="relative min-h-0 flex-1">
        <Outlet />
      </div>
      {/* App-wide singleton modals (Settings + Keyboard Shortcuts) and
          the global `?` hotkey. Mounted here on the never-unmounting
          router root so every trigger (title-bar gear, floating canvas
          gear, AppMenu, canvas menu) drives one shared instance. */}
      <GlobalModals />
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
          message={t('app.savingCanvas')}
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

  if (initialising) return <WorkspaceLoadingScreen />;
  if (!isReady) return <Navigate to="/setup" replace />;
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
  return initialising ? <WorkspaceLoadingScreen /> : <WorkspaceSetupPage />;
}

function WorkspaceLanding() {
  const worldEnabled = useWorkspaceStore((state) => state.worldEnabled);
  const worldCanvasId = useWorkspaceStore((state) => state.worldCanvasId);
  return worldEnabled && worldCanvasId ? (
    <Navigate to={`/canvas/${worldCanvasId}`} replace />
  ) : (
    <Navigate to="/spaces" replace />
  );
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
            ...playgroundRoutes,
            {
              element: <WorkspaceGuardLayout />,
              children: [
                { path: '/', element: <WorkspaceLanding /> },
                { path: '/spaces', element: <CanvasListPage /> },
                {
                  path: '/canvas/:canvasId',
                  element: (
                    // `React.lazy` rather than the router's own `lazy` option:
                    // a route element that is always defined keeps the router
                    // synchronous, so the title bar and the rest of
                    // `RootLayout` stay mounted while the chunk arrives
                    // instead of the whole tree waiting on route
                    // initialisation.
                    <Suspense fallback={<WorkspaceLoadingScreen />}>
                      <CanvasPage />
                    </Suspense>
                  ),
                },
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
