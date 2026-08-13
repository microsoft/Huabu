# Layout Recipes

Opinionated layouts for structured diagrams (architecture diagrams, flowcharts, mind maps, hierarchies, roadmaps). Load this when the user asks for a structured diagram or you are building one from scratch. The mental model lives in [`SKILL.md`](../SKILL.md); this file is purely about geometry and visual grouping.

## Coordinate system

- The Space uses x (right = positive) and y (down = positive) coordinates.
- A standard node is about **400px wide** and **300px tall**. Use a gap of **~50px** between nodes.
- Headers / labels can be narrower (≈250px wide).
- **`position` is required** on every `CREATE_NODES` entry. It is **parent-local**: relative to the node's `parentId` frame, or absolute canvas coords when there is no parent (root). It is the same coordinate space as the `position` you read from `inspect_nodes` (not `absolutePosition`). There is no auto-layout — if you omit `position`, the engine falls back to `(0, 0)` (often off-screen), so always pick an explicit slot.

## Choosing node size

- In an existing layout, inspect the intended anchor or cluster before setting `size`. With an anchor id, the fastest path is one call: `inspect_nodes({ nearNode: { id: "<anchorId>", sameParent: true, maxCount: 5 }, byType: "<newNodeType>" })`. Results include `size`; no separate anchor inspection or whole-Space outline is needed. Match peers with the same semantic role and use their median dimensions rather than copying an outlier.
- Without an anchor id but with an intended absolute position, use `inspect_nodes({ nearPoint: { x, y, maxCount: 5 }, byType: "<newNodeType>" })`. If neither query returns a comparable peer, do not spend another read trying to manufacture one.
- If there is no comparable peer, omit `size` and let Huabu use the node type's canonical default. Do not invent an oversized box merely because the new node has more content.
- For a long or multi-section `note`, prefer a fixed numeric height so the canvas remains scannable: match nearby Notes when available; otherwise use `size: { width: 400, height: 400 }`. Reserve `height: "auto"` for short Notes whose full inline expansion is intentional.
- `text` and `question` heights are always content-driven; never set their height. For `image`, match a comparable peer's width and omit height so Huabu derives it from the source aspect ratio. For `video`, match both dimensions of a comparable Video or omit `size` entirely.

## Positioning patterns

### Hierarchical / top-to-bottom

Layers at increasing y values: `y = 0, 400, 800, …`. Within a layer, spread nodes along x. Good for org charts, decision trees, system architecture (UI on top → service → datastore at bottom).

### Left-to-right flow

Stages at increasing x values: `x = 0, 450, 900, …`. Within a stage, spread nodes along y. Good for pipelines, sequential processes, request flows.

### Grid

Compute `(row, col)` and map to `(x = col * (width + gap), y = row * (height + gap))`. Good for catalogues, comparisons, status boards.

### Fan / radial (around a centre)

Place the centre at `(cx, cy)`; place N children on a ring of radius `r`. For evenly distributed angles: `theta_i = 2π * i / N`, then `xi = cx + r·cos(theta_i)`, `yi = cy + r·sin(theta_i)`. Good for brainstorm fans around a source node.

## Grouping with frames

- Create a frame for each logical group / layer, sized to enclose its children with **~40px padding** on every side.
- Use `SET_NODE_PARENT` to parent child nodes into the frame.
- **Position the frame first**, then position children. Child `position` is **frame-relative** (parent-local): a child at `(0, 0)` sits at the frame's top-left. So the coordinates in the patterns above are the child's offsets **inside** the frame, starting from `(0, 0)` + your padding.
- Give the frame a clear `data.label` so the group is identifiable when zoomed out.

### Structured frame layout (`column` / `row` / `grid`)

A frame can opt into a deterministic layout that re-flows its children automatically whenever they change (added, removed, resized). Use `SET_FRAME_LAYOUT` to switch a frame between `free` (default), `column`, `row`, or `grid`, optionally with `gridCount` (number of tracks, 1–12, default 1):

```
SET_FRAME_LAYOUT { frameId: "<frame-id>", mode: "column", gridCount: 3 }
```

- `column` — N columns, children stack top-to-bottom inside each column, left-aligned. Column width adapts to the widest child.
- `row` — mirror on the other axis: N rows, children stack left-to-right inside each row, top-aligned. Row height adapts to the tallest child.
- `grid` — N columns like `column`, but rows are aligned too: every child holds a cell, children sharing a row sit on one row origin, and the row's height is its tallest member.
- The engine assigns each child to a track automatically (least-full track wins). To place children yourself, pass `cells` on the same `SET_FRAME_LAYOUT`: `column` addresses columns, `row` addresses rows, `grid` addresses both. To control vertical (column mode) or horizontal (row mode) order _within_ a track, set initial child positions; the engine sorts by that axis. `grid` is the exception — it does not sort by position at all, see below.
- Structured frames default to `sizing: "hug"`: the engine re-sizes the frame after every child change, so do not pass an explicit frame size in this mode. Use `sizing: "manual"` to preserve a pinned frame size while children still reflow; children that do not fit may overflow along the main axis.
- Switch back to free positioning with `SET_FRAME_LAYOUT { frameId, mode: "free" }`.

Use `column` / `row` for: stacked column lists, kanban-style boards, row tracks where each lane represents a theme.

#### Choosing `grid` over `column`

`column` is masonry — each column packs independently, so a column holding fewer items pulls its next item up. That breaks any layout where a node in column A is supposed to line up with a specific node in column B. `grid` fixes exactly that case: a column with no item in a given row leaves the cell blank instead of back-filling it.

Reach for `grid` whenever the columns are **parallel series** rather than independent stacks — question notes beside their answers, papers beside a per-paper summary, an original beside its translation — especially when some items have no counterpart.

Rows are **not** derived from position. Each child holds a cell, and children left without one all default to row 0 and are then bumped down to resolve collisions inside their column — which pairs them essentially at random. So a `grid` frame is only worth switching into once you state the cells: give the two members of a pair the same `row`, and skip that row number in the column that has no counterpart.

```
# Row 1 has no right-hand counterpart, so column 1 simply skips it.
SET_FRAME_LAYOUT {
  frameId: "<frame-id>",
  mode: "grid",
  gridCount: 2,
  cells: [
    { nodeId: "<q1>", column: 0, row: 0 },
    { nodeId: "<a1>", column: 1, row: 0 },
    { nodeId: "<q2>", column: 0, row: 1 },
    { nodeId: "<q3>", column: 0, row: 2 },
    { nodeId: "<a3>", column: 1, row: 2 }
  ]
}
```

Do not send `SET_NODE_GEOMETRY` for these children: `grid` computes every child position from its cell, so any position you pass is overwritten.

Adding a missing counterpart later is a two-command follow-up: create the node inside the frame, then re-issue `SET_FRAME_LAYOUT` with a `cells` entry naming its column and the row it should pair with. The solver re-derives the bands and the new node lands in the blank cell.

## Connecting layers

- Use `CONNECT_NODES` with `direction: "forward"` for primary data flow.
- Use `lineStyle: "dashed"` for secondary / feedback / optional connections.
- Use distinct `stroke` palette tokens to distinguish relationship types (e.g. one colour for "data flow", another for "control flow").
- **Edges are noise.** Only draw an edge when the relationship is not obvious from layout. A clean column of nodes implies "these belong together"; you do not need a chain of arrows to say so.

## Accent tokens as a layout signal

In structured layouts, accent doubles as a layout primitive: pick **one accent token per layer / track / cluster** so the structure stays readable when the user zooms out. Use **distinct tokens across groups** for separation; reserve `"grey"` for de-emphasised material.

## Post-layout cleanup

- Optionally call `ALIGN_NODES` on nodes within the same row / column for pixel-perfect alignment.
- Call `DISTRIBUTE_NODES` on a row / column of ≥3 nodes for even spacing.
- Both operate on the created nodes, so run them in the **follow-up call** (alongside `CONNECT_NODES`) using the ids the create step returned in `results[].nodes` — not in the create call itself.

## Recipe: row-track flowchart / research roadmap

Each track = horizontal theme with optional sub-layer below. Use this for flowcharts, process diagrams, research roadmaps, knowledge maps.

### Plan first

Determine: number of tracks (rows), nodes per track, sub-nodes per main node, relationships (horizontal = sequence, vertical = supports / evidence).

### Geometry

- Track Y: `track0 = 0`, `track1 = 500`, `track2 = 1000` — 500px gap between tracks.
- Sub-nodes: `+250px below their main row`.
- Horizontal: header at `x = 0` (text node, w=250, bold), main nodes at `x = 300, 750, 1200, 1650` (450px spacing). Sub-nodes centred horizontally below their parent.
- Sizes: header w=250, main w=400, sub w=350.
- Always set an explicit `position` on every node — in parent-local coordinates (frame-relative for framed children, absolute for root nodes).

### Colour per track

Pick **one accent token** per track and apply it to every node in that track; use distinct tokens across tracks.

### Edges

Keep edges minimal — let proximity and alignment imply relationships. Only connect nodes where the relationship is non-obvious (cross-track support, semantic dependency).

### Order (across calls)

1. **Create call** — `CREATE_NODES` (headers + main + sub, all with explicit positions). Read the assigned ids back from `results[].nodes`.
2. **Follow-up call**, using those ids:
   - `CONNECT_NODES` (horizontal sequence + cross-track verticals).
   - `ALIGN_NODES` (`center-v` per row) + `DISTRIBUTE_NODES` (per row).

### Example 3-track layout

```
Track 1 (y=0):    [Header] [A]→[B]→[C]→[D]   sub(y=250):  [PaperX] [PaperY] [PaperZ]
Track 2 (y=500):  [Header] [1]→[2]→[3]        sub(y=750):  [RefA] [RefB]
Track 3 (y=1000): [Header] [A]→[B]→[C]        sub(y=1250): [RefC]
```

## Future recipes (placeholders)

The following are intentionally short stubs — fill them in when you ship the first Space that needs the recipe.

- **Mind map (radial).** Centre concept node, N first-level branches on a ring, sub-branches fanning further out.
- **Timeline.** Single horizontal track with evenly-spaced date markers; optional sub-rows for parallel storylines.
- **Knowledge map (clusters + bridges).** Multiple frame-bound clusters laid out by topic; sparse "bridge" edges marking cross-cluster relationships.
