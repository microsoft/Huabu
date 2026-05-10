# Layout Recipes

Opinionated layouts for structured diagrams (architecture diagrams, flowcharts, mind maps, hierarchies, roadmaps). Load this when the user asks for a structured diagram or you are building one from scratch. The mental model and command catalogue live in [`SKILL.md`](../SKILL.md); this file is purely about geometry and visual grouping.

## Coordinate system

- The canvas uses x (right = positive) and y (down = positive) coordinates.
- A standard node is about **400px wide** and **300px tall**. Use a gap of **~50px** between nodes.
- Headers / labels can be narrower (≈250px wide).
- **Always set `skipAutoLayout: true`** on every node when you supply an explicit `position`, otherwise the force-directed engine will overwrite your layout.

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
- **Position the frame first**, then position children. Child positions are absolute (canvas-relative), not frame-relative — but it is easier to think of children as offsets from the frame's top-left.
- Give the frame a clear `data.label` so the group is identifiable when zoomed out.

## Connecting layers

- Use `CONNECT_NODES` with `direction: "forward"` for primary data flow.
- Use `lineStyle: "dashed"` for secondary / feedback / optional connections.
- Use distinct `stroke` palette tokens to distinguish relationship types (e.g. one colour for "data flow", another for "control flow").
- **Edges are noise.** Only draw an edge when the relationship is not obvious from layout. A clean column of nodes implies "these belong together"; you do not need a chain of arrows to say so.

## Visual grouping with accent colours

- Set `style.accent` (a palette token from the schema enum, e.g. `"purple"`, `"cyan"`, `"amber"`) via `MERGE_NODE_DATA` on every member of a logical group.
- Use the **same accent** for every node within a layer / track / cluster — this is what makes the group readable at low zoom levels.
- Reserve `"grey"` for de-emphasised / neutral material.
- Allowed tokens are enumerated in the `CREATE_NODES` schema (`data.style.accent`) — no hex values needed.

## Post-layout cleanup

- Optionally call `ALIGN_NODES` on nodes within the same row / column for pixel-perfect alignment.
- Call `DISTRIBUTE_NODES` on a row / column of ≥3 nodes for even spacing.
- Both run inside the same batch as the creates — the user sees one undo step.

## Recipe: row-track flowchart / research roadmap

Each track = horizontal theme with optional sub-layer below. Use this for flowcharts, process diagrams, research roadmaps, knowledge maps.

### Plan first

Determine: number of tracks (rows), nodes per track, sub-nodes per main node, relationships (horizontal = sequence, vertical = supports / evidence).

### Geometry

- Track Y: `track0 = 0`, `track1 = 500`, `track2 = 1000` — 500px gap between tracks.
- Sub-nodes: `+250px below their main row`.
- Horizontal: header at `x = 0` (text node, w=250, bold), main nodes at `x = 300, 750, 1200, 1650` (450px spacing). Sub-nodes centred horizontally below their parent.
- Sizes: header w=250, main w=400, sub w=350.
- Always set `skipAutoLayout: true` + explicit `position`.

### Colour per track

Pick **one palette token** per track and apply it to every node's `data.style.accent` in that track. Use distinct tokens across tracks for separation; reserve `"grey"` for de-emphasised / neutral tracks.

### Edges

Keep edges minimal — let proximity and alignment imply relationships. Only connect nodes where the relationship is non-obvious (cross-track support, semantic dependency).

### Single-batch order

1. `CREATE_NODES` (headers + main + sub, all with explicit positions and ids).
2. `CONNECT_NODES` (horizontal sequence + cross-track verticals).
3. `ALIGN_NODES` (`center-v` per row) + `DISTRIBUTE_NODES` (per row).

### Example 3-track layout

```
Track 1 (y=0):    [Header] [A]→[B]→[C]→[D]   sub(y=250):  [PaperX] [PaperY] [PaperZ]
Track 2 (y=500):  [Header] [1]→[2]→[3]        sub(y=750):  [RefA] [RefB]
Track 3 (y=1000): [Header] [A]→[B]→[C]        sub(y=1250): [RefC]
```

## Future recipes (placeholders)

The following are intentionally short stubs — fill them in when you ship the first canvas that needs the recipe.

- **Mind map (radial).** Centre concept node, N first-level branches on a ring, sub-branches fanning further out.
- **Timeline.** Single horizontal track with evenly-spaced date markers; optional sub-rows for parallel storylines.
- **Knowledge map (clusters + bridges).** Multiple frame-bound clusters laid out by topic; sparse "bridge" edges marking cross-cluster relationships.
