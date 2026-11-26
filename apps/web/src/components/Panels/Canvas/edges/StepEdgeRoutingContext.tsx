// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createContext, useContext, useMemo } from 'react';

import {
  getEdgeLineType,
  routeOrthogonalEdge,
} from '@huabu/shared/canvas-engine';

import { createRoutingSceneCache, getRouteObstacles } from './stepEdgeRouting';

import type { RoutingScene } from './stepEdgeRouting';
import type { Edge, EdgeProps, Node } from '@xyflow/react';
import type { ReactNode } from 'react';

const EMPTY_SCENE: RoutingScene = new Map();
const RoutingContext = createContext<RoutingScene>(EMPTY_SCENE);

export function StepEdgeRoutingProvider({
  nodes,
  edges,
  children,
}: {
  nodes: Node[];
  edges: Edge[];
  children: ReactNode;
}) {
  const readScene = useMemo(createRoutingSceneCache, []);
  const hasStepEdges = useMemo(
    () =>
      edges.some((edge) => getEdgeLineType(edge.data, edge.type) === 'step'),
    [edges],
  );
  const scene = useMemo(
    () => (hasStepEdges ? readScene(nodes) : EMPTY_SCENE),
    [hasStepEdges, nodes, readScene],
  );
  return (
    <RoutingContext.Provider value={scene}>{children}</RoutingContext.Provider>
  );
}

/** Route Step connectors once from the renderer's actual ports, including live drag positions. */
export function useStepEdgeRoute(props: EdgeProps) {
  const scene = useContext(RoutingContext);
  const {
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  } = props;
  const isStep = getEdgeLineType(props.data, props.type) === 'step';
  const clearance = Math.max(
    12,
    Number(props.style?.strokeWidth) / 2 + 8 || 12,
  );
  return useMemo(
    () =>
      isStep && scene.size
        ? routeOrthogonalEdge({
            source: { x: sourceX, y: sourceY },
            target: { x: targetX, y: targetY },
            sourceSide: sourcePosition,
            targetSide: targetPosition,
            clearance,
            ...getRouteObstacles(scene, source, target),
          })
        : undefined,
    [
      isStep,
      scene,
      source,
      target,
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      clearance,
    ],
  );
}
