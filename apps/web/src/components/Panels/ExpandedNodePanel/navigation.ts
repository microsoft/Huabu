import { isEditableTarget } from '@/hooks/shortcuts';

import type { Edge, Node } from '@xyflow/react';

export type ExpandedNodeDirection = 'incoming' | 'outgoing';

export function getExpandedNodeNeighbors<T extends Pick<Node, 'id'>>(
  nodes: readonly T[],
  edges: readonly Pick<Edge, 'source' | 'target'>[],
  nodeId: string,
  direction: ExpandedNodeDirection,
): T[] {
  const neighborIds = new Set<string>();

  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (direction === 'incoming' && edge.target === nodeId) {
      neighborIds.add(edge.source);
    } else if (direction === 'outgoing' && edge.source === nodeId) {
      neighborIds.add(edge.target);
    }
  }

  return nodes.filter((node) => node.id !== nodeId && neighborIds.has(node.id));
}

const ARROW_KEY_OWNER_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="slider"]',
  'button',
  'a[href]',
  'video',
  'audio',
  '[data-expanded-node-arrow-owner]',
].join(',');

export function isExpandedNodeNavigationBlocked(
  target: EventTarget | null,
): boolean {
  if (isEditableTarget(target)) return true;
  if (!(target instanceof Element)) return false;
  return target.closest(ARROW_KEY_OWNER_SELECTOR) !== null;
}
