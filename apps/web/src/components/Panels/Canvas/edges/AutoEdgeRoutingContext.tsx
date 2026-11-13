// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createContext, useContext, useMemo } from 'react';

import {
  getEdgeLineType,
  routeOrthogonalEdge,
} from '@huabu/shared/canvas-engine';

import { createRoutingSceneCache, getRouteObstacles } from './autoEdgeRouting';

import type { RoutingScene } from './autoEdgeRouting';
import type { EdgeProps, Node } from '@xyflow/react';
import type { ReactNode } from 'react';

const RoutingContext = createContext<RoutingScene>(new Map());

export function AutoEdgeRoutingProvider({
  nodes,
  children,
}: {
  nodes: Node[];
  children: ReactNode;
}) {
  const readScene = useMemo(createRoutingSceneCache, []);
  const scene = useMemo(() => readScene(nodes), [nodes, readScene]);
  return (
    <RoutingContext.Provider value={scene}>{children}</RoutingContext.Provider>
  );
}

/** Route once, using the renderer's actual ports, including live drag positions. */
export function useAutoEdgeRoute(props: EdgeProps) {
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
  const automatic = getEdgeLineType(props.data, props.type) === 'auto';
  const clearance = Math.max(
    12,
    Number(props.style?.strokeWidth) / 2 + 8 || 12,
  );
  return useMemo(
    () =>
      automatic && scene.size
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
      automatic,
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
