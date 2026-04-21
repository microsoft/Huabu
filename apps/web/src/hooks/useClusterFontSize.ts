import { useStore } from '@xyflow/react';
import { useCallback, useMemo } from 'react';

import { NODE_TYPE_LABEL } from '@/config/nodeIcons';
import { getCachedSpatialData } from '@/store/canvasStore';

import { fitFontSize } from './useFitText';

import type { CanvasNodeType } from '@/components/Nodes/types';

/** Padding (px) reserved on each side inside the placeholder — matches SemanticPlaceholder. */
const PAD_X = 48;
const PAD_Y = 16;

const ZWS = '\u200B';

/** Reproduce SemanticPlaceholder's soft-break logic for consistent measurement. */
function insertSoftBreaks(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, `$1${ZWS}$2`)
    .replace(/(\d)([A-Za-z])/g, `$1${ZWS}$2`)
    .replace(/([A-Za-z])(\d)/g, `$1${ZWS}$2`);
}

/** Extract the display label from a ReactFlow node — same logic as SemanticPlaceholder. */
function extractLabel(data: Record<string, unknown>, type?: string): string {
  return (
    (typeof data?.label === 'string' ? data.label : null) ||
    (typeof data?.title === 'string' ? data.title : null) ||
    (type ? NODE_TYPE_LABEL[type as CanvasNodeType] : null) ||
    type ||
    ''
  );
}

/**
 * Stable representation of a cluster's siblings used as a memo dependency.
 * Encoded as a single string so `useMemo` can compare with ===.
 */
function encodeSiblingKey(
  siblings: Array<{ w: number; h: number; label: string }>,
): string {
  return siblings.map((s) => `${s.w}|${s.h}|${s.label}`).join('\n');
}

/**
 * Return a font size normalised across the node's spatial cluster.
 *
 * Strategy: compute each cluster member's individual `fitFontSize`,
 * take the **median**, then clamp per-node with
 * `min(median, individual)`.  This way the majority of nodes share
 * the same size while nodes that genuinely cannot fit the median
 * gracefully fall back to their own smaller size.
 *
 * For isolated nodes or clusters with a single member the node's
 * own `fitFontSize` is returned unchanged.
 */
export function useClusterFontSize(
  nodeId: string,
  label: string,
  width: number,
  height: number,
): number {
  // Build a stable key for the current cluster's sibling dimensions + labels.
  // This selector runs on every xyflow state update but returns a primitive
  // string, so downstream useMemo only recalculates when actual data changes.
  const siblingKey = useStore(
    useCallback(
      (s) => {
        const { summary } = getCachedSpatialData();
        const cluster = summary.clusters.find((c) =>
          c.nodeIds.includes(nodeId),
        );
        if (!cluster || cluster.nodeIds.length <= 1) return '';

        const siblings: Array<{ w: number; h: number; label: string }> = [];
        for (const nid of cluster.nodeIds) {
          const node = s.nodeLookup.get(nid);
          if (!node) continue;
          const w =
            (node.style?.width as number) || node.measured?.width || 400;
          const h =
            (node.style?.height as number) || node.measured?.height || 200;
          const lbl = insertSoftBreaks(
            extractLabel(node.data as Record<string, unknown>, node.type),
          );
          siblings.push({ w, h, label: lbl });
        }
        return encodeSiblingKey(siblings);
      },
      [nodeId],
    ),
  );

  // Individual fallback (always needed)
  const individual = useMemo(
    () =>
      fitFontSize(
        label,
        Math.max(0, width - PAD_X * 2),
        Math.max(0, height - PAD_Y * 2),
      ),
    [label, width, height],
  );

  // Compute the cluster-wide median only when the sibling key changes.
  const clusterMedian = useMemo(() => {
    if (!siblingKey) return null;

    const entries = siblingKey.split('\n');
    const sizes: number[] = [];
    for (const entry of entries) {
      const [wStr, hStr, ...rest] = entry.split('|');
      const w = Number(wStr);
      const h = Number(hStr);
      const lbl = rest.join('|'); // label may contain '|'
      const fs = fitFontSize(
        lbl,
        Math.max(0, w - PAD_X * 2),
        Math.max(0, h - PAD_Y * 2),
      );
      sizes.push(fs);
    }

    if (sizes.length === 0) return null;

    // Median
    sizes.sort((a, b) => a - b);
    const mid = Math.floor(sizes.length / 2);
    const median =
      sizes.length % 2 === 0
        ? Math.floor((sizes[mid - 1] + sizes[mid]) / 2)
        : sizes[mid];

    // Snap to 4px grid (consistent with fitFontSize output)
    return Math.floor(median / 4) * 4 || median;
  }, [siblingKey]);

  // Use the median but never exceed this node's own fit size.
  if (clusterMedian !== null) {
    return Math.min(clusterMedian, individual);
  }
  return individual;
}
