// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasNode } from '@/components/Nodes/types';

export type NodeGeometryPreview = Pick<
  CanvasNode,
  'position' | 'style' | 'measured'
>;

export function applyNodeGeometryPreview(
  node: CanvasNode,
  geometry: NodeGeometryPreview | undefined,
  structuredPosition: { x: number; y: number } | undefined,
): CanvasNode {
  if (!geometry && !structuredPosition) return node;
  return {
    ...node,
    position: structuredPosition ?? geometry?.position ?? node.position,
    style: geometry?.style ?? node.style,
    measured: geometry?.measured ?? node.measured,
  };
}
