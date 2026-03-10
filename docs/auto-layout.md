# Auto-Layout Architecture

## Overview

A client-side layout system that computes optimal node positions on the canvas using both explicit user edges and implicit node relationships. The layout module lives in `apps/web/src/utils/layout/` and is fully UI-framework-agnostic — no server-side or shared type changes required.

A complementary **server-side placement service** (`apps/server/src/modules/canvas/layout/`) handles initial positioning of research nodes during generation (right/bottom/auto strategies). This document covers the client-side layout system only.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Canvas Runtime                      │
│                                                          │
│  handleAddNode() ────→ placeNode()    (auto-layout)      │
│  toolbar / shortcut ─→ layoutAll()    (manual)           │
│  frame toolbar ──────→ layoutGroup()  (scoped)           │
│  multi-select ───────→ layoutSelected()                  │
│                              │                           │
│              ┌───────────────▼──────────────┐            │
│              │      Coordinator Functions   │            │
│              │   layoutAll / layoutGroup /   │            │
│              │   placeNode / layoutSelected  │            │
│              └───┬─────────────────┬────────┘            │
│                  │                 │                      │
│         ┌────────▼───┐   ┌────────▼──────────┐          │
│         │ GraphModel  │   │  LayoutEngine     │          │
│         │ (data layer)│   │  (thin wrapper)   │          │
│         └────────────┘   └────────┬──────────┘          │
│                                   │                      │
│                          ┌────────▼──────────┐          │
│                          │   fCoSE Solver     │          │
│                          │ (cytoscape-fcose)  │          │
│                          └────────┬──────────┘          │
│                                   │                      │
│                          ┌────────▼──────────┐          │
│                          │  PositionApplier   │          │
│                          │  (write-back+undo) │          │
│                          └────────────────────┘          │
└──────────────────────────────────────────────────────────┘
```

## Module Responsibilities

### 1. GraphModel — Canvas data → Layout graph

Converts ReactFlow nodes + edges into a UI-framework-agnostic `LayoutGraph` containing `LayoutNode[]`, `LayoutEdge[]`, and `LayoutGroup[]`. Build options allow scoping to a specific frame and marking nodes as fixed.

Three responsibilities:

- **Node mapping**: Extracts id, dimensions, position, and fixed flag from each canvas node.
- **Edge aggregation**: Merges explicit and implicit edges (see below).
- **Group construction**: Builds group hierarchy from `parentId` (frame containment).

#### Edge construction

Layout edges encode how strongly two nodes should be placed near each other. They are built from five sources:

| Source                                              | Weight | Strategy                                                                                  |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| User edge (canvas `Edge`)                           | 1.0    | Direct mapping                                                                            |
| `node.data.research.relatedNodeIds`                 | 0.6    | Synthesis node → each cited source node                                                   |
| `node.data.origin.sourceId`                         | 0.4    | Reverse-lookup via `data.sourceId` to find the canvas node that owns the knowledge source |
| Same `node.data.research.threadId`                  | 0.3    | Chain-link nodes sharing the same research session (A→B→C, not A↔B↔C)                     |
| Same `node.data.origin.threadId` (`user-drag-chat`) | 0.3    | Chain-link nodes dragged from the same chat thread                                        |

Rules:

- **Max weight, not sum**: When the same (source, target) pair has multiple relationship types, take the max weight to avoid weight explosion.
- **Direction-normalised keys**: (A,B) and (B,A) share the same key — edges are undirected.
- **Chain-linking for same-thread groups**: Nodes in the same thread are linked sequentially (O(n) edges) instead of fully connected (O(n²)).

### 2. LayoutEngine — Thin solver wrapper

A class holding a swappable `LayoutSolver` reference. Because the current solver (fCoSE) natively handles compound nodes, fixed-node constraints, and disconnected components, the engine is a thin pass-through — no custom hierarchical recursion needed.

Exposes `layout()` (full) and `place()` (incremental, currently identical — both delegate to the solver).

### 3. fCoSE Solver

Force-directed compound layout via cytoscape-fcose. Handles:

- **Coordinate conversion**: ReactFlow frame children use parent-relative positions; the solver works in absolute coordinates and converts back.
- **Compound nodes**: Frame groups are cytoscape compound nodes; sizes are derived from children.
- **Fixed constraints**: Pinned via `fixedNodeConstraint` so existing nodes don't move during incremental placement.
- **Disconnected components**: Packed via `cytoscape-layout-utilities`.

The solver is the minimal replaceable unit — swap to dagre, ELK, or d3-force by replacing one file.

#### Layout options

| Option             | Default | Description                                                                  |
| ------------------ | ------- | ---------------------------------------------------------------------------- |
| `nodeSpacing`      | `20`    | Minimum gap between sibling nodes (`nodeSeparation` in fCoSE)                |
| `componentSpacing` | `400`   | Gap between disconnected sub-graphs (`componentSpacing` in layout-utilities) |
| `framePadding`     | `5`     | Internal padding inside frame (compound) nodes                               |
| `nodePadding`      | `5`     | Extra padding inflated around each node to prevent tight packing             |

Derived values used by fCoSE:

- `idealEdgeLength` = `nodeSpacing × 2` (constant for all edges)
- `randomize` = `true` for full layout, `false` when fixed-node constraints exist

### 4. Coordinator — Orchestration functions

Standalone stateless functions that orchestrate the pipeline: `buildLayoutGraph` → `LayoutEngine` → `applyLayoutResult`. Four entry points:

| Function         | Scope                      | Fixed nodes       |
| ---------------- | -------------------------- | ----------------- |
| `layoutAll`      | All nodes                  | None              |
| `layoutGroup`    | Single frame's descendants | None              |
| `placeNode`      | Single new node            | All except target |
| `layoutSelected` | Selected nodes only        | All non-selected  |

All return a new `Node[]` or `null` if nothing changed.

### 5. PositionApplier — Write back to canvas

- Takes an **undo snapshot** before applying changes (single Ctrl+Z undoes entire layout)
- Produces new node array with updated positions and frame sizes
- Animation support declared but **not yet implemented**

## Integration Points

1. **canvasStore actions** dispatch layout commands to `canvasHandlers`
2. **canvasHandlers** call coordinator functions and write results to state
3. **handleAddNode** calls `placeNode()` when auto-layout is enabled for the canvas or parent frame
4. **Post-layout fitView** smoothly pans/zooms the viewport via `requestAnimationFrame`

## UI Surface

- **CanvasToolbar**: Layout All button + Auto-layout toggle (`Ctrl+Shift+L` / `Ctrl+Shift+A`)
- **Frame toolbar**: Layout Children + per-frame auto-layout toggle + Unframe
- **MultiSelectToolbar**: Auto Arrange button for selected nodes
- **State**: `autoLayoutEnabled` (global toggle) and `autoLayoutFrames` (per-frame set) — both in-memory only, **not persisted**
