// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';

import { CenterArea } from '@/pages/CanvasPage/CenterArea.tsx';
import { MainLayout } from '@/pages/CanvasPage/MainLayout.tsx';

import { Loading } from '../../components/Common/Loading';
import { toast } from '../../components/Common/Toast';
import { CanvasLayerPanel } from '../../components/Panels/CanvasLayerPanel';
import { CanvasHeader } from '../../components/Panels/Header/CanvasHeader.tsx';
import { PreviewWorkspacePanel } from '../../components/Panels/PreviewWorkspace/PreviewWorkspacePanel';
import { useGlobalSearchHotkey } from '../../hooks/useGlobalSearchHotkey';
import { useTrackCanvasAttention } from '../../store/canvasAttentionStore';
import useStore, { dismissVersionConflictToast } from '../../store/canvasStore';
import { useCanvasSyncStore } from '../../store/canvasSyncStore';
import { openPreviewNode } from '../../store/previewWorkspace/actions';
import { useShortcutsUiStore } from '../../store/shortcutsUiStore';
import { useToolStore } from '../../store/toolStore';
import { useWorkspaceStore } from '../../store/workspaceStore';

type NewCanvasPlacementIntent = {
  canvasId: string;
  nodeType: 'note' | 'sketch';
};

function readPreviewNodeIntent(
  state: unknown,
  routeCanvasId: string | undefined,
): string | null {
  if (!routeCanvasId || typeof state !== 'object' || state === null)
    return null;
  const intent = (state as Record<string, unknown>)['previewNode'];
  if (typeof intent !== 'object' || intent === null) return null;
  const candidate = intent as Record<string, unknown>;
  return candidate['canvasId'] === routeCanvasId &&
    typeof candidate['nodeId'] === 'string'
    ? candidate['nodeId']
    : null;
}

function readNewCanvasPlacementIntent(
  state: unknown,
  routeCanvasId: string | undefined,
): NewCanvasPlacementIntent | null {
  if (!routeCanvasId || typeof state !== 'object' || state === null) {
    return null;
  }

  const placement = (state as Record<string, unknown>)['newCanvasPlacement'];
  if (typeof placement !== 'object' || placement === null) return null;

  const candidate = placement as Record<string, unknown>;
  const nodeType = candidate['nodeType'];
  if (
    candidate['canvasId'] !== routeCanvasId ||
    (nodeType !== 'note' && nodeType !== 'sketch')
  ) {
    return null;
  }

  return { canvasId: routeCanvasId, nodeType };
}

/**
 * Page component for a single canvas.
 * Reads the `canvasId` from the URL and loads / switches the canvas accordingly.
 */
export default function CanvasPage() {
  const { t } = useTranslation();
  const { canvasId } = useParams<{ canvasId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const switchCanvas = useStore((s) => s.switchCanvas);
  const loadCanvas = useStore((s) => s.loadCanvas);
  const isLoading = useStore((s) => s.isLoading);
  const canvasNotFound = useStore((s) => s.canvasNotFound);
  const worldCanvasId = useWorkspaceStore((s) => s.worldCanvasId);
  const refreshSpaceTitles = useWorkspaceStore((s) => s.refreshSpaceTitles);
  const nodeCount = useStore((s) => s.nodes.length);
  // Subscribed so the very first render can detect a mismatch between the
  // URL canvas and whatever (stale or empty) canvas is currently in the
  // store — without this we'd flash the previous canvas's `MainLayout`
  // for one synchronous frame before the mount effect below kicks
  // `loadCanvas` and flips `isLoading` on.
  const storeCanvasId = useStore((s) => s.canvasId);
  const initialised = useRef(false);
  const newCanvasPlacementRef = useRef<NewCanvasPlacementIntent | null>(null);
  const previewNodeIntentRef = useRef<string | null>(null);
  const setPendingNodeType = useToolStore((s) => s.setPendingNodeType);
  const isShortcutsOpen = useShortcutsUiStore((s) => s.isOpen);
  const openShortcuts = useShortcutsUiStore((s) => s.open);
  // Cmd+F / Ctrl+F → focus the canvas-wide search input in the
  // left layer panel (or, when focus is inside the expanded
  // preview, the in-preview find bar).
  useGlobalSearchHotkey();

  // Canvas floating chrome steps aside while the user works in the chat
  // panel, an expanded node, or the layer panel. Tracked here rather than
  // inside `Canvas` because the surfaces being arbitrated between are
  // siblings of the canvas, not children of it.
  useTrackCanvasAttention();

  // Real-time sync: subscribe to server-pushed canvas mutations (e.g. an
  // ACP agent writing via the reachback `/execute` route) for the loaded
  // canvas so the frontend auto-refreshes. Keyed on the store's canvasId
  // so we (re)connect once a canvas is actually loaded / switched.
  const connectSync = useCanvasSyncStore((s) => s.connect);
  const disconnectSync = useCanvasSyncStore((s) => s.disconnect);
  useEffect(() => {
    if (!storeCanvasId) return;
    connectSync(storeCanvasId);
    return () => disconnectSync();
  }, [storeCanvasId, connectSync, disconnectSync]);

  // A create action carries a one-shot placement intent through router state.
  // Capture it before loading, then immediately remove it from browser history
  // so refresh/back navigation cannot arm Note placement again.
  useEffect(() => {
    const placement = readNewCanvasPlacementIntent(location.state, canvasId);
    const previewNodeId = readPreviewNodeIntent(location.state, canvasId);
    if (!placement && !previewNodeId) {
      if (newCanvasPlacementRef.current?.canvasId !== canvasId) {
        newCanvasPlacementRef.current = null;
      }
      return;
    }

    if (placement) newCanvasPlacementRef.current = placement;
    if (previewNodeId) previewNodeIntentRef.current = previewNodeId;
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    });
  }, [canvasId, location, navigate]);

  useEffect(() => {
    const nodeId = previewNodeIntentRef.current;
    if (!nodeId || storeCanvasId !== canvasId || isLoading) return;
    previewNodeIntentRef.current = null;
    if (useStore.getState().nodes.some((node) => node.id === nodeId)) {
      openPreviewNode(nodeId);
    }
  }, [canvasId, isLoading, storeCanvasId]);

  useEffect(() => {
    if (!canvasId) {
      navigate('/', { replace: true });
      return;
    }

    // On first mount, use loadCanvas; on subsequent canvas ID changes
    // use switchCanvas (which flushes the previous canvas's autosave).
    // We compare against the store's `canvasId` (already subscribed
    // above) instead of carrying a separate ref — the subscription
    // makes any local mirror redundant.
    if (!initialised.current) {
      initialised.current = true;
      void loadCanvas(canvasId);
    } else if (canvasId !== storeCanvasId) {
      void switchCanvas(canvasId);
    }
  }, [canvasId, storeCanvasId, loadCanvas, switchCanvas, navigate]);

  useEffect(() => {
    if (!canvasId || canvasId !== worldCanvasId) return;
    void refreshSpaceTitles().catch((error) => {
      console.error('Failed to load World Portal titles:', error);
      toast(t('world.loadFailed'), { tone: 'danger' });
    });
  }, [canvasId, refreshSpaceTitles, t, worldCanvasId]);

  // Only a newly created canvas may opt into its input-appropriate creation
  // tool (Note for mouse, Sketch for pen/finger).
  // Waiting for the matching canvas to finish loading avoids treating the
  // store's transient empty array as real content, while consuming the ref
  // prevents deletion-to-empty or later rerenders from re-arming the tool.
  useEffect(() => {
    const placement = newCanvasPlacementRef.current;
    if (
      !placement ||
      placement.canvasId !== canvasId ||
      storeCanvasId !== canvasId ||
      isLoading
    ) {
      return;
    }

    // Consume on the first completed matching load even if the server ever
    // starts seeding new canvases. Otherwise deleting seeded content later
    // could incorrectly re-arm this one-shot default.
    newCanvasPlacementRef.current = null;
    if (canvasNotFound || nodeCount !== 0) return;
    setPendingNodeType(placement.nodeType);
  }, [
    canvasId,
    storeCanvasId,
    isLoading,
    canvasNotFound,
    nodeCount,
    setPendingNodeType,
  ]);

  // When the user leaves the canvas page (e.g. clicks the back arrow
  // to the canvas list, navigates into settings, or opens the docs),
  // dismiss the persistent "modified elsewhere" toast so it doesn't
  // bleed into other routes where the stale baseline isn't relevant.
  // Pending save drains are handled by the navigation blocker in
  // `RootLayout` (which lives in the data router and never unmounts),
  // not here — putting the blocker on this component would leak stale
  // entries under React.StrictMode and freeze later navigations.
  useEffect(() => {
    return () => {
      dismissVersionConflictToast();
    };
  }, []);

  // Treat any mismatch between the URL canvas and the store canvas as a
  // loading state — covers the gap between this page mounting and the
  // effect above calling `loadCanvas`/`switchCanvas` (which is what
  // actually sets `isLoading: true`). Showing the spinner immediately
  // also avoids a half-rendered `MainLayout` of the previous canvas
  // flashing on click-through from the canvas list.
  if (isLoading || (canvasId && storeCanvasId !== canvasId)) {
    return (
      <Loading
        variant="brand"
        layout="block"
        size="md"
        message={t('canvasPage.loading')}
      />
    );
  }

  if (canvasNotFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="text-center">
          <h2 className="text-fg-default text-lg font-semibold">
            {t('canvasPage.notFoundTitle')}
          </h2>
          <p className="text-fg-subtle mt-1 text-sm">
            {t('canvasPage.notFoundDescription')}
          </p>
        </div>
        <Link
          to="/spaces"
          className="bg-inverse text-fg-inverse hover:bg-inverse/90 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('canvasPage.backToList')}
        </Link>
      </div>
    );
  }

  return (
    <MainLayout
      header={<CanvasHeader onOpenShortcuts={openShortcuts} />}
      leftPanel={<CanvasLayerPanel />}
      rightPanel={<PreviewWorkspacePanel />}
    >
      <CenterArea canvasShortcutsDisabled={isShortcutsOpen} />
    </MainLayout>
  );
}
