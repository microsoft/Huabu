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
    const node =
      nodeIds.length === 1
        ? useCanvasStore
            .getState()
            .nodes.find((entry) => entry.id === nodeIds[0])
        : undefined;
    const focusAgent = node?.type === 'question' && node.selected;
    revealNodesOnCanvas(
      rfInstance,
      wrapper,
      nodeIds,
      focusAgent &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : 400,
      focusAgent ? 0.3 : undefined,
    );
    useCanvasStore.getState().consumeRevealRequest(nodeIds);
  }, [isLoading, isInitialViewportPending, rfInstance, wrapper, nodeIds]);
}
