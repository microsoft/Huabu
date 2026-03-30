export { type AlignDirection, alignNodes, spreadNodes } from './alignment';

export {
  type NestableNode,
  type UnframeResult,
  type FrameNodesOptions,
  type FrameNodesResult,
  type AutoFrameByOverlapOptions,
  type AutoUnframeByNonOverlapOptions,
  type FrameNodesInRectOptions,
  type FrameNodesInRectResult,
  type FitFrameOptions,
  type FrameFitResult,
  normalizeTreeOrder,
  getAbsolutePosition,
  getDescendantIds,
  unframe,
  autoUnframeNodeByNonOverlap,
  wouldUnframe,
  wouldAutoFrame,
  autoFrameNodeByOverlap,
  frameNodes,
  moveNodeIntoFrame,
  frameNodesInRect,
  findFrameAtPoint,
  computeFrameFit,
  fitFrameToChildren,
  fitFrames,
  moveNodeOutOfFrame,
} from './frame';

export { getSmartHandles, rerouteAllEdges } from './edge';

export { toScreenshotDataUrl, captureCanvasScreenshot } from './screenshot';

// ── Node helpers ───────────────────────────────────────────────────────

import {
  findFrameAtPoint,
  getAbsolutePosition,
  type NestableNode,
} from './frame';

import type {
  CanvasNodeType,
  NodeRef,
  NodeSize,
  RecentAction,
} from '@sediment/shared';
import type { Node } from '@xyflow/react';

/** Extract a lightweight NodeRef from a ReactFlow node. */
export function extractNodeRef(node: Node): NodeRef {
  return {
    id: node.id,
    nodeType: (node.type ?? 'note') as CanvasNodeType,
    label: node.data?.label as string | undefined,
    origin: (node.data as Record<string, unknown> | undefined)
      ?.origin as NodeRef['origin'],
  };
}

/**
 * Extract a short text snippet from a node — first 120 chars of content for
 * note/text nodes, or the src URL for media nodes.
 */
export function extractSnippet(node: Node): string | undefined {
  const data = node.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  if (
    node.type === 'web' ||
    node.type === 'pdf' ||
    node.type === 'video' ||
    node.type === 'image'
  ) {
    return data.src as string | undefined;
  }
  const content = data.content;
  if (typeof content === 'string' && content.length > 0) {
    return content.slice(0, 120);
  }
  return undefined;
}

/** Append an action to the ring buffer, capping at ACTION_HISTORY_MAX. */
export function pushAction(
  history: RecentAction[],
  action: RecentAction,
  max = 10,
): RecentAction[] {
  const next = [...history, action];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Return a new nodes array where only the nodes whose id is in `selectedIds`
 * are marked selected; all other nodes are deselected.
 */
export function selectOnly(
  nodes: Node[],
  selectedIds: Iterable<string>,
): Node[] {
  const ids = new Set(selectedIds);
  return nodes.map((n) => ({ ...n, selected: ids.has(n.id) }));
}

/** Extract a CanvasSize from a ReactFlow node's inline style. */
export function canvasSizeFromStyle(
  style: Node['style'] | undefined,
): NodeSize | undefined {
  const styleRecord = style as Record<string, unknown> | undefined;
  const width = styleRecord?.width;
  if (typeof width !== 'number') return undefined;

  const height = styleRecord?.height;
  return typeof height === 'number' ? { width, height } : { width };
}

/** Return the IDs of all selected nodes. */
export function getSelectedNodeIds(
  nodes: { id: string; selected?: boolean }[],
): string[] {
  return nodes.filter((n) => n.selected).map((n) => n.id);
}

/**
 * Hit-test a point against all frame nodes. If a frame is found,
 * returns its id and absolute position (for coordinate adjustment).
 */
export function resolveFrameAtPoint(
  nodes: NestableNode[],
  point: { x: number; y: number },
): { parentId: string; absolutePosition: { x: number; y: number } } | null {
  const frameId = findFrameAtPoint(nodes, point);
  if (!frameId) return null;
  const frameAbs = getAbsolutePosition(nodes, frameId);
  if (!frameAbs) return null;
  return { parentId: frameId, absolutePosition: frameAbs };
}
