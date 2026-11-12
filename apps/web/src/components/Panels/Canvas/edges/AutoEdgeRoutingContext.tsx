// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createContext, useContext, useMemo } from 'react';

import { createAutoEdgeRouteCache } from './autoEdgeRouting';

import type { AutoEdgeRoute } from './autoEdgeRouting';
import type { Edge, Node } from '@xyflow/react';
import type { ReactNode } from 'react';

const RoutingContext = createContext<ReadonlyMap<string, AutoEdgeRoute>>(
  new Map(),
);

export function AutoEdgeRoutingProvider({
  nodes,
  edges,
  children,
}: {
  nodes: Node[];
  edges: Edge[];
  children: ReactNode;
}) {
  const readRoutes = useMemo(createAutoEdgeRouteCache, []);
  const routes = useMemo(
    () => readRoutes(nodes, edges),
    [nodes, edges, readRoutes],
  );
  return (
    <RoutingContext.Provider value={routes}>{children}</RoutingContext.Provider>
  );
}

export function useAutoEdgeRoute(id: string): AutoEdgeRoute | undefined {
  return useContext(RoutingContext).get(id);
}
