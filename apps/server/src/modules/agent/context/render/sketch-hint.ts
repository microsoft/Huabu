/**
 * Sketch-raster hint renderer.
 *
 * One-line LLM-only directive that rides in the `<selected_nodes_visuals>`
 * intro: when the turn already carries pre-snapshotted sketch artifacts,
 * point the agent at those urls so it does not re-issue `snapshot_nodes`
 * for the same node ids. Built-in path only — external agents fetch node
 * content via reachback, never these tools.
 */

import { isSketchRasterAttachment } from '../attachment-chips.js';

import type { ChatAttachment } from '@sediment/shared';

/**
 * If `selection` includes pre-snapshotted sketch artifacts, build a
 * one-line directive pointing the agent at those urls so it does not
 * re-issue `snapshot_nodes` for the same node ids on this turn. Returns
 * `undefined` when there are no sketch-raster artifacts. Off-canvas
 * uploads never carry these, so only the selection group is scanned.
 */
export function renderSketchRasterHint(
  selection: ChatAttachment[],
): string | undefined {
  const sketchRasters = selection.filter(isSketchRasterAttachment);
  if (sketchRasters.length === 0) return undefined;
  const items = sketchRasters
    .map((a) => {
      const ids = a.originNodeIds ?? (a.originNodeId ? [a.originNodeId] : []);
      const shortIds = ids.map((id) => id.slice(0, 13)).join(', ');
      return shortIds ? `${a.url} (nodes: ${shortIds})` : a.url;
    })
    .join('; ');
  return `pre-snapshotted sketch artifacts are ready for generate_image.referenceArtifactSrcs — pass these urls directly without re-calling snapshot_nodes for the same node ids: ${items}`;
}
