// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useViewport, useStore } from '@xyflow/react';
import { useRef } from 'react';

import {
  SEMANTIC_ZOOM_CONFIG,
  type LODRenderMode,
} from '@/config/semanticZoom';

/**
 * Returns the LODRenderMode for a specific node at the current viewport zoom.
 * Node types not listed in the config always return 'full'.
 *
 * A single boundary with hysteresis to avoid flicker near the edge:
 * full ↔ minimal on the node's screen-space WIDTH vs the `minimal` threshold.
 * A `minimal` label just keeps scaling down with the node as you zoom out
 * (its tier font is a canvas size), so there is no separate small-text floor.
 */
export function useNodeLOD(nodeId: string, nodeType: string): LODRenderMode {
  const { zoom } = useViewport();
  const nodeWidth = useStore((s) => {
    const node = s.nodeLookup.get(nodeId);
    return (node?.style?.width as number) || node?.measured?.width || 400;
  });

  const prevModeRef = useRef<LODRenderMode>('full');

  const lodConfig = SEMANTIC_ZOOM_CONFIG.nodeLOD[nodeType];
  if (!lodConfig || lodConfig.minimal !== 'minimal') {
    prevModeRef.current = 'full';
    return 'full';
  }

  const { hysteresis, screenThresholds } = SEMANTIC_ZOOM_CONFIG;

  // full ↔ minimal (screen width). Hysteresis: once minimal, require growing
  // past threshold + buffer to expand; once full, require dropping below
  // threshold - buffer to collapse.
  const screenWidth = nodeWidth * zoom;
  const threshold = screenThresholds.minimal ?? 120;
  const mode: LODRenderMode =
    prevModeRef.current === 'minimal'
      ? screenWidth >= threshold + hysteresis
        ? 'full'
        : 'minimal'
      : screenWidth < threshold - hysteresis
        ? 'minimal'
        : 'full';

  prevModeRef.current = mode;
  return mode;
}
