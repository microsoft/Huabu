/**
 * @file Dagre-based layout solver.
 *
 * Initial solver implementation using @dagrejs/dagre.
 * Can be swapped for ELK, d3-force, or any custom algorithm
 * by implementing the `LayoutSolver` interface.
 */

import dagre from '@dagrejs/dagre';

import type { LayoutNode, LayoutEdge, LayoutOptions } from '../types';
import type { LayoutSolver } from './types';

export const dagreSolver: LayoutSolver = {
  solve(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
    options: LayoutOptions,
  ): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();

    // Guard: dagre crashes on empty or single-node graphs
    if (nodes.length === 0) return positions;
    if (nodes.length === 1) {
      positions.set(nodes[0].id, { x: 0, y: 0 });
      return positions;
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: options.direction === 'LR' ? 'LR' : 'TB',
      nodesep: options.nodeSpacing,
      ranksep: options.nodeSpacing,
      marginx: 0,
      marginy: 0,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes — dagre centres the node at the computed position,
    // so we pass width/height for it to account for during layout.
    // Ensure minimum dimensions to avoid dagre internal errors.
    for (const node of nodes) {
      g.setNode(node.id, {
        width: Math.max(node.width, 1),
        height: Math.max(node.height, 1),
      });
    }

    // Add edges — dagre doesn't support weights natively for ranking
    // but does use `weight` to influence edge routing / alignment.
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const edge of edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      // Avoid self-loops — dagre cannot handle them
      if (edge.source === edge.target) continue;
      g.setEdge(edge.source, edge.target, { weight: edge.weight });
    }

    // Dagre crashes with "Reduce of empty array with no initial value" when
    // there are disconnected components (nodes with no edges). Bridge all
    // disconnected components with invisible minimum-weight edges so dagre
    // can rank them without crashing.
    const connected = new Set<string>();
    const adj = new Map<string, Set<string>>();
    for (const id of nodeIds) adj.set(id, new Set());
    for (const edge of g.edges()) {
      adj.get(edge.v)?.add(edge.w);
      adj.get(edge.w)?.add(edge.v);
    }
    // BFS to find connected components
    const components: string[][] = [];
    for (const id of nodeIds) {
      if (connected.has(id)) continue;
      const component: string[] = [];
      const queue = [id];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        if (connected.has(cur)) continue;
        connected.add(cur);
        component.push(cur);
        for (const neighbor of adj.get(cur) ?? []) {
          if (!connected.has(neighbor)) queue.push(neighbor);
        }
      }
      components.push(component);
    }
    // Bridge disconnected components with zero-weight edges
    for (let i = 1; i < components.length; i++) {
      g.setEdge(components[i - 1][0], components[i][0], {
        weight: 0,
        minlen: 1,
      });
    }

    dagre.layout(g);

    for (const node of nodes) {
      const dagreNode = g.node(node.id);
      if (!dagreNode) continue;
      // dagre returns the centre of the node — convert to top-left origin
      // which ReactFlow (and our LayoutNode.position) expects.
      positions.set(node.id, {
        x: dagreNode.x - node.width / 2,
        y: dagreNode.y - node.height / 2,
      });
    }

    return positions;
  },
};
