import {
  clusterToSvg,
  filterSketchStrokes,
  snapshotNodesToArtifacts,
} from '../../../canvas/snapshot-nodes.js';

import type { SnapshotNodesQueryParams } from '@sediment/shared';

export { clusterToSvg, filterSketchStrokes, snapshotNodesToArtifacts };
export type {
  ContextImage,
  SnapshotNodeResult,
} from '../../../canvas/snapshot-nodes.js';

export type SnapshotNodesArgs = SnapshotNodesQueryParams & {
  canvasId: string;
};

export async function handleSnapshotNodes(
  args: SnapshotNodesArgs,
): Promise<string> {
  return JSON.stringify(await snapshotNodesToArtifacts(args));
}
