# Canvas Command Architecture

## Overview

Canvas mutations use a three-layer model:

1. **`CanvasUiIntent`** — web-only user interaction semantics (`apps/web/src/handler/canvasCommand/uiIntent.ts`)
2. **`CanvasCommand`** — shared executable JSON command schema (`packages/shared/src/types/canvas/command.ts`)
3. **`CanvasExecution`** — batch/transaction boundary for validation, undo, action trace, and side effects (`packages/shared/src/types/canvas/execution.ts`)

Data flow:

1. Web gesture → `CanvasUiIntent` → resolver → `CanvasExecution` → executor
2. Agent response → `CanvasCommand[]` → `CanvasExecution` → executor
3. Executor → validate, apply, trace, snapshot, effects

`CanvasExecution.source` defaults to `ui`. Most command behavior is shared
across sources; the notable selection exception is `CREATE_NODES`: UI-created
non-`question` entries in that command become the active selection, while
agent/system-created entries and `question` entries preserve the existing
selection.

`getNodeDefaultSize()` supplies a uniform 400-unit default width for new nodes, including Text, Audio, and Space shortcuts. New Notes default to fixed height 300; explicit auto ownership is preserved, and the toolbar can still switch height modes. Other types retain their height policies. Explicit dimensions from creation, drawing, media geometry, or saved nodes remain authoritative; these defaults do not migrate existing geometry or ownership. Space shortcuts and World placement share `SPACE_SHORTCUT_SIZE.defaultWidth`.

`CREATE_NODES` accepts `size.height: "auto"` as an explicit height intent. The shared command records `data.heightMode: "auto"` for Notes and removes the nonnumeric height before materializing geometry through the existing auto-height policy. This applies equally to direct `/execute` calls, built-in tools, and Space operations; numeric heights and omitted-height fixed defaults are unchanged. Clipboard paste resolves each source Note's height ownership with `resolveHeightMode` before creation, preserving legacy auto Notes instead of treating them as newly authored fixed-height Notes.

## Layer 1: CanvasUiIntent

`CanvasUiIntent` is a web-only input model for user gestures. It resolves UI-specific ambiguity (selection, clipboard, drag context, viewport position, rectangle hit-testing) into explicit `CanvasCommand` operands.

`CanvasUiIntent` must not be shared with the agent because it depends on ephemeral frontend state.

The web `DELETE_NODES` intent accepts optional explicit `edgeIds` for a mixed selection and resolves node deletion plus the existing edge-disconnection resolver into one execution. Delete/Backspace uses this combined path whenever whole nodes are selected; ownership refusal or child-Space confirmation defers the entire action, with no edge-only follow-up. Ordinary mixed deletion records one undo snapshot. Edge-only deletion retains its existing intent.

### UI intent design rules

Resolvers:

1. Read UI-only state (selection, clipboard, drag context, viewport, hit-testing).
2. Resolve ambiguous gestures into explicit operands.
3. Return `UiIntentResolution { commands, trace, ...uiEffects }`.
4. Never mutate canvas state directly.

Resolvers must not:

1. Own undo snapshots
2. Write action trace directly
3. Trigger ingestion or label resolution
4. Apply state mutations

### UI intent implementation

Types and resolvers: `apps/web/src/handler/canvasCommand/uiIntent.ts` + `apps/web/src/handler/canvasCommand/resolvers/`.

22 intent types: 8 composite gestures (need selection/clipboard/drag/viewport resolution) + 14 direct-mapping intents (thin wrappers to `CanvasCommand`). See `uiIntent.ts` for the full union.

### Post-create editing

`UiIntentResolution.editNodeId` is a transient web-only request applied after the resolved commands commit successfully. `ADD_NODES` sets it when one `note` or `text` node with `user-created` origin is created: a note opens in the expanded view and focuses its editor, while a text node enters inline editing and focuses its textarea. Notes saved from Chat do not request editing. Batch creation leaves it unset because there is no unambiguous editor target.

The request never enters `CanvasCommand`, persisted node data, or deltas. Agent execution, SSE application, delta replay, and rejected create commands therefore cannot open a view or steal focus.

### Automatic placement and post-create reveal

`ADD_NODES` inputs without an explicit `placementPoint`, including saving a Chat as an Agent node and saving a whole response or selected Markdown as a Note, are centred in the unobscured Canvas area. `dispatchUiIntent` uses `getCanvasViewportCenter()`, which reuses `getCanvasVisibleArea()` to subtract both panel insets before converting the centre through React Flow. Destination-initiated Space moves share this viewport helper and `viewportCenterAnchor()` sizing without executing a local create command. Explicit drag/drop anchors and frame hit-testing are unchanged.

When an explicitly anchored `ADD_NODES` input lands in a `column` or `row` Frame, the resolver uses the same edge-aware `resolveMasonryDrop` picker as drag/drop to persist the pointed track in `frameColumn` or `frameRow` before creation. The parent-local anchor remains the intra-track sort key, so new nodes enter at the chosen position instead of falling back to the least-full track. Clicking a gutter selects the nearest existing track by distance to its boundaries, not its centre, so unequal track widths or heights do not bias the choice; equal distances choose the earlier track. Creation does not arm track insertion. Inputs without a placement point and shared agent/system `CREATE_NODES` commands retain automatic track assignment.

In a `grid` Frame, explicitly anchored creation selects the nearest existing column and row by their solver-derived boundaries, including both edges. Internal gaps choose the nearest existing cell rather than requesting a row; equal distances choose the earlier track. Above the first row creates a leading row, and below the last row appends, so clicking below the content does not insert ahead of its final row. `planStructuredDrop` then resolves occupancy: an empty cell leaves peers unchanged; an occupied cell inserts at that row and shifts its previous occupants and later rows down. This occupancy rule is separate from gap detection. Batched external additions honor each explicit row-insertion request in input order, including requests targeting empty columns; each opens a row and shifts prior placements at or below it. Creation never opens a column. The resolver groups additions by Frame and appends `SET_FRAME_LAYOUT.cells` after `CREATE_NODES` in the same execution, so the first layout pass sees the intended cells and displaced peers. This applies to Agent Nodes and other node types alike; unanchored creation keeps automatic assignment.

`UiIntentResolution.revealNodeIds` requests a reveal only for automatically placed additions. After execution, the store queues only IDs that were actually created, excluding rejected commands and pre-existing nodes. `useRevealCreatedNodes` consumes the latest request once Canvas is mounted and its initial viewport is ready; `revealNodesOnCanvas()` preserves zoom and pans only as much as needed to expose the bounds. These requests are transient and cleared on Space load/switch, not persisted or replayed through undo.

Fullscreen Preview unmounts Canvas. Saving there uses the stored viewport as a placement fallback, keeps the conversation fullscreen, and defers the reveal until the user returns to Canvas. If no viewport exists yet, placement falls back to `(0, 0)` and the same post-mount reveal makes the new node discoverable.

Composite intent examples:

The web-only `REORDER_NODES_RELATIVE` intent takes explicit node IDs and a relative target, replacing the former single-node `REORDER_NODE` intent. It emits one existing shared `REORDER_NODES` command and one action trace containing all moved nodes. Layers uses this path for single-node and same-parent multi-node sorting, retaining the engine's stable array order, end-of-batch tree normalization, and single undo snapshot.

Layers preflights moves while drawing drop feedback, but the intent resolvers own final validation against the live state at release. Relative sorting also uses `canMoveNodesToParent` to reject missing members, mixed parents, and locked sources or ancestors, and requires a live same-parent target outside the moving subtree. Rejected sorting returns `layers.invalidFrameDrop` with no commands or traces, just like rejected reparenting, so a cached insertion indicator cannot bypass a lock added during a drag.

`MOVE_NODES_INTO_FRAME` replaces the former single-node `MOVE_NODE_INTO_FRAME` intent and takes explicit same-parent root IDs, a destination Frame, and an optional relative child target. It validates the whole group, destination and source ancestor locks, descendant cycles, and the insertion target before emitting batch `SET_NODE_PARENT` plus one `REORDER_NODES` command containing complete moved Frame subtrees. Rejected resolutions carry `rejectionKey` with no commands or traces; `dispatchUiIntent` shows the localized warning and performs no mutation. Valid moves generate one trace per moved root within one execution and undo snapshot. The shared parent command preserves world geometry, and its affected-frame set drives the executor's final structured-layout/fit pass for both source and destination; the resolver does not precompute layout using stale source-local positions. The store's existing `moveNodeIntoFrame` action accepts one ID or an array so single-node callers retain their API.

`MOVE_NODES_OUT_OF_FRAME` takes explicit same-parent child IDs and an optional root-level relative target. It reuses `canMoveNodesToParent` for whole-group membership, source/ancestor locks, and same-parent validation, rejects insertion targets inside a Frame or the moving subtree, and emits batch `SET_NODE_PARENT` with `parentId: null` plus an optional subtree-aware `REORDER_NODES`. Each root produces a `node_unframed` trace within one undoable execution, and the executor's final affected-Frame pass reflows the source after the complete detach. The existing `moveNodeOutOfFrame` store action accepts one ID or an array, preserving single-node callers.

Structure PUT serialization explicitly sends `parentId: null` for root nodes, including those restored by undo/redo. React Flow's absent parent field is not an explicit detach on the editable PUT contract: omitting it preserves the current server parent. This translation stays at the wire boundary rather than adding nullable parents to React Flow's node type.

Same-parent move validation treats both a persisted `null` parent and an absent React Flow parent as the root, so loaded, newly created, and detached root nodes can move together.

`SET_CARD_SCALE` resolves an absolute toolbar percentage into a proportional Question or Space font and outer-width update in one execution. It uses the existing `MERGE_NODE_DATA` and `SET_NODE_GEOMETRY` commands, preserving style siblings and content-driven height. The caller preflights rejected/no-op input before arming the geometry gesture; the mixed batch then records one undo step. Percentages are UI values only, not new persisted fields.

| Intent                       | Why UI-only                                               |
| ---------------------------- | --------------------------------------------------------- |
| `GROUP_SELECTION_INTO_FRAME` | Depends on current selection                              |
| `GROUP_RECT_INTO_FRAME`      | Hit-tests a rectangle against nodes                       |
| `PASTE_CLIPBOARD`            | Depends on clipboard state and paste anchor               |
| `NODE_DRAG_STOP`             | Depends on drag session and drop target                   |
| `SELECT_NODES`               | Resolves modifier-key mode (`replace` / `toggle` / `add`) |

## Layer 2: CanvasCommand

`CanvasCommand` is the shared executable command schema. It is the only command type the executor accepts. Both web and agent converge to this schema.

### Command design rules

`CanvasCommand` is the smallest shared executable domain instruction (not the smallest state diff). A command may own deterministic domain behavior inside execution:

- `DELETE_NODES` automatically removes incident edges.
- `INITIALIZE_PDF_NOTE` accepts a PDF `nodeId` and creates one empty, hidden, independently stored Note plus its ownership link in a single undoable operation. It reuses the ordinary Note creation handler and naming/defaults. Existing valid links are no-ops that preserve content; malformed links and missing/non-PDF targets fail without mutation. Server execution returns the created or reused Note in `results[].nodes[0]`, including on a no-op, so Agent callers never assign or coordinate Note IDs. The frontend notes action uses this same command. Persistence uses the executor's existing rollback-protected topology/sidecar commit and mutex.
- `SET_NODE_PARENT` rejects invalid targets, non-Container parents, or cycles. Frames are the only persistent Container type; `spacePreview` nodes may be Frame children but cannot own children.
- `CONNECT_NODES` rejects the command (`applied: false`, `reason: 'invalid-target'`) when any edge endpoint is not a live node — it never silently drops the edge.
- `ALIGN_NODES` aligns provided nodes without relying on selection.
- `DISTRIBUTE_NODES` means "Spread apart", not equal spacing. It requires at least three IDs and uses `spreadNodes` with a 24px gap within each parent group; unlisted nodes are not obstacles. The command name remains unchanged for compatibility.

Every `CanvasCommand`:

1. Must be JSON-serializable.
2. May read persistent canvas state during execution.
3. Must not depend on UI-only state (selection, clipboard, marquee, drag, viewport).
4. Must use explicit operands (node ids, frame ids, edge ids, scope).
5. Returns `applied: false` with no side effects if it cannot be applied.

### Coordinate space (parent-local)

Node geometry on `CanvasCommand` (`CREATE_NODES.position`, `SET_NODE_GEOMETRY.position`) is **parent-local**: relative to the node's direct parent frame, or absolute canvas coordinates when the node has no parent (root-local == world). This is the single coordinate contract for every caller — web resolvers already convert gestures to parent-local before emitting commands (`resolveAddNodes` subtracts the target frame's absolute origin), and the agent tool schema mirrors it. There is no absolute→relative adapter between the tool boundary and the executor.

The executor interprets the submitted `position` in that local space; a subsequent frame-fit or structured-layout pass may then normalize the persisted local value (e.g. a hug frame moves its origin and rewrites children's locals to preserve their world placement; a `column`/`row` frame re-slots children and treats `position` only as an intra-track sort key). So the contract is "interpret the input as parent-local", not "persist the numeric input verbatim". The agent-facing read side exposes the same `position` plus a read-only resolved `absolutePosition`.

### Structured Frame gutters

The shared structured solver treats internal edges as layout inputs for `column`, `row`, and `grid` Frames. Each edge crossing a track boundary contributes a deterministic gutter demand; labels use a renderer-aligned bounded text estimate, while unlabelled edges receive a minimum routing channel. The solver takes the maximum demand per local boundary, records lane assignments, and changes only that gutter's size: child ordering and persisted track assignments remain node-driven. In Grid mode, an edge that crosses columns assigns its label clearance to the X gutter only; Y gutters handle only edges whose endpoints remain in the same column.

Every structured child persists its cell under fields named after the axes they address: `data.frameColumn` for `column` and `grid`, `data.frameRow` for `row` and `grid`. A single mode-dependent `data.frameSlot` used to serve all three, which forced every reader to know the mode before it could tell a column from a row; each solver now falls back to it on its own count axis only and writes the axis-named field, so a Frame sheds the legacy name on its first relayout. Rendered `position` is solver output and never determines cell membership. In `grid`, a row band is as tall as its tallest member and every member is centred on the band's mid-line rather than hung from its top edge, so a row of unequal heights still reads as one row. Moving into an empty cell changes only the dragged child's assignment unless the move empties a row or column; in that case the planner canonicalizes the occupied indices into a contiguous sequence. Empty row indices have no persistent identity, so this compaction may also remove pre-existing gaps, while an explicit `gridRowCount` still restores its minimum number of visible bands during layout. The solver enforces at most one child per `(frameRow, frameColumn)` cell. Drag preview and commit use the same solver-derived, edge-aware row bounds: an internal drop onto an occupied cell swaps the two children, while an external drop onto an occupied cell inserts a row and shifts only that row and later rows down. Agents address cells through `SET_FRAME_LAYOUT`'s `cells` array rather than by patching node data, which keeps the assignments in the same batch as the layout pass that consumes them. `solveStructuredFrameLayout` is the single size source for structured Frame preview and commit, while generic bounding-box `computeFrameFit` remains exclusive to free Frames.

Both of a `grid`'s axes can be **grown** by a single-node drop after gap dwell, not just permuted. The web's `resolveGridDrop` solves the original Frame once and shares that result with `resolveMasonryDrop` on both axes to select existing cells and narrow candidate gaps. Cursor-based creation also shares one original layout per target Frame across the entire creation batch. These caches are local to one computation, never retained across model changes. At crossing gaps, a single-node drag retains the previous candidate axis; a fresh crossing prefers columns. Only one axis can arm at a time.

A selection within one Grid moves as a group, including same-column, diagonal, rectangular, L-shaped, and sparse selections. The actual dragged member anchors an ordinary cell target; both row and column offsets are preserved, and boundaries constrain the complete span rather than individual members. The shared planner assigns all selected destinations atomically: selected members never displace each other; a collision opens a block of rows matching the group's height and shifts unselected peers at or below the block's top. Empty destinations need no inserted rows. Groups can arm row gaps (including head/tail padding), but not column gaps; crossing gaps therefore choose the row axis, and an armed gap anchors the top of the complete block regardless of which member was grabbed. Ordinary previews show every selected footprint and exclude all selected nodes from peer reflow. Compaction retains empty rows and columns inside the moved block so it cannot change the selection's shape; empty bands outside that span retain the usual compaction policy. Grid's normal layout also retains interior empty columns, including after reload, while trimming unused outer columns; masonry layouts keep their full empty-track compaction. These are cell offsets, not fixed pixel distances: row heights and column widths still follow content. Cross-Frame moves retain their existing per-node behavior and cannot arm group insertion.

All modes derive drop bands from the shared structured solver, including gutters widened by internal edges. Pointer interaction returns an existing-track target and, when eligible, a narrow candidate gap. Gaps span the content along the other axis, are capped at 24 screen pixels across, and include end-padding strips inside the Frame without extending into outside space or manual Frame slack. A track's full extent, including its boundary, belongs to that track rather than an insertion gap. The previous existing track is retained while crossing an internal gutter. Only the transient preview's continuous 300ms dwell can promote a candidate to `insert-new`; the geometry picker and no-preview release fallback never request a new track by themselves. Changing node, selection membership, Frame, axis, or gap restarts the timer; leaving cancels it, and release validates that the pointer is still inside the armed gap. Only single-node drags and same-Frame Grid groups have candidates; count axes at the track cap have none, while Grid content rows are not capped by the column-count limit. Empty masonry tracks still compact after a move; this interaction does not introduce persistent empty tracks. A Grid blank row remains an addressable target, without acquiring a persistent identity across later structural edits. The shared low-level pickers retain their geometric insertion behavior for callers without explicit pointer targets; web preview and commit supply both targets for Grid.

Cell membership is solver output only once it exists. A child that has never been placed carries no cell, which is the state every Frame is in the moment it leaves `free` — and there the child's rendered position is the only record of what the user arranged. Entering a structured mode therefore seeds the missing indices from geometry: children are bucketed into visual bands along the mode's axis (X for `column`, Y for `row`, both for `grid`) and each band becomes a track. `grid` bands its rows **globally across columns**, so children that read as side by side keep a shared row; banding per column would hand each column's first child row 0 and destroy the correspondence the mode exists to express. Seeding runs only when the Frame has no persisted assignment at all — a Frame being topped up with one newcomer has no band structure to read, so that case still falls back to the least-full track. Once seeded, indices are persistent, so later drags move one child rather than re-deriving every membership from rendered geometry.

The track count follows the same rule, because it is a property of the arrangement rather than a setting that outlives it. A layout-mode change drops both the stored `gridCount` and the children's cells, so the solver re-derives the count from the bands it just read and writes the resolved value back. Inheriting the count across a switch re-flows the Frame against a number chosen for a different axis, and the previous default of `1` flattened every arrangement into a single track — a hand-made 3x2 collapsed into one column whichever mode was picked. Switching modes is now arrangement-preserving in every direction, including back to `free`.

Naming a count explicitly is the opposite instruction: re-flow into that many tracks. `column` and `row` satisfy it through the existing `fill` policy. `grid` cannot, because its rows are persistent and two-dimensional: three children that shared a row cannot stay level in two columns, so keeping the bands only collides them and bumps the losers down into a ragged `AB | CD | E | F`. An explicit column count for `grid` therefore plans fresh cells outright in reading order (`planGridReflow`), which is what "make it N columns" means and what keeps the result an actual grid. An explicit `cells` payload still outranks the planned re-flow — the re-flow is for a caller that names a count _without_ knowing where anything should go, which is the Frame toolbar and not a drop. A drop that compacts or opens a track therefore restates every cell on the same command: the count change re-interprets all of them, and letting the re-flow deal the ones the drop did not restate put two children in one cell and committed a layout the drag never showed. The executor also disables empty-track filling when the latest applied layout command supplies cells, even after an earlier count-only command in the same execution. This preserves sparse placements through the final relayout, not just inside the command handler.

Retained empty Grid columns use the median child width, analogous to empty rows using the median child height. Their gutters and positive hit area remain available after deleting the column's last child, so users can place nodes back into the blank cells. Masonry modes still compact empty tracks.

`grid` also accepts a row count (`gridRowCount`), but the two axes cannot be pinned symmetrically: six children in three columns need two rows, and asking for one cannot make them fit. The row count is therefore a **floor**, not an exact count — it adds blank bands that remain valid drop targets and never removes the rows the content requires. These bands satisfy the requested minimum but have no stable individual identity; structural compaction may move the occupied rows, after which the solver materializes enough trailing bands to satisfy the floor again. The count is cleared on a layout-mode change for the same reason the column count is, and it outlives an explicit column re-flow because it is a frame-level policy rather than a cell assignment. The Frame toolbar reflects this asymmetry by re-syncing its row input from the resolved total rather than from what was typed, so a request that could not be honoured is visible immediately.

`grid` accepts sparse row indices because commands and imported documents may address cells beyond the currently occupied rows, and the solver must render every intervening band. Sparse input is bounded rather than treated as durable structure: when a structural drop empties a row, the planner renumbers occupied rows while retaining any empty bands inside a moved group's span. The ordinary row ceiling is twice the child count. The solver also retains collision-overflow indices up to `3 * childCount - 1`, the highest row the original collision resolver could produce, so a valid resolved layout survives reloads. Larger requested indices clamp to the highest retained bounded row, or the ordinary ceiling when no overflow row exists. Collisions advance within that same hard limit and wrap to an earlier vacant cell when necessary, preventing repeated solves from growing the allocation. This bound is enforced in the solver rather than at the wire boundary because it depends on the Frame's child count.

### Automatic edge routing

Edge routing has two layers: shared attachment-side selection and render-time path planning. Both hosts run `rerouteAllEdges` through the shared post-effects boundary after geometry, topology, or edge-style commands. It persists attachment handles without moving nodes or changing arrow semantics. The web's default `auto` line type then uses `routeOrthogonalEdge` to draw rounded orthogonal paths around visible cards and to discourage occupied channels. Explicit `straight`, `bezier`, and `step` choices retain their original geometry. An omitted line type resolves to `auto`; no migration or persisted waypoints are required. Both layers resolve parent-local positions through the canonical absolute-position getter.

The router first infers local fan-out/fan-in directions from distinct connected neighbours. At least two peers must lie entirely on the same side of a common node, align into a row or column, and not overlap along the perpendicular axis. Leading edges, centres, and trailing edges are considered separately to support unequal card sizes. Bands use a fixed origin and a size-relative, capped tolerance, preventing staircase chaining and tall-card overlap from manufacturing a group. Narrow entry bands and wider retention bands are computed independently from geometry; existing matching ports may use retention evidence only when entry evidence is absent. Expanding a retention band therefore cannot invalidate a strong subgroup or cause repeated reroutes to oscillate. Unrelated neighbours remain outside the group; incoming and outgoing connections contribute equally without reversing arrows. Competing horizontal and vertical evidence falls back to pairwise routing unless one has at least 1.5 times the support of the other.

Confident vertical groups prefer bottom/top ports, and horizontal groups prefer right/left ports. Otherwise, a clear gap on one axis supplies the pairwise preference. The generic candidate set remains four mutually facing pairs plus eight perpendicular pairs. Structured Frame siblings use the same group inference and stability policy but restrict fallback candidates to mutually facing pairs and retain their existing gutter-oriented policy of not detouring around sibling obstacles. Free Frames retain lightweight obstacle checks; Frame backgrounds themselves are never obstacles.

Attachment candidate evaluation uses `getEdgePath`, with XYFlow straight, smooth-step, or Bezier geometry; `auto` uses smooth-step as its inexpensive port-selection estimate. Routing approximates each cubic or quadratic curve with exactly eight uniformly spaced parameter segments; straight segments and curve endpoints are preserved. Its runtime dependency is the framework-independent `@xyflow/system`, keeping the shared router server-portable. Length and intersection estimates intentionally favor predictable cost over fine obstacle accuracy: small obstacles, corner grazes, and endpoint re-entry between samples can be missed. Sampled paths through endpoint interiors are avoided when alternatives exist. Each candidate's obstacle count saturates at three hits, after which remaining obstacle checks stop; clear routes still scan all local obstacles, so this is not a hard bound on total checks. Endpoint checks are separate and are not skipped when the obstacle count saturates. These estimates select handles; the final `auto` path uses the separate obstacle-aware planner.

A length budget rejects disproportionate detours, then layout-preferred ports win when their capped obstacle count is no greater than the best remaining candidate's. The fallback balances sampled route length, capped card intersections, and facing direction; it does not optimize edge-edge crossings or distinguish three crossings from more than three. Previous viable ports are retained for small score improvements (32 canvas pixels or 12% of the winning sampled path length, whichever is larger), provided they face outward, their capped hit count does not exceed the best candidate's, and no feasible layout preference takes precedence. Group inference, port stability, and coarse avoidance take priority over exact collision minimization.

The edge toolbar exposes Auto route alongside the explicit line shapes. Existing `sourceHandle` and `targetHandle` provide attachment history. Live drag ticks retain attachment sides while updating `auto` paths from displayed node geometry, including Frame previews and unconnected obstacles. On release, an actual move runs the shared routing post-effect against final geometry before the gesture's structure save. This is required even when drop resolution applies no commands: ordinary free-node moves, moves within manual free Frames, and whole-Frame translations already have their final positions in the store and can otherwise bypass command post-effects entirely. Position and port changes share the existing drag undo step and structure save. Zero-distance and cancelled drags do not reroute attachment sides. An unchanged attachment result preserves edge and array identities.

`AutoEdgeRoutingProvider` supplies one scene plan to `LabelledEdge`, using the same World visibility filter as React Flow. Its per-Canvas cache keys node geometry, hierarchy, visibility, edge endpoints, handles, effective line type, and clearance; selection, z-order, and content-only updates reuse the same route map. Geometry changes remain synchronous. The pure `orthogonalRouting.ts` planner uses outward port stubs, inflated rectangular obstacles, a bounded orthogonal search, rounded corners, and length/bend/channel costs. Endpoint ancestors are transparent so a connection may leave its Frame; unrelated Frames remain obstacles. Edges are planned in stable ID order, with nearby occupied segments and alternating offsets separating repeated endpoint pairs; crowding checks are local preferences while obstacle checks retain the complete scene. Actual React Flow port coordinates remain authoritative, with the last corrected route cached per entry. Paths are transient view geometry and never enter structure persistence or undo. A bounded fallback keeps the graph renderable when ports overlap obstacles or no route fits the search budget; it cannot guarantee clearance or eliminate unavoidable crossings in those cases.

Routine attachment selection first prunes obstacles to a conservative per-edge envelope and evaluates the preferred path alone. A preference with no sampled obstacle or endpoint hits that faces outward returns immediately if its sampled length fits the detour budget against the shortest candidate chord, a lower bound on sampled path length. Only ambiguous or obstructed cases evaluate every candidate; the fast path uses the same approximation and preference criteria as the full pass. This port-selection optimization is independent of the web scene's render-time path cache.

### Live structured drop preview

`describeStructuredDropZone` returns, alongside the drop footprint, a `reflow` list: where every **existing** child of the hovered Frame lands in the simulated post-drop layout. The web store publishes those positions each drag tick, so the Frame's contents visibly open a gap under the cursor instead of the drop being narrated by overlay rects. The dragged node is excluded — React Flow owns its position until release, and projecting a solved position for it would fight the cursor.

Candidate gaps in all structured modes deliberately suspend target projection: neither the existing-slot footprint nor simulated target geometry is published while dwelling in a gap. The original gap rectangle remains the hit target through dwell and activation, which displays only an insertion line and label. New-track layout is therefore applied at commit, not while the user aims or waits. Ordinary sorting and Grid cell targeting retain their footprint and peer-reflow previews.

What a drop _means_ is resolved by `planStructuredDrop`: which track the dragged children take, who they displace, and what becomes of the cell they vacate. Preview and commit both call it against the same pre-drag geometry, so the release cannot land somewhere the drag did not show. The rule previously existed twice — once in the preview helper, once in the drag resolver — and the copies had drifted: only the resolver compacted a row that a move emptied, so releasing the last child of a row made the layout jump. They also decided cell occupancy against different column values (pre- vs post-shift), which agreed only because opening a track and swapping a cell cannot happen in one gesture.

At release, destination cell and track-count mutations are applied to the projected tree before any affected-Frame layout runs. Column/row insertion order depends on the dragged node's live Y/X coordinate: reflowing its old track first replaces that coordinate with an old-track slot, making the committed insertion differ from the preview. The resolver reuses the pending-mutation helper used by structured relayout, then projects the complete destination layout and ancestor fits before emitting geometry.

For column/row drags, the store passes the ordinary target into `describeStructuredDropZone` and keeps it with the candidate gap in the transient preview. `gesturePreviewStore` owns one 300ms timer, preserved across movement inside the same node/Frame/axis/gap tuple, and promotes only the target intent when the timer expires. It never changes geometry. Mouseup snapshots the target before clearing the preview and carries it through `NODE_DRAG_STOP`, scoped to its node and Frame. Ordinary targets are recomputed from the release pointer, using the cached track only as a continuity hint within gutters, so a pointer move before the pending animation frame cannot commit the old track. Without a release pointer the cached target remains the fallback. An armed target is accepted only while the release point remains inside its gap; otherwise the resolver falls back to ordinary sorting. Candidate gaps are intersected with the actual Frame bounds, including when manual Frames have overflowing children. Pointer movement outside the gap clears intent before the next animation-frame projection. Modifier invalidation, cancellation, teardown, and canvas reset clear the pending timer with the preview.

When explicit targets are supplied (both column and row for Grid), `describeStructuredDropZone` skips pre-drop layout and solves only the simulated post-drop geometry. Otherwise it solves the original layout to pick missing targets. The same release-validated targets reach the drop planner, preserving preview/commit agreement.

For Grid groups, preview and release share `gridDragRequests` and submit the complete request set to `planStructuredDrop`. The preview carries the actual primary node and selection membership; cached insertion is rejected if that group no longer matches. `placements` reports each member's solved rectangle alongside unselected peer reflow. A group collision inserts one row block rather than applying a sequence of single-node swaps. At the sparse-row safety bound, the planner clamps the complete block, allowing its existing span to use the bounded collision reserve when it already exceeds the ordinary ceiling. The solver retains those bounded overflow rows and orders displaced peers by their requested rows, so a later solve does not shrink the moved group's offsets.

The drop target is resolved before the frame-fit preview pass rather than after it, so that pass can skip the frame the drop zone is about to solve anyway; the skipped frame's size is reported from the zone, and only recomputed if the zone fails to resolve. Solving it in both places was the same work twice, with the fit pass's answer discarded.

The preview never touches `canvasStore.nodes`. The complete future geometry is published once through `gesturePreviewStore.nodeGeometryPreviews` and folded into the node array at the render boundary only (`Canvas.tsx`'s `displayNodes`), so React Flow moves and resizes affected Frames and peers — and reroutes their edges — while the authoritative geometry stays exactly as the user left it. Selection HUD geometry builds the same transient tree before resolving nested absolute coordinates. A dragged node that is previewed leaving a Frame keeps its current `parentId` until release so React Flow retains drag ownership, but receives a compensated parent-local preview position derived from the projected detached world position and the projected source-Frame origin; its body, HUD, and eventual detach therefore share one absolute position even when a Hug source Frame moves while shrinking. Writing projections onto the real nodes, even through `_setStateNoAutosave`, made a per-tick future state indistinguishable from committed geometry to everything that reads the store: an agent write or history snapshot landing mid-drag would capture geometry the user never committed, and every picker had to strip the preview back off before it could reason about the drag at all.

Two properties follow from keeping it out of the store, rather than being maintained by hand:

1. **Ticks cannot compound.** The pickers and the solver always see the real pre-drag geometry, so a reflowed peer can never move the track bounds that decided where it went — the oscillation that a strip-then-apply controller had to prevent explicitly is not expressible here.
2. **Release uses the latest pointer against the same geometry.** `onNodeDragStop` snapshots the column/row track intent before withdrawing the preview; the resolver uses an armed insertion only if release remains in its displayed gap. Ordinary sorting classifies the release against the untouched geometry even when the pointer moved after the last preview tick. Nothing has to be restored before dispatch, and gesture cancellation and canvas teardown clear the same transient geometry field and dwell timer.
3. **One membership predicate.** A structured Frame claims a capture zone far larger than a free one's halo — its rect grown by the dragged node's own size — because appending or prepending a track means aiming at the outer padding, which drags the node's body (and the cursor with it) past the Frame edge with zero overlap left. `wouldStickToStructuredFrame` is that rule, and every stage asks it before asking `wouldUnframe`: the tick that draws the indicator, the tick that caches the membership decision, and the resolver's fresh-recomputation fallback. The drag tick's decision is replayed verbatim at drop time, so a stage that skips the predicate does not merely disagree in the abstract — it unframes the node in exactly the band where the overlay is offering a new track.

The rendered future tree includes the target Frame's projected size and peer positions. The structured overlay draws only the dragged node's final footprint; opening a new track retains a dashed outline and `+` so the structural change remains distinguishable. The preview carries the dragged node ID, and its overlay renders in React Flow's `ViewportPortal` one stacking level below that node, rather than above the entire canvas in a screen-space overlay. Its radius uses the same ordinary-node size tiers or Frame width tiers as the dragged shell; geometry, border, and radius scale together with the viewport. Track numbers, separator lines, full-track washes, and the redundant target Frame fit wash are not rendered. Other affected Frames retain their existing fit emphasis. The zone still exposes solver-derived track context for layout consumers, but the overlay does not project or draw those bands.

`CONNECT_NODES`, `DISCONNECT_EDGES`, and `SET_EDGE_STYLE` report **structured** Frames joined by their affected internal edges through `affectedFrameIds`, so the executor recomputes gutters in the same batch and reroutes handles after any resulting node movement. `free` Frames are deliberately not reported: they have no gutters, so naming one would only send it through the end-of-batch fit pass and turn an edge restyle into a frame resize that saves, broadcasts, and shares the restyle's undo step. Deferred web relayouts also pass current edges into the shared solver, preventing a render-time measurement update from reverting edge-aware spacing.

Single-Frame Hug resize previews capture immutable child geometry and topology at gesture start. Each animation-frame tick uses `structuredFrameResizeScale` to invert the canonical track layout after subtracting fixed padding, the header, item gaps, and edge-label gutters. Masonry tracks are solved individually so a change in the tallest or widest track cannot break pointer tracking. Preview, release, Hug fitting, and Manual layouts share width-independent density and the same unscaled edge-gutter policy. Targets below the fixed whitespace plus minimum child sizes are content-clamped. Free-mode resize retains proportional authored child positions and its explicit outer box. A multi-selection treats every selected Frame as a scaling root and transforms its complete descendant subtree in the same coordinate space, so the Frame continues to contain nested Frames and ordinary children; a nested selected Frame is handled by its outermost selected ancestor to avoid double scaling. Multi-selection movement uses preview geometry and performs one authoritative geometry commit on completion; proportional Text/Question font scaling and height-commit suspension follow the single-node resize lifecycle. Text/Question or media anywhere in the selected subtree force uniform geometry, but Note typography stays fixed and its document reflows or scrolls rather than scaling with the scene. See [canvas-input-interactions.md](./canvas-input-interactions.md#3-direct-manipulation) for the resize contract. The optional gutter override remains executor-local transient state and is never persisted in a command or canvas document.

Nested Frame resizing snapshots the complete subtree once, indexes direct children and internal edges per Frame, and applies each local inverse layout from immutable gesture-start geometry. Descendant geometry is dispatched in one batch per animation frame; Text/Question/Space fonts use their own initial width and font. Both Frame and multi-selection resize apply those font changes before dispatching geometry so Space minimum widths are clamped against the new content scale, including a single shrink tick followed immediately by release. The executor resolves affected Frames and ancestors deepest-first, interleaving structured relayout and free/Hug fitting so mixed-layout ancestors see final child footprints. Generic bounding-box fitting never overwrites an explicitly resized Frame, and Manual ancestors retain their authored boxes. Structured layout continues to own its existing content constraints and placement rules.

Resize proposals remain in the gesture-start parent coordinate space. Both the React Flow live mirror and the subtree controller compensate for ancestor-origin changes before writing local coordinates; release retains the flushed Frame position instead of replaying a stale local proposal. Frame sizes are engine-owned: intermediate ResizeObserver dimensions from CSS size transitions do not trigger ancestor fitting or replace the authored measured footprint. History restores fixed measurements alongside authored dimensions, preventing stale live measurements from changing restored nested geometry.

### Agent Node field ownership

An Agent Node's complete read model is not an ordinary write DTO. Structure PUT and `MERGE_NODE_DATA` edit layout, authored content, and presentation, while `bindingState`, `invocationToken`, invocation `status` / `errorMessage`, `viewed`, and `threadId` belong to server business paths. The shared Agent ownership projection omits these fields from browser saves; server validation rejects explicit writes, including requests labelled `originator.source: system`. This bounded rule applies to Question nodes, not similarly named fields on unrelated node types. For Question patches, omission or `undefined` preserves a field; clearing is explicit (for example empty authored text or `agentLaunchOverrides: null`). Other node types retain their existing local shallow-merge reset semantics, including clearing PDF `coverUrl` with `undefined`.

Editing preparation (`agentBinding` driver/Profile identity and explicit launch overrides) is guarded against first realization using the existing turn lease. Bound preparation cannot change; aliases, ordinary display data, and internal ask/operate mode are not execution identity. Draft guards already inside the non-reentrant Canvas mutex acquire a turn lease nonblockingly and retain it through persistence; they never wait for a running invocation while holding the Canvas lock. Canonical promotion uses an already-locked projection entry and reloads the resulting version before composing the remaining edit. Unchanged preparation echoed by a layout save can pass while an admitted prompt owns confirmation; an actual preparation change still conflicts. No Canvas lock spans model execution.

Creation initializes Editing and fresh invocation state; attaching a realized chat or reinserting an undone Question confirms that owner's canonical thread. Ordinary edits cannot replace an existing association. Plain copies receive a new thread without Bound/token/result metadata; conversation forks confirm the fork's own record before creation. Cross-Space Move preserves the original thread and execution metadata via an internal validated move input, uses nonblocking turn acquisition with sorted Canvas locks, and retains its existing compensation boundaries.

Question creation and undo reinsertion remain optimistic, but preprocessing and ordinary structure saves await their acknowledgement. Failed creation, fork, or restoration removes the optimistic Question and its incident edges from live state and history while preserving the explicit rejection; unrelated edits can still save. Unsupported conversation forks never fall back to a fresh thread. Undo or deletion removes the local node immediately and orders the tracked server DELETE after pending creation settles; late creation HTTP/SSE inserts cannot resurrect the locally removed node. Structure saves await tracked deletions too: DELETE removes the sidecar, while the subsequent Canvas PUT must remove the topology after any delayed creation.

### Command Catalog

See `packages/shared/src/types/canvas/command.ts` for the full discriminated union. Summary:

| Category         | Commands                                                |
| ---------------- | ------------------------------------------------------- |
| Node lifecycle   | `CREATE_NODES`, `DELETE_NODES`                          |
| Node editing     | `MERGE_NODE_DATA`, `CHANGE_NODE_TYPE`                   |
| Structure        | `SET_NODE_PARENT`, `DISSOLVE_FRAME`, `SET_FRAME_LAYOUT` |
| Geometry         | `SET_NODE_GEOMETRY`                                     |
| Selection / view | `SET_NODE_SELECTION`                                    |
| Ordering         | `REORDER_NODES`                                         |
| Locking          | `SET_NODE_LOCKED`                                       |
| Edge graph       | `CONNECT_NODES`, `DISCONNECT_EDGES`, `SET_EDGE_STYLE`   |
| Algorithms       | `ALIGN_NODES`, `DISTRIBUTE_NODES`                       |

Geometry commands preserve each node type's sizing model. `text` and
`question` nodes are always content-height nodes: `CREATE_NODES`,
`SET_NODE_GEOMETRY`, and `CHANGE_NODE_TYPE` preserve/write their top-level
`style.width` but do not persist top-level `style.height`. Use
`data.style.fontSize` to change their rendered scale. `note` nodes are
different: they may either clear top-level `style.height` for auto height or pin
it for fixed-height notes.

Agent creation adds a prompt-level sizing policy without changing executor semantics. Before emitting an explicit `CREATE_NODES.size`, an Agent inspects comparable nearby nodes and matches their representative dimensions; when no comparable peer exists it omits `size` so the engine applies the canonical type default. Long or multi-section Notes use a fixed height matching nearby Notes, or 400px when none exist; `height: "auto"` is reserved for short Notes whose complete inline expansion is intentional. The canonical procedure lives in [`layout-recipes.md`](../../apps/server/src/prompt/skills/space/references/layout-recipes.md); the executor still accepts any schema-valid size from non-Agent callers.

### IDs

Node ids use `node-<uuid>`, edge ids use `edge-<uuid>`.

- **Web / UI callers** mint ids up front and build the whole batch client-side, so a later command in the same batch can reference an earlier `CREATE_NODES` entry by its explicit id (each command sees prior commands' state — see Execution Semantics).
- **The agent path is different.** The canonical agent schema rejects caller-assigned ids on `CREATE_NODES` and `CONNECT_NODES`; `preAssignIds()` in `canvas-executor.ts` assigns unique ids before execution. Results echo each created node in `results[].nodes` and each created edge in `results[].edges`. To connect or reparent freshly created nodes, the agent reads those ids and issues a follow-up call instead of self-referencing invented ids in one batch.

## Layer 3: CanvasExecution

`CanvasExecution` is the runtime batch/transaction layer. It defines:

1. Which commands validate and execute together
2. Which work collapses into a single undo step
3. Which action trace entries belong to the same action
4. Which side effects run after commit

### Why a Separate Layer

`CanvasUiIntent` is too early for undo/trace (web-only). `CanvasCommand` is too small (one logical action often spans multiple commands — e.g., group-into-frame = create frame + parent nodes + select frame).

### Execution Semantics

1. Process commands sequentially; each command sees state from prior commands.
2. Validate each command. Commands that fail return `applied: false`.
3. If no command changes state, commit nothing.
4. If any command changes state, take one undo snapshot and commit once.
5. Run post-commit effects.

### Execution implementation

The engine is shared, in `packages/shared/src/canvas-engine/`:

- `executor.ts` — `executeCanvasCommands(execution, state) -> ExecutorOutput`
- `commands/` — one handler per command type (17) + `index.ts` (`HANDLERS` registry + `COMMAND_META`) + `types.ts`
- `postEffects.ts` — pure post-commit effects (edge reroute)
- `interfaces.ts` — `CanvasReadState`, `CanvasWriteResult`; `delta.ts` / `diff.ts` — self-inverting delta types

Web-only pieces stay in `apps/web/src/handler/canvasCommand/`: `uiIntent.ts`, `resolvers/`, `preprocess.ts`, `postEffects.web.ts` (transition cleanup, deferred frame-fit, history snapshot, preprocessing trigger).

### Store Integration

`canvasStore.ts` exposes two internal methods:

- `dispatchUiIntent(intent)` — resolves `CanvasUiIntent` → commands → `executeCommands()` and mirrors the resulting `RecentAction` trace into `canvasEvents` for the server-bound action log.
- `executeCommands(commands)` — wraps in `CanvasExecution { source: 'ui' }`, runs executor, manages undo snapshots, commits to Zustand, runs post-effects.

## Examples

### Move Node Into Frame

Web: user drags node over frame → `NODE_DRAG_STOP` intent → resolver identifies `nodeId` + `frameId` → emits `SET_NODE_PARENT`. The shared handler delegates to the generic Container reparent primitive; Frame overlap detection remains UI policy.

Agent: emits `SET_NODE_PARENT` directly.

### Group Selection Into Frame

Web only: user clicks "Group" → `GROUP_SELECTION_INTO_FRAME` intent → resolver reads selection, computes bounds → emits `CREATE_NODES` + `SET_NODE_PARENT` + `SET_NODE_SELECTION` batch.

No shared `GROUP_SELECTION_INTO_FRAME` command exists because selection lookup is web-only.

---

## Agent-Side Implementation

Agent and web now converge on the same `CanvasCommand` pipeline. The server never applies canvas mutations directly.

### Agent Command Schema

The agent exposes a single `space_commands` tool (`apps/server/src/modules/agent/tools/definitions.ts`). Its parameter schema is generated from the canonical Zod contracts in `packages/shared/src/types/api/space-operations.ts` and covers the 13 Agent-allowed commands (excluding `SET_NODE_LOCKED`, `SET_NODE_SELECTION`, `CHANGE_NODE_TYPE`, and internal `APPLY_MEASURED_HEIGHT`).

Built-in tool calls and direct RFS execution both pass their validated wire commands through `prepareAgentCanvasCommands()`. This thin preparation step adds server-owned `origin` and `labelSource` metadata and, for built-in turns, injects content revisions from the turn read-set; it does not implement command behavior.

### Server Executor

`apps/server/src/modules/agent/tools/handlers/canvas-write.ts` handles `space_commands`: it calls the shared preparation helper and then `executeOnServer()` ([canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)) — the **command batch executes on the server** through the shared engine, persists `space.json` + node `.md` sidecars, appends one `delta-log.jsonl` row, and returns structural deltas plus per-command results. The LLM gets real success/error feedback.

Before the shared engine applies an agent batch, `importForeignNodeSources` normalizes `src` on both `CREATE_NODES` and `MERGE_NODE_DATA`. Media-node remote URLs and canvas-local files are imported into `.artifacts/`; for `web`, only canvas-local `.html` files are imported (uploads staged under `.upload/` are reclaimed), while live `http(s)://` and self-contained `data:` URLs remain verbatim. A local Web source with another extension is left unchanged and its staged file is not reclaimed.

Same engine runs both sides; the only authority is the server. `POST /api/canvas/:canvasId/execute` is the shared entry, guarded by a per-canvas mutex (headless executor, M2).

Cross-Space Move is the bounded exception that coordinates two otherwise independent executor batches. `SpaceMoveService` acquires both Canvas mutexes in lexical order, uses `executeOnServerAlreadyLocked()` for destination creation and the source batch, and withholds both sync publications until the complete move succeeds. The source batch always deletes the moved roots and optionally creates one `spacePreview` breadcrumb pointing to the destination; when requested, its absolute position and clamped dimensions derive from the authoritative moved-set bounds. Determinate failure applies any source and destination inverse deltas through `applyDeltasOnServerAlreadyLocked()` while the same locks remain held. The service still expresses topology changes only as ordinary `CREATE_NODES`, `CONNECT_NODES`, and `DELETE_NODES` commands; the coordinator owns selection expansion, optional destination lifecycle, artifact transfer, Agent rehome, ordering, and compensation.

Move compensation rehomes completed conversations back before restoring source nodes, because Bound Agent reinsertion requires its canonical source record. Its trusted `agentNodeMoveState` input preserves the saved execution metadata on reinserted Question nodes after canonical binding validation; ordinary undo keeps its editable projection and ownership guards. Destination inverse deltas run last, including when a destination batch partially accepts commands before rejecting. Compensation does not reopen runtime handles. If a rehome outcome is unknown, no topology compensation or destination cleanup is attempted on that ambiguous state.

World `spacePreview` nodes add a host-level ownership policy before shared-engine execution. Only system reconciliation may create them; UI and Agent batches cannot repoint them, change their type, or delete a preview whose target is still a live Space, including by deleting an ancestor Frame. Missing-target previews remain removable. Position, size, and ordinary Frame parenting still use shared geometry and `SET_NODE_PARENT` semantics. Full-state writes and post-execution topology checks enforce managed identity as well, so sequential reparent-then-delete commands cannot bypass the policy.

Built-in tools, RFS execution, and the Canvas execute route call `executeOnServer()` for the addressed Canvas; there is no implicit source-to-World mutation routing. Every command discriminator is preflighted before batch I/O using an own-property lookup in the shared engine's full `COMMAND_META` registry, not the Agent-only command list. Payload semantics remain with the handlers: invalid payloads may be rejected or no-op without a special retirement exception. Command results, delta replay (including revert), and full-state PUT check explicitly supplied node `type` and optional `data.type` against `CANVAS_NODE_TYPES` before persistence; omitted discriminators remain accepted under the existing loose full-state contract. Agent source normalization also checks all create-node discriminators before any media import, so an unsupported create cannot leave imported artifacts behind.

Portal/Pin commands, schemas, handlers, placement and content-hug passes are removed; writes need no explicit legacy blacklist. The non-migrating read/load, clipboard, and history filter ignores only the three retired node types and preserves unrelated unknown types, unlike the canonical write validation. It performs no local cleanup or migration; see [canvas-storage.md](./canvas-storage.md#retired-portalpin-topology-on-load).

Two properties make the agent loop self-correcting:

- **Per-command outcomes are visible.** Each command reports `applied` and, on failure, a typed `reason` in `results[]` (e.g. `CONNECT_NODES` → `invalid-target` when an endpoint is missing, `SET_NODE_PARENT` → `invalid-target` / `invalid-parent`). Commands are validated independently — the version bumps only if at least one command changed state; an all-rejected batch is a no-op (`toVersion === fromVersion`).
- **Created ids come back.** `results[].nodes` echoes the server-assigned id (and label) of every node a `CREATE_NODES` command created, so the next turn can wire them up with real ids instead of invented ones.

### Web-Side Apply

The web client receives the server's deltas (via tool-result + SSE broadcast) and applies them with `applyDeltas` — no local re-execution. Version-gated (`localVersion >= toVersion` skips). UI gestures still run the engine locally for optimistic feedback then POST to `/execute`; agent-originated batches are pure apply.

### IntentAction Convergence

The parallel `IntentAction` union is gone: `RecentAction` ([context.ts](../../packages/shared/src/types/agent/context.ts)) is the single shape for "what the user just did", and the whole intent-recognition module was later removed.

## Code entry points

| File                                                                                                                                                     | Responsibility                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`apps/web/src/handler/canvasCommand/uiIntent.ts`](../../apps/web/src/handler/canvasCommand/uiIntent.ts)                                                 | Web-only intent and resolution contracts, including transient UI effects.             |
| [`apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts`](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)               | Materialize user-created nodes and choose an unambiguous post-create edit target.     |
| [`apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                                                           | Execute resolved commands and map post-create editing to expanded or inline UI state. |
| [`apps/web/src/components/Nodes/note/NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)                                         | Focus the editable note surface when expanded-view focus is requested.                |
| [`apps/web/src/components/Nodes/text/TextNode.tsx`](../../apps/web/src/components/Nodes/text/TextNode.tsx)                                               | Consume inline-edit requests and focus the text textarea.                             |
| [`packages/shared/src/canvas-engine/executor.ts`](../../packages/shared/src/canvas-engine/executor.ts)                                                   | Execute host-agnostic canvas commands without web UI state.                           |
| [`packages/shared/src/canvas-engine/utils/edge.ts`](../../packages/shared/src/canvas-engine/utils/edge.ts)                                               | Select edge ports with layout preferences, bounded obstacle fallback, and hysteresis. |
| [`packages/shared/src/canvas-engine/utils/orthogonalRouting.ts`](../../packages/shared/src/canvas-engine/utils/orthogonalRouting.ts)                     | Plan bounded obstacle-aware paths with rounded corners and channel costs.             |
| [`apps/web/src/components/Panels/Canvas/edges/AutoEdgeRoutingContext.tsx`](../../apps/web/src/components/Panels/Canvas/edges/AutoEdgeRoutingContext.tsx) | Share the visible scene's transient auto routes across rendered edges.                |
| [`packages/shared/src/canvas-engine/utils/edgeRoutingGroups.ts`](../../packages/shared/src/canvas-engine/utils/edgeRoutingGroups.ts)                     | Infer local row/column fan-out and fan-in from connected node geometry.               |
| [`packages/shared/src/canvas-engine/utils/edgePath.ts`](../../packages/shared/src/canvas-engine/utils/edgePath.ts)                                       | Share rendered path geometry and legacy line-type resolution with route evaluation.   |
| [`packages/shared/src/canvas-engine/autoLayout/gridLayout.ts`](../../packages/shared/src/canvas-engine/autoLayout/gridLayout.ts)                         | Solve structured tracks, edge-aware gutters, and resize-time frozen spacing.          |
| [`apps/web/src/store/canvasStore/slices/resizePreview.ts`](../../apps/web/src/store/canvasStore/slices/resizePreview.ts)                                 | Capture child baselines and dispatch content-scaled Frame resize previews.            |
| [`packages/shared/src/canvas-engine/frame/resize.ts`](../../packages/shared/src/canvas-engine/frame/resize.ts)                                           | Invert structured layout with fixed whitespace for Frame resize.                      |
| [`apps/web/src/store/canvasStore/slices/structuredReflow.ts`](../../apps/web/src/store/canvasStore/slices/structuredReflow.ts)                           | Apply and reverse the live structured drop reflow preview.                            |
| [agent-node-edit.ts](../../apps/server/src/modules/canvas/agent-node-edit.ts)                                                                            | Validate and coordinate Question preparation edits and creation confirmation          |
| [agent-node-projection.ts](../../apps/server/src/modules/canvas/agent-node-projection.ts)                                                                | Trusted token-guarded FSM projection under the Canvas mutex                           |
| [agentNodeOwnership.ts](../../packages/shared/src/canvas-engine/agentNodeOwnership.ts)                                                                   | Shared bounded editable projection and inverse-effect replay                          |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                                           | Execute commands against the addressed Canvas and validate resulting topology.        |
| [`apps/server/src/modules/canvas/world-preview-policy.ts`](../../apps/server/src/modules/canvas/world-preview-policy.ts)                                 | Protect managed preview identity and validate canonical command and node types.       |
| [`apps/server/src/modules/canvas/world-previews.ts`](../../apps/server/src/modules/canvas/world-previews.ts)                                             | Reconcile canonical previews through ordinary system command batches.                 |
