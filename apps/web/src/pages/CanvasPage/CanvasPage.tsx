import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';

import { CenterArea } from '@/pages/CanvasPage/CenterArea.tsx';
import { MainLayout } from '@/pages/CanvasPage/MainLayout.tsx';

import { LoadingState } from '../../components/Common/LoadingState.tsx';
import { ChatPanel } from '../../components/Panels/ChatPanel';
import { DataSourcePanel } from '../../components/Panels/DataSourcePanel';
import { Header } from '../../components/Panels/Header/Header.tsx';
import { KeyboardShortcutsModal } from '../../components/Panels/Header/KeyboardShortcutsModal.tsx';
import useStore from '../../store/canvasStore.ts';

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
  const initialised = useRef(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  // Track the last canvasId we loaded so we can detect URL-driven changes
  // without subscribing to the Zustand store's canvasId (which would cause
  // an extra render cycle after loadCanvas/switchCanvas updates it).
  const prevCanvasIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canvasId) {
      navigate('/', { replace: true });
      return;
    }

    // On first mount, use loadCanvas; on subsequent canvas ID changes use switchCanvas
    if (!initialised.current) {
      initialised.current = true;
      prevCanvasIdRef.current = canvasId;
      void loadCanvas(canvasId);
    } else if (canvasId !== prevCanvasIdRef.current) {
      prevCanvasIdRef.current = canvasId;
      void switchCanvas(canvasId);
    }
  }, [canvasId, loadCanvas, switchCanvas, navigate]);

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

  if (isLoading) {
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
            The canvas{' '}
            <code className="bg-surface rounded px-1.5 py-0.5 text-xs">
              {canvasId}
            </code>{' '}
            does not exist or may have been deleted.
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
        header={<Header onOpenHelp={() => setIsShortcutsOpen(true)} />}
        leftPanel={<DataSourcePanel />}
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
