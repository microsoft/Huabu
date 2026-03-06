# Auto-Layout Architecture

## Overview

A client-side layout system that computes optimal node positions on the canvas using both explicit user edges and implicit node relationships. The layout module is fully self-contained within `apps/web` — no server-side or shared type changes required.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Canvas Runtime                      │
│                                                          │
│  onNodeAdded() ──────→ LayoutCoordinator                 │
│  onLayoutRequested() ─→ LayoutCoordinator                │
│                              │                           │
│              ┌───────────────▼──────────────┐            │
│              │      LayoutCoordinator       │            │
│              │      (single entry point)    │            │
│              └───┬─────────────────┬────────┘            │
│                  │                 │                      │
│         ┌────────▼───┐   ┌────────▼──────────┐          │
│         │ GraphModel  │   │  LayoutEngine     │          │
│         │ (data layer)│   │  (compute layer)  │          │
│         └────────┬───┘   └────────┬──────────┘          │
│                  │                │                      │
│         ┌────────▼────────────────▼──────────┐          │
│         │         PositionApplier            │          │
│         │     (write-back + animation + undo)│          │
│         └────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────┘
```

## File Structure

```
apps/web/src/utils/layout/
  ├── types.ts              // LayoutNode, LayoutEdge, LayoutGroup, LayoutGraph, LayoutResult, all interfaces
  ├── graphModel.ts         // Canvas → LayoutGraph conversion + relation inference
  ├── engine.ts             // LayoutEngine (hierarchical recursion + incremental placement)
  ├── solvers/
  │   ├── types.ts          // LayoutSolver interface
  │   └── dagreSolver.ts    // dagre implementation (initial version, swappable)
  ├── applier.ts            // PositionApplier
  └── coordinator.ts        // LayoutCoordinator (external-facing entry point)
```

## Module Responsibilities

### 1. GraphModel — Canvas data → Layout graph

Converts canvas `CanvasNode[]` + `CanvasEdge[]` (defined in `packages/shared/src/types/canvas/`) into a clean, UI-framework-agnostic graph structure for the layout engine.

#### Types

```typescript
interface LayoutNode {
  id: string;
  width: number;
  height: number;
  position: { x: number; y: number };
  /** When true, the node's position can only change slightly */
  fixed: boolean;
}

interface LayoutEdge {
  source: string;
  target: string;
  /** Higher weight = closer placement in layout. Range [0, 1] */
  weight: number;
}

interface LayoutGroup {
  id: string; // frame node id
  children: string[]; // direct child node ids
  padding: number;
}

interface LayoutGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  groups: LayoutGroup[];
}
```

#### Three responsibilities

**a) Node mapping**: `CanvasNode` → `LayoutNode`. Extracts id, measured dimensions, and position.

**b) Edge aggregation**: Merges two categories of edges into a unified `LayoutEdge[]`:

| Source                                              | Relationship Semantics        | Weight | Notes                                |
| --------------------------------------------------- | ----------------------------- | ------ | ------------------------------------ |
| User edge (canvas `Edge`)                           | Explicit user connection      | 1.0    | Layout backbone                      |
| `node.data.research.relatedNodeIds`                 | Synthesis cites these sources | 0.6    | synthesis → source nodes             |
| `node.data.origin.sourceId` (`user-drag-capture`)   | Captured content from a node  | 0.4    | Capture node stays near source       |
| Same `node.data.research.threadId`                  | Same research session         | 0.3    | Nodes from same research run cluster |
| Same `node.data.origin.threadId` (`user-drag-chat`) | Dragged from same chat thread | 0.3    | Nodes from same conversation cluster |

When the same (source, target) pair has multiple relationships, take **max weight** (not sum) to avoid weight explosion.

**c) Group construction**: Builds `LayoutGroup[]` tree from `node.parentId` (frame containment).

### 2. LayoutEngine — Pure coordinate computation

#### Interface

```typescript
interface LayoutOptions {
  direction: 'TB' | 'LR';
  nodeSpacing: number;
  groupSpacing: number;
  groupPadding: number;
}

interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  /** Computed group dimensions after layout (used to resize frames) */
  groupSizes: Map<string, { width: number; height: number }>;
}

interface LayoutEngine {
  /** Full layout — repositions all non-fixed nodes */
  layout(graph: LayoutGraph, options: LayoutOptions): LayoutResult;
  /** Incremental placement — only computes positions for fixed=false nodes */
  place(graph: LayoutGraph, options: LayoutOptions): LayoutResult;
}
```

#### Hierarchical recursion (full layout)

Frame nodes act as atomic containers. Layout proceeds in two phases:

**Phase A — Bottom-Up (determine sizes)**

Starting from the deepest nested frames, working upward:

1. Collect child nodes + child frames within the current frame
2. Collect edges where both source and target are inside the current frame
3. Call solver → compute relative positions for children
4. Compute frame's content size = bounding box of children + padding
5. Return this size upward — the frame participates as a "big node" in the parent layer

**Phase B — Top-Down (assign absolute coordinates)**

Starting from root level, working downward:

1. Root layer layout: top-level nodes + frames (using sizes from Phase A)
2. Root layout result → frame absolute positions are determined
3. Recurse into each frame, converting relative coordinates to absolute

#### Cross-frame edges

| Edge scenario                     | Handling                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Both endpoints in the same frame  | Participates in that frame's internal layout                                        |
| Endpoints across different frames | Promoted to the nearest common ancestor layer; connects frame nodes as atomic units |

#### Solver — the swappable algorithm core

```typescript
interface LayoutSolver {
  solve(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
    options: LayoutOptions,
  ): Map<string, { x: number; y: number }>;
}
```

The solver is the minimal replaceable unit. Initial implementation uses dagre; can be swapped to ELK, d3-force, or a custom algorithm by replacing a single file.

#### Incremental placement (auto-layout mode)

When canvas or frame has auto-layout enabled and a new node is added:

```
For each new node (fixed = false):
  1. Find related nodes via edges
  2. If related nodes exist:
       anchor = centroid of related nodes
       candidatePos = anchor + offset along layout direction
     Else:
       candidatePos = edge of existing content bounding box
  3. Collision detection: check overlap with all fixed nodes
     If overlapping → spiral outward until clear
  4. If inside a group, ensure position stays within group bounds
     (or expand group size if necessary)
  Return positions for new nodes only
```

This approach guarantees existing nodes are never moved.

### 3. LayoutCoordinator — Orchestration entry point

```typescript
interface LayoutCoordinator {
  /** Full re-layout of all nodes (user-triggered) */
  layoutAll(options?: Partial<LayoutOptions>): void;

  /** Incremental placement of a single new node */
  placeNode(nodeId: string, options?: Partial<LayoutOptions>): void;

  /** Full re-layout within a specific frame */
  layoutGroup(frameId: string, options?: Partial<LayoutOptions>): void;
}
```

Each method follows the same pipeline:

1. Read current nodes + edges from `canvasStore`
2. `GraphModel.build(nodes, edges)` → `LayoutGraph`
   - `placeNode`: mark target node as `fixed=false`, all others `fixed=true`
   - `layoutGroup`: extract only the sub-graph within the frame
3. `LayoutEngine.layout/place(graph, options)` → `LayoutResult`
4. `PositionApplier.apply(result)`

### 4. PositionApplier — Write back to canvas

```typescript
interface PositionApplier {
  apply(result: LayoutResult, options?: { animate?: boolean }): void;
}
```

Responsibilities:

- Batch-update node positions via `canvasStore.setNodes()`
- Update frame node dimensions from `groupSizes`
- Wrap the entire operation as **a single history entry** (supports Ctrl+Z undo)
- Optional: CSS transition animation for smooth repositioning

## Integration Points

Canvas only needs to connect `LayoutCoordinator` in two places:

1. **Toolbar button / keyboard shortcut** → `coordinator.layoutAll()`
2. **End of `handleAddNode`** → `if (autoLayoutEnabled) coordinator.placeNode(newNodeId)`

## Design Decisions

| Decision                              | Choice                                         | Rationale                                                                |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| Solver decoupled from engine          | Solver is the minimal replaceable unit         | Swap algorithms by changing one file                                     |
| LayoutGraph isolated from ReactFlow   | GraphModel handles conversion                  | Layout module is independently testable, no UI framework dependency      |
| Edge weight uses max, not sum         | Avoid weight explosion from multiple relations | Two nodes have a bounded affinity regardless of how many relations exist |
| Incremental placement uses heuristics | Not a full layout engine run                   | Instant response; deterministically never moves existing nodes           |
| Groups support recursive nesting      | Frame-in-frame supported                       | Aligns with existing `parentId` tree structure                           |
| Position write-back is atomic         | Single history entry for the entire operation  | User can undo all position changes with one Ctrl+Z                       |
| Full layout is manual-trigger only    | Never auto-rearrange existing positions        | Respects user's intentional arrangement                                  |
| Incremental placement is opt-in       | Only active when auto-layout mode is enabled   | User controls whether new nodes are auto-positioned                      |

## UI Changes

### 1. CanvasToolbar — Global layout entry point

The existing `LayoutGrid` button (currently a no-op) becomes the primary layout trigger.

| Interaction               | Action                                                          |
| ------------------------- | --------------------------------------------------------------- |
| **Click**                 | Execute `coordinator.layoutAll()` — full re-layout of all nodes |
| **Long-press / dropdown** | Open a layout options panel (direction TB/LR, spacing)          |

An additional **Auto-layout toggle** button is placed next to the layout button:

```
┌──────────────────────────────────────────────┐
│  🖱  ✋  │  ▢  📝  T  │  📎  🔗  │  ⊞ ○  │
│                                    ↑    ↑    │
│                              Layout  Auto    │
│                              All    Mode     │
└──────────────────────────────────────────────┘
```

- `⊞` Layout All — click to execute full layout
- `○` Auto-layout toggle — highlighted when active; enables incremental placement for new nodes

### 2. Frame Node Toolbar — Per-frame layout

The frame toolbar currently has only an "Unframe" button. Two controls are added:

| Button                 | Action                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| **Layout children**    | `coordinator.layoutGroup(frameId)` — re-layout only this frame's children |
| **Auto-layout toggle** | Frame-level auto-layout switch (independent of the global toggle)         |

```
Frame header:  [  Label  ]
Frame toolbar: [ Layout ↻ ] [ Auto ○ ] [ Unframe ⊟ ]
```

### 3. MultiSelectToolbar — Selection layout

The existing multi-select toolbar (align + spread) gains one additional button at the end:

| Button           | Action                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| **Auto-arrange** | Run layout scoped to the selected nodes only (other nodes stay in place) |

### 4. Keyboard Shortcuts

Registered in `useCanvasShortcuts.ts`:

| Shortcut       | Action                                           |
| -------------- | ------------------------------------------------ |
| `Ctrl+Shift+L` | Full layout (same as clicking Layout All button) |
| `Ctrl+Shift+A` | Toggle auto-layout mode                          |

### 5. State Additions

New fields in `canvasStore`:

| Field               | Type            | Persisted               | Description                                 |
| ------------------- | --------------- | ----------------------- | ------------------------------------------- |
| `autoLayoutEnabled` | `boolean`       | Yes (saved with canvas) | Global auto-layout toggle                   |
| `autoLayoutFrames`  | `Set<string>`   | Yes                     | Set of frame IDs with auto-layout enabled   |
| `layoutOptions`     | `LayoutOptions` | Yes                     | User-preferred layout direction and spacing |

### 6. Visual Feedback

| Scenario              | Feedback                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| Full layout executing | Nodes smoothly animate to new positions via CSS transition (~300ms)          |
| Auto-layout enabled   | Toolbar toggle button highlighted; frame header shows a small indicator icon |
| Incremental placement | New node slides from insertion point to computed position                    |
