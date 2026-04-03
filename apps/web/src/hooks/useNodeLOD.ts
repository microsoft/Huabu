import { useViewport, useStore } from '@xyflow/react';
import { useRef } from 'react';

import {
  SEMANTIC_ZOOM_CONFIG,
  type LODRenderMode,
  type ZoomLOD,
} from '@/config/semanticZoom';

/**
 * Returns the LODRenderMode for a specific node at the current viewport zoom.
 * Node types not listed in the config always return 'full'.
 *
 * Uses hysteresis to prevent rapid toggling near threshold boundaries.
 */
export function useNodeLOD(nodeId: string, nodeType: string): LODRenderMode {
  const { zoom } = useViewport();
  const nodeWidth = useStore((s) => {
    const node = s.nodeLookup.get(nodeId);
    return (node?.style?.width as number) || node?.measured?.width || 400;
  });

  const prevModeRef = useRef<LODRenderMode>('full');

  const lodConfig = SEMANTIC_ZOOM_CONFIG.nodeLOD[nodeType];
  if (!lodConfig) return 'full';

  const screenWidth = nodeWidth * zoom;
  const { hysteresis } = SEMANTIC_ZOOM_CONFIG;

  // Apply hysteresis: if currently minimal, require crossing threshold + buffer
  // to switch back to full; if currently full, require dropping below threshold - buffer.
  const threshold = SEMANTIC_ZOOM_CONFIG.screenThresholds.minimal ?? 120;
  let lod: ZoomLOD;
  if (prevModeRef.current === 'minimal') {
    lod = screenWidth >= threshold + hysteresis ? 'full' : 'minimal';
  } else {
    lod = screenWidth < threshold - hysteresis ? 'minimal' : 'full';
  }

  const mode = lodConfig[lod] ?? 'full';
  prevModeRef.current = mode;
  return mode;
}
