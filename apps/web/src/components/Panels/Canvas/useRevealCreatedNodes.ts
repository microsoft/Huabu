// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';

import useCanvasStore from '@/store/canvasStore';
import { revealNodesOnCanvas } from '@/utils/canvasViewport';

/** Wait for remount and viewport restoration without interrupting fullscreen Chat. */
export function useRevealCreatedNodes(isInitialViewportPending: boolean) {
  const nodeIds = useCanvasStore((state) => state.pendingRevealNodeIds);
  const rfInstance = useCanvasStore((state) => state.rfInstance);
  const wrapper = useCanvasStore((state) => state.canvasWrapper);
  const isLoading = useCanvasStore((state) => state.isLoading);

  useEffect(() => {
    if (
      isLoading ||
      isInitialViewportPending ||
      !rfInstance ||
      !wrapper ||
      nodeIds.length === 0
    ) {
      return;
    }
    revealNodesOnCanvas(rfInstance, wrapper, nodeIds);
    useCanvasStore.getState().consumeRevealRequest(nodeIds);
  }, [isLoading, isInitialViewportPending, rfInstance, wrapper, nodeIds]);
}
