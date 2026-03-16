import { useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';

import useStore from '../../store/canvasStore';
import { CenterArea } from '../Layout/CenterArea';
import { MainLayout } from '../Layout/MainLayout';
import { ChatPanel } from '../Panels/ChatPanel';
import { DataSourcePanel } from '../Panels/DataSourcePanel';
import { Header } from '../Panels/Header';

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

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading canvas…</div>
      </div>
    );
  }

  if (canvasNotFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-900">
            Canvas not found
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            The canvas{' '}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
              {canvasId}
            </code>{' '}
            does not exist or may have been deleted.
          </p>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
            />
          </svg>
          Back to canvas list
        </Link>
      </div>
    );
  }

  return (
    <MainLayout
      header={<Header />}
      leftPanel={<DataSourcePanel />}
      rightPanel={<ChatPanel />}
    >
      <CenterArea />
    </MainLayout>
  );
}
