import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

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
  const storeCanvasId = useStore((s) => s.canvasId);
  const isLoading = useStore((s) => s.isLoading);
  const initialised = useRef(false);

  useEffect(() => {
    if (!canvasId) {
      navigate('/canvas/default-canvas', { replace: true });
      return;
    }

    // On first mount, use loadCanvas; on subsequent canvas ID changes use switchCanvas
    if (!initialised.current) {
      initialised.current = true;
      void loadCanvas(canvasId);
    } else if (canvasId !== storeCanvasId) {
      void switchCanvas(canvasId);
    }
  }, [canvasId, storeCanvasId, loadCanvas, switchCanvas, navigate]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading canvas…</div>
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
