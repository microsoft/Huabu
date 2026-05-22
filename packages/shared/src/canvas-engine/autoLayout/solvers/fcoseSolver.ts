/**
 * @file fCoSE-based layout solver.
 *
 * Uses cytoscape.js + cytoscape-fcose to perform compound-aware,
 * constraint-driven layout. Supports fixed nodes, compound nodes (groups),
 * disconnected components, and directional placement — all natively.
 *
 * All positions are converted to absolute coordinates before passing to
 * cytoscape, then converted back to relative (parent-local) coordinates
 * in the output so ReactFlow frame children remain correctly positioned.
 */

// Triple-slash references pull the local cytoscape plugin d.ts files into
// the program so web/server typechecks (which only include their own src/)
// can still resolve the ambient module declarations.
/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="./cytoscape-fcose.d.ts" />
/// <reference path="./cytoscape-layout-utilities.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */

import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import layoutUtilities from 'cytoscape-layout-utilities';

import { resolveAbsolutePositions } from './solverUtils.js';

import type { LayoutGraph, LayoutOptions, LayoutResult } from '../types.js';
import type { LayoutSolver } from './types.js';
import type { ElementDefinition } from 'cytoscape';

// Register extensions once at module load.
cytoscape.use(fcose);
cytoscape.use(layoutUtilities);

// ── Solver ─────────────────────────────────────────────────────────────

export const fcoseSolver: LayoutSolver = {
  solve(graph: LayoutGraph, options: LayoutOptions): LayoutResult {
    const positions = new Map<string, { x: number; y: number }>();
    const groupSizes = new Map<string, { width: number; height: number }>();

    if (graph.nodes.length === 0) return { positions, groupSizes };

    // Single-node fast path
    if (graph.nodes.length === 1 && graph.groups.length === 0) {
      const n = graph.nodes[0];
      positions.set(n.id, n.fixed ? { ...n.position } : { x: 0, y: 0 });
      return { positions, groupSizes };
    }

    // ── Build lookup structures ────────────────────────────────────────

    const childToParent = new Map<string, string>();
    const groupIds = new Set<string>();
    for (const g of graph.groups) {
      groupIds.add(g.id);
      for (const childId of g.children) {
        childToParent.set(childId, g.id);
      }
    }

    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    // ── Resolve absolute positions ─────────────────────────────────────
    // Frame children use relative positions in ReactFlow; convert everything
    // to absolute so cytoscape sees a consistent coordinate space.

    const absPositions = resolveAbsolutePositions(graph.nodes, childToParent);

    // ── Build cytoscape elements ───────────────────────────────────────

    const elements: ElementDefinition[] = [];
    const pad2 = options.nodePadding * 2;

    for (const node of graph.nodes) {
      const isCompound = groupIds.has(node.id);
      const parentId = childToParent.get(node.id);
      const absPos = absPositions.get(node.id) ?? node.position;

      elements.push({
        group: 'nodes',
        data: {
          id: node.id,
          ...(parentId ? { parent: parentId } : {}),
          // Only leaf nodes get explicit dimensions;
          // compound nodes derive size from their children.
          // Inflate by nodePadding so the solver keeps breathing room.
          ...(!isCompound
            ? {
                width: Math.max(node.width + pad2, 1),
                height: Math.max(node.height + pad2, 1),
              }
            : {}),
        },
        // Centre-based absolute position for cytoscape.
        position: {
          x: absPos.x + node.width / 2,
          y: absPos.y + node.height / 2,
        },
      });
    }

    for (const edge of graph.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      if (edge.source === edge.target) continue;
      elements.push({
        group: 'edges',
        data: {
          source: edge.source,
          target: edge.target,
          weight: edge.weight,
        },
      });
    }

    // ── Fixed-node constraints ─────────────────────────────────────────
    // All fixed leaf nodes are pinned at their absolute centre position.
    // Compound (group) nodes cannot be directly constrained in cytoscape;
    // they are implicitly fixed because all their children are fixed.

    const fixedNodeConstraint = graph.nodes
      .filter((n) => n.fixed && !groupIds.has(n.id))
      .map((n) => {
        const absPos = absPositions.get(n.id) ?? n.position;
        return {
          nodeId: n.id,
          position: {
            x: absPos.x + n.width / 2,
            y: absPos.y + n.height / 2,
          },
        };
      });

    // ── Create headless cytoscape instance ─────────────────────────────

    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      elements,

      style: [
        {
          selector: 'node[width][height]',
          style: {
            width: 'data(width)',
            height: 'data(height)',
            shape: 'rectangle',
          },
        },
        {
          selector: ':parent',
          style: {
            padding: options.framePadding,
          },
        },
      ] as any,
    });

    // Initialise the layout-utilities extension on the instance so that
    // fCoSE can use it for packing disconnected components with the
    // desired componentSpacing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cy as any).layoutUtilities({
      componentSpacing: options.componentSpacing,
    });

    // ── Run fCoSE layout ───────────────────────────────────────────────

    const hasFixed = fixedNodeConstraint.length > 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cy as any)
      .layout({
        name: 'fcose',
        animate: false,
        // Randomize when doing a full layout from scratch;
        // keep positions when doing incremental placement with fixed nodes.
        randomize: !hasFixed,
        quality: 'default',
        nodeDimensionsIncludeLabels: false,

        // Spacing
        nodeSeparation: options.nodeSpacing,
        idealEdgeLength: () => options.nodeSpacing * 2,
        edgeElasticity: () => 0.45,

        // Compound handling — packing is driven by the
        // cytoscape-layout-utilities extension configured above.
        packComponents: true,

        // Constraints
        ...(hasFixed ? { fixedNodeConstraint } : {}),
      })
      .run();

    // ── Extract positions ──────────────────────────────────────────────
    // fCoSE produces absolute positions. Convert them back to the
    // ReactFlow convention: root nodes use absolute, frame children
    // use parent-relative coordinates.

    // Step 1: Collect absolute top-left positions for every node.
    const outputAbsPositions = new Map<string, { x: number; y: number }>();

    for (const node of graph.nodes) {
      const cyNode = cy.getElementById(node.id);
      if (cyNode.empty()) continue;

      if (groupIds.has(node.id)) {
        // Compound node — bounding-box based.
        const bb = cyNode.boundingBox({
          includeLabels: false,
          includeOverlays: false,
        });
        outputAbsPositions.set(node.id, { x: bb.x1, y: bb.y1 });
        groupSizes.set(node.id, { width: bb.w, height: bb.h });
      } else {
        // Leaf node — convert centre to top-left.
        const pos = cyNode.position();
        outputAbsPositions.set(node.id, {
          x: pos.x - node.width / 2,
          y: pos.y - node.height / 2,
        });
      }
    }

    // Step 2: Convert to parent-relative positions for frame children.
    for (const node of graph.nodes) {
      const absPos = outputAbsPositions.get(node.id);
      if (!absPos) continue;

      const parentId = childToParent.get(node.id);
      if (parentId) {
        const parentAbsPos = outputAbsPositions.get(parentId);
        if (parentAbsPos) {
          positions.set(node.id, {
            x: absPos.x - parentAbsPos.x,
            y: absPos.y - parentAbsPos.y,
          });
          continue;
        }
      }
      positions.set(node.id, absPos);
    }

    cy.destroy();

    return { positions, groupSizes };
  },
};
