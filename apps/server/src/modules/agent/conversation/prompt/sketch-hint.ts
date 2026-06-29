/**
 * Sketch-raster hint renderer.
 *
 * One-line directive that rides in the `<selected_nodes_visuals>` intro:
 * when the turn already carries pre-snapshotted sketch artifacts, point
 * the agent at those urls so it does not redundantly re-snapshot the
 * same node ids. Both backends raster, so both get the hint — only the
 * tool vocabulary differs: the built-in agent uses `snapshot_nodes` /
 * `generate_image`, the external agent uses the reachback `snapshot`
 * command. Worded per the backend {@link RenderProfile}.
 */

import { isSketchRasterAttachment } from '../transcript/attachment-chips.js';

import type { RenderProfile } from './profile.js';
import type { ChatAttachment } from '@sediment/shared';

/**
 * If `selection` includes pre-snapshotted sketch artifacts, build a
 * one-line directive pointing the agent at those urls so it does not
 * redundantly re-snapshot the same node ids this turn. Returns
 * `undefined` when there are no sketch-raster artifacts. Off-canvas
 * uploads never carry these, so only the selection group is scanned.
 */
export function renderSketchRasterHint(
  selection: ChatAttachment[],
  profile: RenderProfile,
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
  return profile.toolset === 'reachback'
    ? `pre-snapshotted sketch artifacts are ready — reuse these urls directly without re-running the reachback \`snapshot\` command for the same node ids: ${items}`
    : `pre-snapshotted sketch artifacts are ready for generate_image.referenceArtifactSrcs — pass these urls directly without re-calling snapshot_nodes for the same node ids: ${items}`;
}
