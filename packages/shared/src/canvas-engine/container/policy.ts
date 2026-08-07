// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Node } from '@xyflow/react';

/**
 * Return whether a node may own persistent children.
 *
 * Frames and World Portals are the persistent Container types.
 */
export function isContainerNode(node: Pick<Node, 'type'> | undefined): boolean {
  return (
    node?.type === 'frame' ||
    node?.type === 'canvasRef' ||
    node?.type === 'frameRef'
  );
}

/** Return whether `child` may be parented by `parent`. */
export function canParentNode(
  parent: Node | undefined,
  child: Node | undefined,
): boolean {
  if (!parent || !child || parent.id === child.id || !isContainerNode(parent)) {
    return false;
  }
  if (parent.type === 'frame') {
    return child.type !== 'nodeRef' && child.type !== 'frameRef';
  }
  if (parent.type !== 'canvasRef' && parent.type !== 'frameRef') return false;
  if (child.type !== 'nodeRef' && child.type !== 'frameRef') return false;

  const portalTarget =
    parent.type === 'canvasRef'
      ? (parent.data as { targetCanvasId?: unknown } | undefined)
          ?.targetCanvasId
      : (parent.data as { target?: { canvasId?: unknown } } | undefined)?.target
          ?.canvasId;
  const childTarget = (
    child.data as
      | { target?: { canvasId?: unknown; nodeId?: unknown } }
      | undefined
  )?.target;
  return (
    typeof portalTarget === 'string' &&
    childTarget?.canvasId === portalTarget &&
    typeof childTarget.nodeId === 'string'
  );
}
