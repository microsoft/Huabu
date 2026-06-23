# Auto-Layout

The canvas has a force-directed layout system (`apps/web/src/utils/layout/`) that positions nodes based on both explicit user-drawn edges and implicit semantic relationships.

## Layout Actions

One layout operation is exposed to users today:

| Action                | Scope                   | Trigger                    | Effect                                                                     |
| --------------------- | ----------------------- | -------------------------- | -------------------------------------------------------------------------- |
| **Place Node** (auto) | Single newly added node | Automatic on node creation | Inserts the new node near its related nodes; all existing nodes stay fixed |

> `layoutAll` and `layoutGroup` (full canvas / single-frame re-layout) are still implemented under `apps/web/src/handler/autoLayout/coordinator.ts` and the deprecated `AUTO_LAYOUT` command handler, but no UI entry point, keyboard shortcut, or agent tool surface invokes them anymore. They remain only so historical chat threads / persisted commands can still replay.

All layout changes are undoable with a single `Ctrl+Z`.

## Frame Sizing (Hug vs Manual)

Frame size is governed by a **per-frame** `sizing` policy on
`FrameNodeData`, not a global toggle. Each frame's toolbar exposes
two options:

| Sizing            | Behaviour                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hug** (default) | The engine refits the frame to wrap its children after every child mutation (add / remove / drag / resize). Live drag previews are shown.                            |
| **Manual**        | The frame's size is user/agent-controlled. The engine's end-of-batch fit pass skips this frame's own size; children can move freely without reshaping the container. |

The policy is fully orthogonal to `layoutMode`:

- `free + hug` — the default: frame wraps its free-floating children.
- `free + manual` — user-pinned frame box; children sit wherever placed.
- `column|row + hug` — the structured solver packs children into tracks
  AND writes the resulting content-driven frame size.
- `column|row + manual` — the structured solver still packs children
  into tracks (so order / track assignment stays valid), but leaves
  the user-pinned frame size alone. Children may overflow the main
  axis (column = vertical, row = horizontal) when the user pins a
  frame smaller than the packed content — overflow is start-aligned
  (top for column, left for row) and allowed to spill.

`placeNode` (force-directed positioning of newly created nodes) runs
unconditionally when a `CREATE_NODES` command omits an explicit
position — it is independent of the per-frame sizing policy.

Agent batches set `executor.options.forceFitFrames = true`, which
refits every affected frame regardless of `sizing`. This is a
safety net for LLM dispatches that mutate child geometry without
explicitly specifying the new frame size.

## Implicit Edges

The layout engine builds a graph from both the visible canvas edges and hidden semantic relationships. These implicit edges pull related nodes closer together without requiring the user to draw connections manually.

| Relationship               | Weight | Description                                                              |
| -------------------------- | ------ | ------------------------------------------------------------------------ |
| User-drawn canvas edge     | `1.0`  | Direct mapping                                                           |
| `research.relatedNodeIds`  | `0.6`  | Synthesis node → each source node it cites                               |
| `origin.excerptFromNodeId` | `0.4`  | Excerpt node → the canvas node it was captured from                      |
| Same `research.threadId`   | `0.3`  | Nodes produced in the same research session, fully connected (all pairs) |
| Same `origin.threadId`     | `0.3`  | Nodes dragged from the same chat thread, fully connected (all pairs)     |
| Same frame (`parentId`)    | `0.2`  | Sibling nodes inside the same frame, fully connected (all pairs)         |

Two rules keep the graph clean:

- **Max weight, not sum**: if two nodes share multiple relationships, their edge carries the highest weight only.
- **Full connection**: same-thread and same-frame groups are all-pairs connected so stress majorization targets equal pairwise distances, producing clusters rather than chains.

## Implementation Overview

The pipeline runs in four stages:

1. **GraphModel** converts ReactFlow nodes and edges into a framework-agnostic `LayoutGraph`. Frame containment (`parentId`) becomes compound-node groups. Explicit and implicit edges are merged here.

2. **LayoutEngine** uses two solvers for different operations:
   - **WebCola** (stress majorization) for full layout (`layoutAll`, `layoutGroup`) — starts from current positions and monotonically reduces stress, preserving spatial familiarity. _Deprecated entry points; retained for historical replay only._
   - **fCoSE** for incremental placement (`placeNode`) — uses hard `fixedNodeConstraint` pins so existing nodes stay perfectly still while the new node is positioned.

3. **Solvers** share the same interface and both handle compound nodes (frames), fixed constraints, disconnected components, and edge weights. All positions are converted to absolute coordinates before the solver runs and back to parent-relative on write-back.

4. **PositionApplier** snapshots the current state for undo, then writes updated positions and frame sizes back to the node array.
