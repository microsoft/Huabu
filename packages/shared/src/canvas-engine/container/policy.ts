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
  if (!parent || !child || parent.id === child.id || !isContainerNode(parent)) {
    return false;
  }
  if (parent.type !== 'canvasRef') return child.type !== 'nodeRef';
  if (child.type !== 'nodeRef') return false;

  const portalTarget = (parent.data as { targetCanvasId?: unknown } | undefined)
    ?.targetCanvasId;
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
