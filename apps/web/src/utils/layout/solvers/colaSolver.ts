/**
 * @file WebCola (stress-majorization) layout solver.
 *
 * Uses webcola's constrained stress-majorization algorithm to produce
 * stable, minimal-adjustment layouts. Starting from current node
 * positions, the algorithm monotonically reduces the stress function,
 * guaranteeing results that are at least as good as the input while
 * preserving spatial familiarity.
 *
 * Supports fixed nodes, compound groups (via webcola Group API),
 * non-overlap constraints (VPSC), disconnected component handling,
 * and edge weights — matching the capabilities of fcoseSolver.
 *
 * All positions are converted to absolute coordinates before passing
 * to webcola, then converted back to relative (parent-local)
 * coordinates in the output so ReactFlow frame children remain
 * correctly positioned.
 */

import { Layout } from 'webcola';

import { resolveAbsolutePositions } from './solverUtils';

import type { LayoutGraph, LayoutOptions, LayoutResult } from '../types';
import type { LayoutSolver } from './types';
import type {
  InputNode as ColaInputNode,
  Node as ColaNode,
  Group as ColaGroup,
  Link as ColaLink,
} from 'webcola';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute a link length that respects the physical sizes of both nodes.
 *
 * The minimum centre-to-centre distance for non-overlap is roughly
 * `(w1+w2)/2` horizontally or `(h1+h2)/2` vertically.  We take the
 * minimum of these two to get a direction-agnostic baseline, then add
 * the desired spacing gap.  Edge weight scales the gap: high-weight
 * edges place nodes at the minimum non-overlap distance, while
 * low-weight edges add additional separation.
 */
function computeAdaptiveLinkLength(
  a: ColaInputNode,
  b: ColaInputNode,
  nodeSpacing: number,
  weight: number,
): number {
  const aw = a.width ?? 1;
  const ah = a.height ?? 1;
  const bw = b.width ?? 1;
  const bh = b.height ?? 1;
  const minDist = Math.min((aw + bw) / 2, (ah + bh) / 2);

  // Gap scales inversely with weight: weight=1 → 1× spacing, weight=0 → 2× spacing
  const gap = nodeSpacing * (1 + (1 - weight));
  return minDist + gap;
}

/**
 * Find connected components among leaf nodes using Union-Find.
 * Returns a list of component sets (each set contains leaf-node indices).
 */
function findConnectedComponents(
  nodeCount: number,
  links: ColaLink<number>[],
): number[][] {
  const parent = Array.from({ length: nodeCount }, (_, i) => i);
  const rank = new Array(nodeCount).fill(0);

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra]++;
    }
  };

  for (const link of links) {
    union(link.source as number, link.target as number);
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < nodeCount; i++) {
    const root = find(i);
    const arr = components.get(root) ?? [];
    arr.push(i);
    components.set(root, arr);
  }

  return Array.from(components.values());
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pack component bounding boxes into a roughly square grid with
 * the given spacing between each component.
 * Returns offset (dx, dy) for each component index.
 */
function packComponents(
  boxes: BoundingBox[],
  spacing: number,
): { dx: number; dy: number }[] {
  if (boxes.length <= 1) return boxes.map(() => ({ dx: 0, dy: 0 }));

  // Sort by area descending for better packing
  const indices = boxes.map((_, i) => i);
  indices.sort((a, b) => {
    const areaA = boxes[a].width * boxes[a].height;
    const areaB = boxes[b].width * boxes[b].height;
    return areaB - areaA;
  });

  // Simple row-based packing targeting roughly square output.
  const totalArea = boxes.reduce(
    (sum, b) => sum + (b.width + spacing) * (b.height + spacing),
    0,
  );
  const targetWidth = Math.sqrt(totalArea) * 1.2;

  const offsets = new Array<{ dx: number; dy: number }>(boxes.length);
  let curX = 0;
  let curY = 0;
  let rowHeight = 0;

  for (const idx of indices) {
    const box = boxes[idx];
    if (curX > 0 && curX + box.width > targetWidth) {
      // Start a new row
      curX = 0;
      curY += rowHeight + spacing;
      rowHeight = 0;
    }
    // Offset = desired top-left − current top-left
    offsets[idx] = { dx: curX - box.x, dy: curY - box.y };
    curX += box.width + spacing;
    rowHeight = Math.max(rowHeight, box.height);
  }

  return offsets;
}

// ── Solver ─────────────────────────────────────────────────────────────

export const colaSolver: LayoutSolver = {
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

    // ── Resolve absolute positions ─────────────────────────────────────
    const absPositions = resolveAbsolutePositions(graph.nodes, childToParent);

    // ── Build index mapping ────────────────────────────────────────────
    // WebCola uses numeric indices for nodes and links.
    // Only include leaf nodes (non-group nodes) because groups are
    // represented separately via the webcola Group API.

    const leafNodes = graph.nodes.filter((n) => !groupIds.has(n.id));
    const idToIndex = new Map<string, number>();
    leafNodes.forEach((n, i) => idToIndex.set(n.id, i));

    // ── Build cola nodes ───────────────────────────────────────────────
    const pad2 = options.nodePadding * 2;
    const colaNodes: ColaInputNode[] = leafNodes.map((node) => {
      const absPos = absPositions.get(node.id) ?? node.position;
      // WebCola uses centre-based coordinates internally.
      // Inflate width/height by nodePadding so the non-overlap solver
      // keeps extra breathing room between nodes.  The output conversion
      // uses the original LayoutNode dimensions, so visual positions
      // stay correct.
      return {
        x: absPos.x + node.width / 2,
        y: absPos.y + node.height / 2,
        width: Math.max(node.width + pad2, 1),
        height: Math.max(node.height + pad2, 1),
        // fixed = 1 pins the node at its current position during layout.
        fixed: node.fixed ? 1 : 0,
      };
    });

    // ── Build cola links ───────────────────────────────────────────────
    // WebCola Groups do not participate in the link system, so edges that
    // reference a group (frame) node must be expanded to target the group's
    // leaf children instead.  This keeps nodes connected to a frame
    // spatially close to that frame's contents.

    // Build a map from group id → set of leaf-node indices inside it
    // (recursively, so nested frames are fully expanded).
    const groupLeafIndices = new Map<string, number[]>();
    const collectLeaves = (groupId: string): number[] => {
      const cached = groupLeafIndices.get(groupId);
      if (cached) return cached;

      const result: number[] = [];
      const group = graph.groups.find((g) => g.id === groupId);
      if (group) {
        for (const childId of group.children) {
          const idx = idToIndex.get(childId);
          if (idx !== undefined) {
            result.push(idx);
          } else if (groupIds.has(childId)) {
            // Child is a nested group — recurse.
            result.push(...collectLeaves(childId));
          }
        }
      }
      groupLeafIndices.set(groupId, result);
      return result;
    };
    for (const g of graph.groups) {
      collectLeaves(g.id);
    }

    /**
     * Resolve a node id to an array of leaf-node indices.
     * If the id is a leaf node, returns its single index.
     * If the id is a group, returns indices of all its leaf descendants.
     */
    const resolveToLeafIndices = (nodeId: string): number[] => {
      const idx = idToIndex.get(nodeId);
      if (idx !== undefined) return [idx];
      return groupLeafIndices.get(nodeId) ?? [];
    };

    const colaLinks: ColaLink<number>[] = [];
    const addedLinkKeys = new Set<string>();

    for (const edge of graph.edges) {
      const sourceIndices = resolveToLeafIndices(edge.source);
      const targetIndices = resolveToLeafIndices(edge.target);

      for (const si of sourceIndices) {
        for (const ti of targetIndices) {
          if (si === ti) continue;
          // Deduplicate — same pair may arise from multiple group expansions.
          const key = si < ti ? `${si}:${ti}` : `${ti}:${si}`;
          if (addedLinkKeys.has(key)) continue;
          addedLinkKeys.add(key);

          colaLinks.push({
            source: si,
            target: ti,
            // Link length must respect node sizes: the minimum non-overlap
            // distance is (w1+w2)/2 (horizontal) or (h1+h2)/2 (vertical).
            // We use the diagonal average to handle both dimensions, then
            // add the desired spacing.  This prevents avoidOverlaps from
            // fighting with stress majorization over impossible distances.
            length: computeAdaptiveLinkLength(
              colaNodes[si],
              colaNodes[ti],
              options.nodeSpacing,
              edge.weight,
            ),
            weight: edge.weight,
          });
        }
      }
    }

    // ── Build cola groups ──────────────────────────────────────────────
    const colaGroups: ColaGroup[] = [];
    const groupIdToGroupIndex = new Map<string, number>();

    for (const g of graph.groups) {
      const leaves: number[] = [];
      for (const childId of g.children) {
        const idx = idToIndex.get(childId);
        if (idx !== undefined) {
          leaves.push(idx);
        }
      }
      // Only create a group if it has leaf children.
      // Nested groups (groups containing other groups) are connected
      // via the `groups` property below.
      if (leaves.length > 0) {
        const groupIndex = colaGroups.length;
        groupIdToGroupIndex.set(g.id, groupIndex);
        // Pass numeric indices — WebCola internally resolves them to node
        // objects AND sets node.parent = group, which is essential for
        // compound layout to work. The TS types say Node[] but the runtime
        // accepts number[].
        colaGroups.push({
          leaves: leaves as unknown as ColaNode[],
          padding: g.padding ?? options.framePadding,
        });
      }
    }

    // Wire up nested groups: if a group's child is itself a group,
    // add it to the parent group's `groups` array.
    for (const g of graph.groups) {
      const parentIdx = groupIdToGroupIndex.get(g.id);
      if (parentIdx === undefined) continue;

      const nestedGroupIndices: number[] = [];
      for (const childId of g.children) {
        const childGroupIdx = groupIdToGroupIndex.get(childId);
        if (childGroupIdx !== undefined) {
          nestedGroupIndices.push(childGroupIdx);
        }
      }
      // Pass numeric indices — WebCola resolves them to group objects
      // and sets group.parent, same pattern as leaves above.
      if (nestedGroupIndices.length > 0) {
        colaGroups[parentIdx].groups =
          nestedGroupIndices as unknown as ColaGroup[];
      }
    }

    // ── Detect connected components BEFORE layout ─────────────────────
    // WebCola mutates links in-place during start(), replacing numeric
    // source/target indices with node object references.  We must detect
    // connected components while indices are still numbers.

    const components = findConnectedComponents(leafNodes.length, colaLinks);

    // ── Run layout per connected component ─────────────────────────────
    // Running a single WebCola instance with handleDisconnected(false)
    // causes issues: the shortest-path distance between disconnected
    // nodes is infinity, which breaks stress majorization and compresses
    // connected nodes into a column.  Instead we run a separate layout
    // for each component and then pack the results with proper spacing.

    // Map from global leaf index → component index
    const nodeToComponent = new Array<number>(leafNodes.length);
    for (let ci = 0; ci < components.length; ci++) {
      for (const idx of components[ci]) {
        nodeToComponent[idx] = ci;
      }
    }

    const outputAbsPositions = new Map<string, { x: number; y: number }>();

    for (let ci = 0; ci < components.length; ci++) {
      const compIndices = components[ci];

      // Build re-indexed nodes for this component
      const globalToLocal = new Map<number, number>();
      compIndices.forEach((globalIdx, localIdx) =>
        globalToLocal.set(globalIdx, localIdx),
      );

      const compNodes: ColaInputNode[] = compIndices.map((globalIdx) => ({
        ...colaNodes[globalIdx],
      }));

      // Build re-indexed links for this component
      const compLinks: ColaLink<number>[] = [];
      for (const link of colaLinks) {
        const src = link.source as number;
        const tgt = link.target as number;
        if (nodeToComponent[src] !== ci) continue;
        const localSrc = globalToLocal.get(src);
        const localTgt = globalToLocal.get(tgt);
        if (localSrc === undefined || localTgt === undefined) continue;
        compLinks.push({
          source: localSrc,
          target: localTgt,
          length: link.length,
          weight: link.weight,
        });
      }

      // Build groups scoped to this component
      const compGroups: ColaGroup[] = [];
      const compGroupMap = new Map<number, number>(); // global group idx → local group idx
      for (let gi = 0; gi < colaGroups.length; gi++) {
        const group = colaGroups[gi];
        // Check if any leaf in this group belongs to this component
        const localLeaves: number[] = [];
        for (const leaf of group.leaves as unknown as number[]) {
          const local = globalToLocal.get(leaf);
          if (local !== undefined) localLeaves.push(local);
        }
        if (localLeaves.length > 0) {
          compGroupMap.set(gi, compGroups.length);
          compGroups.push({
            leaves: localLeaves as unknown as ColaNode[],
            padding: group.padding,
          });
        }
      }

      const layout = new Layout();

      layout
        .nodes(compNodes)
        .links(compLinks)
        .avoidOverlaps(true)
        .handleDisconnected(true)
        .convergenceThreshold(0.01)
        .size([10000, 10000]);

      if (compGroups.length > 0) {
        layout.groups(compGroups);
      }

      layout.linkDistance(((link: ColaLink<ColaNode | number>) => {
        return link.length;
      }) as (t: ColaLink<ColaNode | number>) => number);

      layout.start(50, 30, 30, 0, false, false);

      // Extract positions for this component
      const resultNodes = layout.nodes();
      for (let li = 0; li < compIndices.length; li++) {
        const globalIdx = compIndices[li];
        const node = leafNodes[globalIdx];
        const colaNode = resultNodes[li];
        outputAbsPositions.set(node.id, {
          x: (colaNode.x ?? 0) - node.width / 2,
          y: (colaNode.y ?? 0) - node.height / 2,
        });
      }

      // Extract group bounds for this component
      const resultGroups = layout.groups();
      for (const g of graph.groups) {
        const globalGroupIdx = groupIdToGroupIndex.get(g.id);
        if (globalGroupIdx === undefined) continue;
        const localGroupIdx = compGroupMap.get(globalGroupIdx);
        if (localGroupIdx === undefined) continue;

        const colaGroup = resultGroups[localGroupIdx];
        if (colaGroup.bounds) {
          const bounds = colaGroup.bounds;
          outputAbsPositions.set(g.id, {
            x: bounds.x,
            y: bounds.y,
          });
          groupSizes.set(g.id, {
            width: bounds.width(),
            height: bounds.height(),
          });
        }
      }
    }

    // ── Pack disconnected components ───────────────────────────────────
    // Each component was laid out independently. Now pack them together
    // with proper spacing so isolated nodes/clusters stay outside the
    // main connected graph.

    if (components.length > 1) {
      // Compute bounding box for each component (in outputAbsPositions space).
      const componentBoxes: BoundingBox[] = components.map((comp) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const idx of comp) {
          const node = leafNodes[idx];
          const pos = outputAbsPositions.get(node.id);
          if (!pos) continue;
          minX = Math.min(minX, pos.x);
          minY = Math.min(minY, pos.y);
          maxX = Math.max(maxX, pos.x + node.width);
          maxY = Math.max(maxY, pos.y + node.height);
        }

        // Also include group bounds for nodes in this component.
        for (const idx of comp) {
          const nodeId = leafNodes[idx].id;
          const parentId = childToParent.get(nodeId);
          if (parentId && groupIds.has(parentId)) {
            const groupPos = outputAbsPositions.get(parentId);
            const groupSize = groupSizes.get(parentId);
            if (groupPos && groupSize) {
              minX = Math.min(minX, groupPos.x);
              minY = Math.min(minY, groupPos.y);
              maxX = Math.max(maxX, groupPos.x + groupSize.width);
              maxY = Math.max(maxY, groupPos.y + groupSize.height);
            }
          }
        }

        return {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        };
      });

      const offsets = packComponents(componentBoxes, options.componentSpacing);

      // Apply offsets to all nodes in each component.
      for (let ci = 0; ci < components.length; ci++) {
        const { dx, dy } = offsets[ci];
        if (dx === 0 && dy === 0) continue;

        const componentNodeIds = new Set<string>();
        for (const idx of components[ci]) {
          componentNodeIds.add(leafNodes[idx].id);
        }

        // Shift leaf nodes
        for (const nodeId of componentNodeIds) {
          const pos = outputAbsPositions.get(nodeId);
          if (pos) {
            outputAbsPositions.set(nodeId, {
              x: pos.x + dx,
              y: pos.y + dy,
            });
          }
        }

        // Shift groups that belong to this component
        for (const g of graph.groups) {
          const groupChildren = g.children.filter((c) =>
            componentNodeIds.has(c),
          );
          if (groupChildren.length > 0) {
            const pos = outputAbsPositions.get(g.id);
            if (pos) {
              outputAbsPositions.set(g.id, {
                x: pos.x + dx,
                y: pos.y + dy,
              });
            }
          }
        }
      }
    }

    // Step 3: Convert to parent-relative positions for frame children.
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

    return { positions, groupSizes };
  },
};
