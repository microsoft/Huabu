import {
  PORTAL_BOTTOM_PADDING,
  PORTAL_DEFAULT_HEIGHT,
  PORTAL_DEFAULT_WIDTH,
  PORTAL_HEADER_INSET,
  PORTAL_SIDE_PADDING,
} from './geometry.js';
import { applyContainerFit, computeContainerFit } from '../container/fit.js';


import type { NestableNode } from '../container/tree.js';

function resetEmptyPortal(
  nodes: NestableNode[],
  portalId: string,
): NestableNode[] {
  const portal = nodes.find((node) => node.id === portalId);
  if (portal?.type !== 'canvasRef') return nodes;
  if (nodes.some((node) => node.parentId === portalId)) return nodes;
  if (
    portal.style?.width === PORTAL_DEFAULT_WIDTH &&
    portal.style?.height === PORTAL_DEFAULT_HEIGHT &&
    portal.measured?.width === PORTAL_DEFAULT_WIDTH &&
    portal.measured?.height === PORTAL_DEFAULT_HEIGHT
  ) {
    return nodes;
  }
  return nodes.map((node) =>
    node.id === portalId
      ? {
          ...node,
          style: {
            ...(node.style ?? {}),
            width: PORTAL_DEFAULT_WIDTH,
            height: PORTAL_DEFAULT_HEIGHT,
          },
          measured: {
            ...(node.measured ?? {}),
            width: PORTAL_DEFAULT_WIDTH,
            height: PORTAL_DEFAULT_HEIGHT,
          },
        }
      : node,
  );
}

export function fitPortalToChildren(
  nodes: NestableNode[],
  portalId: string,
): NestableNode[] {
  const portal = nodes.find((node) => node.id === portalId);
  if (portal?.type !== 'canvasRef') return nodes;

  const fit = computeContainerFit(nodes, portalId, {
    insets: {
      top: PORTAL_HEADER_INSET,
      right: PORTAL_SIDE_PADDING,
      bottom: PORTAL_BOTTOM_PADDING,
      left: PORTAL_SIDE_PADDING,
    },
    minWidth: PORTAL_DEFAULT_WIDTH,
    minHeight: PORTAL_DEFAULT_HEIGHT,
  });
  return fit
    ? applyContainerFit(nodes, fit)
    : resetEmptyPortal(nodes, portalId);
}

export function fitPortals(
  nodes: NestableNode[],
  portalIds: Iterable<string>,
): NestableNode[] {
  let result = nodes;
  for (const portalId of portalIds) {
    result = fitPortalToChildren(result, portalId);
  }
  return result;
}
