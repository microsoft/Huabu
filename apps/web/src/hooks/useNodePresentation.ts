// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore, type ReactFlowState } from '@xyflow/react';
import { useMemo } from 'react';

import { selectSelectedCount } from '@/components/Nodes/shared/selectedCount';
import {
  SEMANTIC_ZOOM_CONFIG,
  resolveNodePresentation,
  type NodePresentationMode,
} from '@/config/semanticZoom';

type ZoomSubscription = 'always' | 'reading' | 'none';

interface NodePresentation {
  mode: NodePresentationMode;
  isVisible: boolean;
  isSoleSelected: boolean;
  /** Neutral outside the requested zoom subscription scope. */
  zoom: number;
}

/** Track hysteresis on store updates, without rendering unchanged consumers. */
export function createNodePresentationSelector(
  nodeId: string,
  nodeType: string,
  zoomSubscription: ZoomSubscription = 'always',
) {
  let previous: NodePresentationMode = 'overview';
  return (state: ReactFlowState): NodePresentation => {
    const [x, y, zoom] = state.transform;
    const node = state.nodeLookup.get(nodeId);
    const viewportWidth = state.width;
    const viewportHeight = state.height;
    const isSoleSelected =
      node?.selected === true && selectSelectedCount(state.nodes) === 1;
    const width =
      typeof node?.style?.width === 'number'
        ? node.style.width
        : (node?.measured?.width ?? 400);
    const height =
      typeof node?.style?.height === 'number'
        ? node.style.height
        : (node?.measured?.height ?? 400);
    const enabled =
      SEMANTIC_ZOOM_CONFIG.nodeLOD[nodeType]?.minimal === 'minimal';
    const mode = enabled
      ? resolveNodePresentation(
          zoom,
          width * zoom,
          height * zoom,
          previous,
          nodeType !== 'office' && nodeType !== 'video',
        )
      : 'overview';
    previous = mode;
    const position = node?.internals.positionAbsolute;
    const isVisible =
      !!position &&
      !node?.hidden &&
      viewportWidth > 0 &&
      viewportHeight > 0 &&
      position.x * zoom + x < viewportWidth &&
      position.y * zoom + y < viewportHeight &&
      (position.x + width) * zoom + x > 0 &&
      (position.y + height) * zoom + y > 0;
    return {
      mode,
      isVisible,
      isSoleSelected,
      zoom:
        zoomSubscription === 'always' ||
        (zoomSubscription === 'reading' && mode === 'reading' && isVisible)
          ? zoom
          : 1,
    };
  };
}

function equalPresentation(a: NodePresentation, b: NodePresentation) {
  return (
    a.mode === b.mode &&
    a.isVisible === b.isVisible &&
    a.isSoleSelected === b.isSoleSelected &&
    a.zoom === b.zoom
  );
}

export function useNodePresentation(
  nodeId: string,
  nodeType: string,
  zoomSubscription: ZoomSubscription = 'always',
) {
  const selector = useMemo(
    () => createNodePresentationSelector(nodeId, nodeType, zoomSubscription),
    [nodeId, nodeType, zoomSubscription],
  );
  return useStore(selector, equalPresentation);
}
