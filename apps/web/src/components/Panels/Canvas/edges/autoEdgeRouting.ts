// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createAbsolutePositionGetter,
  getEdgeLineType,
  getLayoutNodeSize,
  getSmartHandles,
  routeOrthogonalEdge,
} from '@huabu/shared/canvas-engine';

import type {
  OrthogonalRect,
  OrthogonalRoute,
  OrthogonalRouteOptions,
  OrthogonalSegment,
  OrthogonalSide,
} from '@huabu/shared/canvas-engine';
import type { Edge, Node } from '@xyflow/react';

export interface AutoEdgeRoute {
  options: OrthogonalRouteOptions;
  route: OrthogonalRoute;
}

function routingClearance(edge: Edge): number {
  return Math.max(12, Number(edge.style?.strokeWidth) / 2 + 8 || 12);
}

/** Only values consumed by routing participate; selection and authored content do not. */
function geometryKey(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify([
    nodes
      .map((node) => {
        const { w, h } = getLayoutNodeSize(node);
        return [
          node.id,
          node.parentId ?? null,
          !!node.hidden,
          node.position.x,
          node.position.y,
          w,
          h,
        ];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    edges
      .filter(
        (edge) =>
          !edge.hidden && getEdgeLineType(edge.data, edge.type) === 'auto',
      )
      .map((edge) => [
        edge.id,
        edge.source,
        edge.target,
        edge.sourceHandle ?? null,
        edge.targetHandle ?? null,
        routingClearance(edge),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

/** One bounded cache per Canvas renderer; geometry changes remain synchronous. */
export function createAutoEdgeRouteCache(): typeof buildAutoEdgeRoutes {
  let previousKey: string | undefined;
  let previousRoutes = new Map<string, AutoEdgeRoute>();
  return (nodes, edges) => {
    const key = geometryKey(nodes, edges);
    if (key !== previousKey) {
      previousRoutes = buildAutoEdgeRoutes(nodes, edges);
      previousKey = key;
    }
    return previousRoutes;
  };
}

/** Crowding is a local preference; node obstacles remain complete for safety. */
function nearbySegments(
  segments: readonly OrthogonalSegment[],
  source: OrthogonalRect,
  target: OrthogonalRect,
): OrthogonalSegment[] {
  const left = Math.min(source.x, target.x);
  const top = Math.min(source.y, target.y);
  const right = Math.max(source.x + source.w, target.x + target.w);
  const bottom = Math.max(source.y + source.h, target.y + target.h);
  const slack = Math.max(200, right - left, bottom - top);
  return segments.filter(
    ({ start, end }) =>
      Math.max(start.x, end.x) >= left - slack &&
      Math.min(start.x, end.x) <= right + slack &&
      Math.max(start.y, end.y) >= top - slack &&
      Math.min(start.y, end.y) <= bottom + slack,
  );
}

function side(
  handle: string | null | undefined,
  fallback: string,
): OrthogonalSide {
  const value = (handle ?? fallback).split('-')[0];
  return value === 'left' ||
    value === 'right' ||
    value === 'top' ||
    value === 'bottom'
    ? value
    : 'right';
}

function anchor(rect: OrthogonalRect, direction: OrthogonalSide) {
  return {
    x:
      direction === 'left'
        ? rect.x
        : direction === 'right'
          ? rect.x + rect.w
          : rect.x + rect.w / 2,
    y:
      direction === 'top'
        ? rect.y
        : direction === 'bottom'
          ? rect.y + rect.h
          : rect.y + rect.h / 2,
  };
}

/** One deterministic routing pass per rendered scene, never persisted as Canvas data. */
export function buildAutoEdgeRoutes(
  nodes: Node[],
  edges: Edge[],
): Map<string, AutoEdgeRoute> {
  const result = new Map<string, AutoEdgeRoute>();
  if (
    !edges.some(
      (edge) =>
        !edge.hidden && getEdgeLineType(edge.data, edge.type) === 'auto',
    )
  )
    return result;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const resolve = createAbsolutePositionGetter(nodeMap);
  const rects = new Map<string, OrthogonalRect>();
  for (const node of nodes) {
    if (node.hidden) continue;
    const position = resolve(node.id);
    if (position)
      rects.set(node.id, { ...position, ...getLayoutNodeSize(node) });
  }
  const ancestors = (node: Node) => {
    const ids = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !ids.has(parentId)) {
      ids.add(parentId);
      parentId = nodeMap.get(parentId)?.parentId;
    }
    return ids;
  };
  const occupied: OrthogonalSegment[] = [];
  const pairCounts = new Map<string, number>();
  // Stable order keeps lane choices independent of selection and render order.
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (edge.hidden || getEdgeLineType(edge.data, edge.type) !== 'auto')
      continue;
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    const sourceRect = rects.get(edge.source);
    const targetRect = rects.get(edge.target);
    if (!sourceNode || !targetNode || !sourceRect || !targetRect) continue;
    const handles =
      !edge.sourceHandle || !edge.targetHandle
        ? getSmartHandles(
            { ...sourceNode, position: sourceRect },
            { ...targetNode, position: targetRect },
          )
        : { sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle };
    const sourceSide = side(edge.sourceHandle, handles.sourceHandle);
    const targetSide = side(edge.targetHandle, handles.targetHandle);
    const sourceAncestors = ancestors(sourceNode);
    const targetAncestors = ancestors(targetNode);
    const obstacles: OrthogonalRect[] = [];
    for (const [id, rect] of rects) {
      if (
        id === edge.source ||
        id === edge.target ||
        sourceAncestors.has(id) ||
        targetAncestors.has(id)
      )
        continue;
      obstacles.push(rect);
    }
    const pair = [edge.source, edge.target].sort().join('\0');
    const pairIndex = pairCounts.get(pair) ?? 0;
    pairCounts.set(pair, pairIndex + 1);
    const options: OrthogonalRouteOptions = {
      source: anchor(sourceRect, sourceSide),
      target: anchor(targetRect, targetSide),
      sourceSide,
      targetSide,
      obstacles,
      // A container connected to its descendant must remain traversable.
      ...(targetAncestors.has(edge.source) ? {} : { sourceRect }),
      ...(sourceAncestors.has(edge.target) ? {} : { targetRect }),
      clearance: routingClearance(edge),
      occupiedSegments: nearbySegments(occupied, sourceRect, targetRect),
      laneOffset:
        pairIndex === 0
          ? 0
          : Math.ceil(pairIndex / 2) * 14 * (pairIndex % 2 ? 1 : -1),
    };
    const route = routeOrthogonalEdge(options);
    result.set(edge.id, { options, route });
    for (let i = 1; i < route.points.length; i++) {
      occupied.push({ start: route.points[i - 1], end: route.points[i] });
    }
  }
  return result;
}

const renderedPortRoutes = new WeakMap<
  AutoEdgeRoute,
  { key: string; route: OrthogonalRoute }
>();

/** Use React Flow's actual port positions, including zoom-dependent node marks. */
export function routeAtRenderedPorts(
  entry: AutoEdgeRoute,
  ports: {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
    sourcePosition: OrthogonalSide;
    targetPosition: OrthogonalSide;
  },
): OrthogonalRoute {
  const { options, route } = entry;
  if (
    options.source.x === ports.sourceX &&
    options.source.y === ports.sourceY &&
    options.target.x === ports.targetX &&
    options.target.y === ports.targetY &&
    options.sourceSide === ports.sourcePosition &&
    options.targetSide === ports.targetPosition
  )
    return route;
  const key = JSON.stringify([
    ports.sourceX,
    ports.sourceY,
    ports.targetX,
    ports.targetY,
    ports.sourcePosition,
    ports.targetPosition,
  ]);
  const previous = renderedPortRoutes.get(entry);
  if (previous?.key === key) return previous.route;
  const corrected = routeOrthogonalEdge({
    ...options,
    source: { x: ports.sourceX, y: ports.sourceY },
    target: { x: ports.targetX, y: ports.targetY },
    sourceSide: ports.sourcePosition,
    targetSide: ports.targetPosition,
  });
  renderedPortRoutes.set(entry, { key, route: corrected });
  return corrected;
}
