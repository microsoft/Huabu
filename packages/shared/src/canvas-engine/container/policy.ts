import type { Node } from '@xyflow/react';

/**
 * Return whether a node may own persistent children.
 *
 * Frame is the only Container type until `canvasRef` is introduced.
 */
export function isContainerNode(node: Pick<Node, 'type'> | undefined): boolean {
  return node?.type === 'frame';
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
