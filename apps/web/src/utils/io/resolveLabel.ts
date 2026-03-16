/**
 * LLM-powered semantic label resolution for image and frame nodes.
 *
 * Image nodes  → server uses vision to describe the image in a few words.
 * Frame nodes  → server summarises child labels into a short group name.
 *
 * Works alongside the existing ingest flow but is intentionally separate:
 *   - No knowledge-store side effects (no sourceId / revisions).
 *   - Different trigger lifecycle (frame labels re-resolve on child changes).
 */

import { resolveLabel } from '@/api/canvas';

import type { ResolveLabelRequest } from '@sediment/shared';
import type { Node } from '@xyflow/react';

export type ResolveLabelDeps = {
  getNodeById: (nodeId: string) => Node | undefined;
  /** Get all direct children of a frame node. */
  getChildNodes: (frameId: string) => Node[];
  /** Silently patch node data without recording undo history. */
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
};

/**
 * Returns true when a node type can benefit from LLM label resolution.
 */
export function needsLabelResolve(nodeType: string): boolean {
  return nodeType === 'image' || nodeType === 'frame';
}

/**
 * Build the request payload for a given node.
 * Returns `null` when the node doesn't qualify (e.g. user-set label, no children).
 */
function buildRequest(
  node: Node,
  deps: ResolveLabelDeps,
): ResolveLabelRequest | null {
  const data = node.data as Record<string, unknown> | undefined;

  // Never overwrite user-set labels
  if (data?.labelSource === 'user') return null;

  const nodeType = node.type ?? '';

  if (nodeType === 'image') {
    const src = typeof data?.src === 'string' ? data.src : '';
    if (!src) return null;
    return { type: 'image', src };
  }

  if (nodeType === 'frame') {
    const children = deps.getChildNodes(node.id);
    const childLabels = children
      .map((c) => {
        const cData = c.data as Record<string, unknown> | undefined;
        const label =
          typeof cData?.label === 'string' ? (cData.label as string) : '';
        // Skip children whose label is still auto-generated (not yet meaningful)
        const source = cData?.labelSource as string | undefined;
        const isUserOrContent = source === 'user' || source === 'auto';
        return isUserOrContent ? label.trim() : '';
      })
      .filter((l) => l.length > 0);

    // Need at least 2 meaningful child labels to produce a useful summary
    if (childLabels.length < 2) return null;
    return { type: 'frame', childLabels };
  }

  return null;
}

/**
 * Resolve a semantic label for a node via the server LLM endpoint.
 * Gracefully no-ops when the node doesn't qualify or the LLM call fails.
 */
export async function resolveLabelIfNeeded(
  nodeId: string,
  deps: ResolveLabelDeps,
): Promise<void> {
  const node = deps.getNodeById(nodeId);
  if (!node) return;

  const request = buildRequest(node, deps);
  if (!request) return;

  try {
    const response = await resolveLabel(request);
    if (!response.suggestedLabel) return;

    const suggestedLabel = response.suggestedLabel.trim();
    if (suggestedLabel.length === 0) return;

    // Re-check the current node state — user may have renamed it while the
    // LLM was generating.
    const currentNode = deps.getNodeById(nodeId);
    if (!currentNode) return;

    const currentData = currentNode.data as Record<string, unknown> | undefined;
    if (currentData?.labelSource === 'user') return;

    deps.patchNodeSilent(nodeId, {
      label: suggestedLabel,
      labelSource: 'auto',
    });
  } catch (error) {
    // Label resolution is best-effort; don't block the user.
    console.warn('Failed to resolve label for node:', nodeId, error);
  }
}
