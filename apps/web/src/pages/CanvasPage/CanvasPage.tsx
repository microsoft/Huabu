import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';

import { LoadingState } from '../../components/Common/LoadingState.tsx';
import { CanvasLayerPanel } from '../../components/Panels/CanvasLayerPanel';
import { ChatPanel } from '../../components/Panels/ChatPanel';
import { CanvasHeader } from '../../components/Panels/Header/CanvasHeader.tsx';
import { KeyboardShortcutsModal } from '../../components/Panels/Header/KeyboardShortcutsModal.tsx';
import useStore from '../../store/canvasStore.ts';

import { CenterArea } from '@/pages/CanvasPage/CenterArea.tsx';
import { MainLayout } from '@/pages/CanvasPage/MainLayout.tsx';

/**
 * Page component for a single canvas.
 * Reads the `canvasId` from the URL and loads / switches the canvas accordingly.
 */
export default function CanvasPage() {
  const { canvasId } = useParams<{ canvasId: string }>();
  const navigate = useNavigate();
  const switchCanvas = useStore((s) => s.switchCanvas);
  const loadCanvas = useStore((s) => s.loadCanvas);
  const isLoading = useStore((s) => s.isLoading);
  const canvasNotFound = useStore((s) => s.canvasNotFound);
  // Subscribed so the very first render can detect a mismatch between the
  // URL canvas and whatever (stale or empty) canvas is currently in the
  // store — without this we'd flash the previous canvas's `MainLayout`
  // for one synchronous frame before the mount effect below kicks
  // `loadCanvas` and flips `isLoading` on.
  const storeCanvasId = useStore((s) => s.canvasId);
  const initialised = useRef(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);

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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== '?' && e.key !== '？') return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isNativeInput = tag === 'input' || tag === 'textarea';
      const isRichEditor =
        target?.isContentEditable ||
        target?.getAttribute?.('role') === 'textbox';

      if (isNativeInput || isRichEditor) return;

      e.preventDefault();
      setIsShortcutsOpen((prev) => !prev);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Treat any mismatch between the URL canvas and the store canvas as a
  // loading state — covers the gap between this page mounting and the
  // effect above calling `loadCanvas`/`switchCanvas` (which is what
  // actually sets `isLoading: true`). Showing the spinner immediately
  // also avoids a half-rendered `MainLayout` of the previous canvas
  // flashing on click-through from the canvas list.
  if (isLoading || (canvasId && storeCanvasId !== canvasId)) {
    return <LoadingState message="Loading canvas…" fullScreen />;
  }

  if (canvasNotFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-center">
          <h2 className="text-fg-default text-lg font-semibold">
            Canvas not found
          </h2>
          <p className="text-fg-subtle mt-1 text-sm">
            This canvas doesn&apos;t exist or may have been deleted.
          </p>
        </div>
        <Link
          to="/"
          className="bg-inverse text-fg-inverse hover:bg-inverse/90 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to canvas list
        </Link>
      </div>
    );
  }

  return (
    <>
      <MainLayout
        header={
          <CanvasHeader onOpenShortcuts={() => setIsShortcutsOpen(true)} />
        }
        leftPanel={<CanvasLayerPanel />}
        rightPanel={<ChatPanel />}
      >
        <CenterArea canvasShortcutsDisabled={isShortcutsOpen} />
      </MainLayout>

      <KeyboardShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />
    </>
  );
}
