// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isEditableTarget } from '@/hooks/shortcuts';

import type { EdgeStyle } from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

export type ExpandedNodeDirection = 'incoming' | 'undirected' | 'outgoing';

export function getExpandedNodeNeighbors<T extends Pick<Node, 'id'>>(
  nodes: readonly T[],
  edges: readonly Pick<Edge, 'source' | 'target' | 'data'>[],
  nodeId: string,
  direction: ExpandedNodeDirection,
): T[] {
  const neighborIds = new Set<string>();

  for (const edge of edges) {
    if (edge.source === edge.target) continue;

    const edgeDirection = (edge.data?.edgeStyle as EdgeStyle | undefined)
      ?.direction;
    const isUndirected = edgeDirection == null || edgeDirection === 'none';
    if (direction === 'undirected') {
      if (!isUndirected) continue;
      if (edge.source === nodeId) neighborIds.add(edge.target);
      if (edge.target === nodeId) neighborIds.add(edge.source);
      continue;
    }

    const followsEndpoints =
      edgeDirection === 'forward' || edgeDirection === 'both';
    const reversesEndpoints =
      edgeDirection === 'backward' || edgeDirection === 'both';

    if (direction === 'incoming') {
      if (followsEndpoints && edge.target === nodeId) {
        neighborIds.add(edge.source);
      }
      if (reversesEndpoints && edge.source === nodeId) {
        neighborIds.add(edge.target);
      }
    } else {
      if (followsEndpoints && edge.source === nodeId) {
        neighborIds.add(edge.target);
      }
      if (reversesEndpoints && edge.target === nodeId) {
        neighborIds.add(edge.source);
      }
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
