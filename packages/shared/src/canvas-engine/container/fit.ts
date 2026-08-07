// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from './tree.js';
import { medianOfChildExtents, paddingFromExtent } from '../utils/constants.js';
import { getNodeSize } from '../utils/nodeSizes.js';

import type { XYPosition } from '@xyflow/react';

export interface ContainerInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitContainerOptions {
  padding?: number;
  insets?: Partial<ContainerInsets>;
  minWidth?: number;
  minHeight?: number;
  excludeNodeIds?: ReadonlySet<string>;
  includeAbsoluteRects?: ReadonlyArray<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface ContainerFitResult {
  containerId: string;
  position: XYPosition;
  width: number;
  height: number;
}

/**
 * Compute content-hug geometry for any Container from its direct children.
 */
export function computeContainerFit(
  nodes: NestableNode[],
  containerId: string,
  options: FitContainerOptions = {},
): ContainerFitResult | null {
  const byId = indexById(nodes);
  const container = byId.get(containerId);
  if (!container) return null;

  const excludeIds = options.excludeNodeIds;
  const children = nodes.filter(
    (node) =>
      node.parentId === containerId &&
      (!excludeIds || !excludeIds.has(node.id)),
  );
  const extraRects = options.includeAbsoluteRects ?? [];
  if (children.length === 0 && extraRects.length === 0) return null;

  const childSizes = children.map((child) => getNodeSize(child));
  const extraSizes = extraRects.map(({ width, height }) => ({ width, height }));
  const padding =
    options.padding ??
    paddingFromExtent(medianOfChildExtents([...childSizes, ...extraSizes]));
  const insets: ContainerInsets = {
    top: options.insets?.top ?? padding,
    right: options.insets?.right ?? padding,
    bottom: options.insets?.bottom ?? padding,
    left: options.insets?.left ?? padding,
  };

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const size = childSizes[index];
    minX = Math.min(minX, child.position.x);
    minY = Math.min(minY, child.position.y);
    maxX = Math.max(maxX, child.position.x + size.width);
    maxY = Math.max(maxY, child.position.y + size.height);
  }

  if (extraRects.length > 0) {
    const containerAbs = createAbsolutePositionGetter(byId)(containerId);
    if (containerAbs) {
      for (const rect of extraRects) {
        const relX = rect.x - containerAbs.x;
        const relY = rect.y - containerAbs.y;
        minX = Math.min(minX, relX);
        minY = Math.min(minY, relY);
        maxX = Math.max(maxX, relX + rect.width);
        maxY = Math.max(maxY, relY + rect.height);
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  const deltaX = minX - insets.left;
  const deltaY = minY - insets.top;
  return {
    containerId,
    position: {
      x: container.position.x + deltaX,
      y: container.position.y + deltaY,
    },
    width: Math.max(
      options.minWidth ?? 20,
      maxX - minX + insets.left + insets.right,
    ),
    height: Math.max(
      options.minHeight ?? 20,
      maxY - minY + insets.top + insets.bottom,
    ),
  };
}

/**
 * Apply precomputed Container fit geometry while preserving child positions.
 */
export function applyContainerFit(
  nodes: NestableNode[],
  fit: ContainerFitResult,
): NestableNode[] {
  const container = nodes.find((node) => node.id === fit.containerId);
  if (!container) return nodes;

  const deltaX = fit.position.x - container.position.x;
  const deltaY = fit.position.y - container.position.y;
  if (
    deltaX === 0 &&
    deltaY === 0 &&
    container.style?.width === fit.width &&
    container.style?.height === fit.height
  ) {
    return nodes;
  }

  return nodes.map((node) => {
    if (node.id === fit.containerId) {
      return {
        ...node,
        position: fit.position,
        style: { ...(node.style ?? {}), width: fit.width, height: fit.height },
        measured: {
          ...(node.measured ?? {}),
          width: fit.width,
          height: fit.height,
        },
      };
    }
    if (node.parentId === fit.containerId) {
      return {
        ...node,
        position: {
          x: node.position.x - deltaX,
          y: node.position.y - deltaY,
        },
      };
    }
    return node;
  });
}
