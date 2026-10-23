// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useMemo, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';
import { fitNodesOnCanvas } from '@/utils/canvasViewport';

import type { CanvasViewport } from '@huabu/shared';
import type { ReactFlowInstance } from '@xyflow/react';

type InitialCanvasViewport = {
  defaultViewport?: CanvasViewport;
  nodeIdsToFit: string[];
};

/** Restore a saved viewport or fit persisted node bounds on first mount. */
export const useInitialCanvasViewport = (
  readiness: 'pending' | 'ready' | 'error' = 'ready',
) => {
  const initialViewport = useMemo<InitialCanvasViewport>(() => {
    const { viewport, nodes } = useCanvasStore.getState();
    if (viewport) return { defaultViewport: viewport, nodeIdsToFit: [] };
    return { nodeIdsToFit: nodes.map((node) => node.id) };
  }, []);
  const [needsInitialFit, setNeedsInitialFit] = useState(
    initialViewport.nodeIdsToFit.length > 0,
  );
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    if (!instance || readiness !== 'ready' || !needsInitialFit) return;
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (active)
          return fitNodesOnCanvas(instance, initialViewport.nodeIdsToFit);
      })
      .catch((error: unknown) => {
        console.error('Failed to fit initial Canvas viewport:', error);
      })
      .finally(() => {
        if (active) setNeedsInitialFit(false);
      });
    return () => {
      active = false;
    };
  }, [instance, readiness, needsInitialFit, initialViewport.nodeIdsToFit]);

  return {
    defaultViewport: initialViewport.defaultViewport,
    fitInitialViewport: setInstance,
    isPending: needsInitialFit && readiness !== 'error',
  };
};
