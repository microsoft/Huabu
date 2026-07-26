import type { Node } from '@xyflow/react';

/**
 * Return whether a node may own persistent children.
 *
 * Frames and World Portals are the persistent Container types.
 */
export function isContainerNode(node: Pick<Node, 'type'> | undefined): boolean {
  return node?.type === 'frame' || node?.type === 'canvasRef';
}

/** Return whether `child` may be parented by `parent`. */
export function canParentNode(
  parent: Node | undefined,
  child: Node | undefined,
): boolean {
  return Boolean(
    parent && child && parent.id !== child.id && isContainerNode(parent),
  );
}
