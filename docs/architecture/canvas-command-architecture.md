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

## Layer 1: CanvasUiIntent

`CanvasUiIntent` is a web-only input model for user gestures. It resolves UI-specific ambiguity (selection, clipboard, drag context, viewport position, rectangle hit-testing) into explicit `CanvasCommand` operands.

`CanvasUiIntent` must not be shared with the agent because it depends on ephemeral frontend state.

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

`UiIntentResolution.editNodeId` is a transient web-only request applied after the resolved commands commit successfully. `ADD_NODES` sets it when one `note` or `text` node is created: a note opens in the expanded view and focuses its editor, while a text node enters inline editing and focuses its textarea. Batch creation leaves it unset because there is no unambiguous editor target.

The request never enters `CanvasCommand`, persisted node data, or deltas. Agent execution, SSE application, delta replay, and rejected create commands therefore cannot open a view or steal focus.

Composite intent examples:

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
- `SET_NODE_PARENT` rejects invalid targets, non-Container parents, or cycles.
- `CONNECT_NODES` rejects the command (`applied: false`, `reason: 'invalid-target'`) when any edge endpoint is not a live node — it never silently drops the edge.
- `ALIGN_NODES` aligns provided nodes without relying on selection.

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

Both of a `grid`'s axes can be **grown** by a drop, not just permuted. The row picker classifies a frame-local Y the same way the column picker classifies X: inside a band it reads as that row, but the widened band between two rows (and the space past the first or last one) reads as "open a row here", which pushes that row and every later one down. Without it an internal drag could only ever resolve to one of the neighbouring rows, so aiming between two rows swapped a pair of children instead of making room — a grid could be rearranged but never gain a row by hand. Opening a row is offered under the same conditions as opening a column — a single-node drag names one gap; several dragged children share one cursor and name none — and the two never happen in the same gesture: a drop that opens a column lands in a column that is empty by construction, so there is nobody below to push down and a row break would only add a blank stripe.

All three modes classify a drop through **one picker over solver-derived tracks**, so what a mode does with a drop differs but how it reads one does not. The picker takes a solved layout, projects the requested axis into bands, and answers with the same three rules everywhere: outside the content at either end means "make room at that end", the widened band around a gutter means "make room between these two", and anything else means the nearest band. Two long-standing masonry quirks fall out of that. Bands now come from the solver rather than from a mirror of it, so gutters widened for edge labels move the insert band with them instead of leaving it aimed at a gap that has moved. And "past the end" is measured from the last track rather than from the Frame's own padding, so the slack of a manually enlarged Frame offers a new track instead of quietly resolving to the last one. The masonry preview also applies the same maximum-track-count demotion the commit path always did, so a Frame already at the cap no longer shows a dashed `+` plate for a track it cannot open. The one deliberate difference left is how an empty band is classified while it exists: the masonry solvers compact empty tracks away before the picker runs, while a `grid` blank row remains an addressable drop target rather than being interpreted as a request to insert another row. That addressability does not give the blank row a persistent identity across later structural edits.

Cell membership is solver output only once it exists. A child that has never been placed carries no cell, which is the state every Frame is in the moment it leaves `free` — and there the child's rendered position is the only record of what the user arranged. Entering a structured mode therefore seeds the missing indices from geometry: children are bucketed into visual bands along the mode's axis (X for `column`, Y for `row`, both for `grid`) and each band becomes a track. `grid` bands its rows **globally across columns**, so children that read as side by side keep a shared row; banding per column would hand each column's first child row 0 and destroy the correspondence the mode exists to express. Seeding runs only when the Frame has no persisted assignment at all — a Frame being topped up with one newcomer has no band structure to read, so that case still falls back to the least-full track. Once seeded, indices are persistent, so later drags move one child rather than re-deriving every membership from rendered geometry.

The track count follows the same rule, because it is a property of the arrangement rather than a setting that outlives it. A layout-mode change drops both the stored `gridCount` and the children's cells, so the solver re-derives the count from the bands it just read and writes the resolved value back. Inheriting the count across a switch re-flows the Frame against a number chosen for a different axis, and the previous default of `1` flattened every arrangement into a single track — a hand-made 3x2 collapsed into one column whichever mode was picked. Switching modes is now arrangement-preserving in every direction, including back to `free`.

Naming a count explicitly is the opposite instruction: re-flow into that many tracks. `column` and `row` satisfy it through the existing `fill` policy. `grid` cannot, because its rows are persistent and two-dimensional: three children that shared a row cannot stay level in two columns, so keeping the bands only collides them and bumps the losers down into a ragged `AB | CD | E | F`. An explicit column count for `grid` therefore plans fresh cells outright in reading order (`planGridReflow`), which is what "make it N columns" means and what keeps the result an actual grid. An explicit `cells` payload still outranks the planned re-flow — the re-flow is for a caller that names a count _without_ knowing where anything should go, which is the Frame toolbar and not a drop. A drop that compacts or opens a track therefore restates every cell on the same command: the count change re-interprets all of them, and letting the re-flow deal the ones the drop did not restate put two children in one cell and committed a layout the drag never showed.

`grid` also accepts a row count (`gridRowCount`), but the two axes cannot be pinned symmetrically: six children in three columns need two rows, and asking for one cannot make them fit. The row count is therefore a **floor**, not an exact count — it adds blank bands that remain valid drop targets and never removes the rows the content requires. These bands satisfy the requested minimum but have no stable individual identity; structural compaction may move the occupied rows, after which the solver materializes enough trailing bands to satisfy the floor again. The count is cleared on a layout-mode change for the same reason the column count is, and it outlives an explicit column re-flow because it is a frame-level policy rather than a cell assignment. The Frame toolbar reflects this asymmetry by re-syncing its row input from the resolved total rather than from what was typed, so a request that could not be honoured is visible immediately.

`grid` accepts sparse row indices because commands and imported documents may address cells beyond the currently occupied rows, and the solver must render every intervening band. Sparse input is bounded rather than treated as durable structure: when a structural drop empties a row, the planner renumbers all occupied rows contiguously. The ceiling allows at most one intervening blank row per child and prevents an index far past the child count from turning a single command into an unbounded allocation; it is enforced in the solver rather than at the wire boundary because it depends on the Frame's child count.

### Live structured drop preview

`describeStructuredDropZone` returns, alongside the drop footprint, a `reflow` list: where every **existing** child of the hovered Frame lands in the simulated post-drop layout. The web store publishes those positions each drag tick, so the Frame's contents visibly open a gap under the cursor instead of the drop being narrated by overlay rects. The dragged node is excluded — React Flow owns its position until release, and projecting a solved position for it would fight the cursor.

What a drop _means_ is resolved by `planStructuredDrop`: which track the dragged children take, who they displace, and what becomes of the cell they vacate. Preview and commit both call it against the same pre-drag geometry, so the release cannot land somewhere the drag did not show. The rule previously existed twice — once in the preview helper, once in the drag resolver — and the copies had drifted: only the resolver compacted a row that a move emptied, so releasing the last child of a row made the layout jump. They also decided cell occupancy against different column values (pre- vs post-shift), which agreed only because opening a track and swapping a cell cannot happen in one gesture.

The drop target is resolved before the frame-fit preview pass rather than after it, so that pass can skip the frame the drop zone is about to solve anyway; the skipped frame's size is reported from the zone, and only recomputed if the zone fails to resolve. Solving it in both places was the same work twice, with the fit pass's answer discarded.

The preview never touches `canvasStore.nodes`. The complete future geometry is published once through `gesturePreviewStore.nodeGeometryPreviews` and folded into the node array at the render boundary only (`Canvas.tsx`'s `displayNodes`), so React Flow moves and resizes affected Frames and peers — and reroutes their edges — while the authoritative geometry stays exactly as the user left it. Selection HUD geometry builds the same transient tree before resolving nested absolute coordinates. A dragged node that is previewed leaving a Frame keeps its current `parentId` until release so React Flow retains drag ownership, but receives a compensated parent-local preview position derived from the projected detached world position and the projected source-Frame origin; its body, HUD, and eventual detach therefore share one absolute position even when a Hug source Frame moves while shrinking. Writing projections onto the real nodes, even through `_setStateNoAutosave`, made a per-tick future state indistinguishable from committed geometry to everything that reads the store: an agent write or history snapshot landing mid-drag would capture geometry the user never committed, and every picker had to strip the preview back off before it could reason about the drag at all.

Two properties follow from keeping it out of the store, rather than being maintained by hand:

1. **Ticks cannot compound.** The pickers and the solver always see the real pre-drag geometry, so a reflowed peer can never move the track bounds that decided where it went — the oscillation that a strip-then-apply controller had to prevent explicitly is not expressible here.
2. **What the user saw is what commits.** `onNodeDragStop` withdraws the preview and the resolver classifies the release against the same untouched geometry the preview was derived from. Nothing has to be restored before dispatch, and drag cancellation (Esc) and canvas teardown clear the same transient geometry field.
3. **One membership predicate.** A structured Frame claims a capture zone far larger than a free one's halo — its rect grown by the dragged node's own size — because appending or prepending a track means aiming at the outer padding, which drags the node's body (and the cursor with it) past the Frame edge with zero overlap left. `wouldStickToStructuredFrame` is that rule, and every stage asks it before asking `wouldUnframe`: the tick that draws the indicator, the tick that caches the membership decision, and the resolver's fresh-recomputation fallback. The drag tick's decision is replayed verbatim at drop time, so a stage that skips the predicate does not merely disagree in the abstract — it unframes the node in exactly the band where the overlay is offering a new track.

The Frame itself is not resized during the preview; its projected size continues to be shown by the existing dashed frame-fit outline. Besides the footprint and the `reflow` list, the zone description carries only the simulated layout's track geometry (`context.tracks` / `context.activeTrack`, plus `context.rows` / `context.activeRow` for `grid`), sourced from the solver's `columnTracks` / `rowTracks` output so the overlay never re-derives layout. The earlier context rects — the active track rect, the Grid row band, the track / alignment peer rects, and the `swap` destination — have been deleted rather than left unrendered: the reflow shows all of it by moving the actual nodes, and keeping them meant a second full solver pass per drag tick to compute geometry nothing drew.

`CONNECT_NODES`, `DISCONNECT_EDGES`, and `SET_EDGE_STYLE` report **structured** Frames joined by their affected internal edges through `affectedFrameIds`, so the executor recomputes gutters in the same batch and reroutes handles after any resulting node movement. `free` Frames are deliberately not reported: they have no gutters, so naming one would only send it through the end-of-batch fit pass and turn an edge restyle into a frame resize that saves, broadcasts, and shares the restyle's undo step. Deferred web relayouts also pass current edges into the shared solver, preventing a render-time measurement update from reverting edge-aware spacing.

Frame resize previews capture the current gutter plan at gesture start. Each animation-frame tick scales those frozen X/Y sizes with the child geometry and does not recompute label measurements or lane assignments; the authoritative resize-end command omits the override and recomputes the plan from the final graph. A multi-selection treats every selected Frame as a scaling root and transforms its complete descendant subtree in the same coordinate space, so the Frame continues to contain nested Frames and ordinary children; a nested selected Frame is handled by its outermost selected ancestor to avoid double scaling. Multi-selection movement uses preview geometry and performs one authoritative geometry commit on completion; text fitting and height-commit suspension follow the single-node resize lifecycle. The override is executor-local transient state and is never persisted in a command or canvas document.

### Command Catalog

See `packages/shared/src/types/canvas/command.ts` for the full discriminated union. Summary:

| Category         | Commands                                                |
| ---------------- | ------------------------------------------------------- |
| Node lifecycle   | `CREATE_NODES`, `DELETE_NODES`                          |
| Node editing     | `MERGE_NODE_DATA`, `CHANGE_NODE_TYPE`                   |
| Structure        | `SET_NODE_PARENT`, `DISSOLVE_FRAME`, `SET_FRAME_LAYOUT` |
| World projection | `SET_PORTAL_NODE_PINS`                                  |
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
- `commands/` — one handler per command type (18) + `index.ts` (`HANDLERS` registry + `COMMAND_META`) + `types.ts`
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

The agent exposes a single `space_commands` tool (`apps/server/src/modules/agent/tools/definitions.ts`). Its parameter schema is generated from the canonical Zod contracts in `packages/shared/src/types/api/space-operations.ts` and covers the agent-allowed command subset (excluding `SET_NODE_LOCKED`, `SET_NODE_SELECTION`, and `CHANGE_NODE_TYPE`).

Built-in tool calls and direct RFS execution both pass their validated wire commands through `prepareAgentCanvasCommands()`. This thin preparation step adds server-owned `origin` and `labelSource` metadata and, for built-in turns, injects content revisions from the turn read-set; it does not implement command behavior.

### Server Executor

`apps/server/src/modules/agent/tools/handlers/canvas-write.ts` handles `space_commands`: it calls the shared preparation helper and then `executeOnServer()` ([canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)) — the **command batch executes on the server** through the shared engine, persists `space.json` + node `.md` sidecars, appends one `delta-log.jsonl` row, and returns structural deltas plus per-command results. The LLM gets real success/error feedback.

Before the shared engine applies an agent batch, `importForeignNodeSources` normalizes `src` on both `CREATE_NODES` and `MERGE_NODE_DATA`. Media-node remote URLs and canvas-local files are imported into `.artifacts/`; for `web`, only canvas-local `.html` files are imported (uploads staged under `.upload/` are reclaimed), while live `http(s)://` and self-contained `data:` URLs remain verbatim. A local Web source with another extension is left unchanged and its staged file is not reclaimed.

Same engine runs both sides; the only authority is the server. `POST /api/canvas/:canvasId/execute` is the shared entry, guarded by a per-canvas mutex (headless executor, M2).

World `canvasRef` Portals add a host-level ownership policy before shared-engine execution. Only system reconciliation may create them; UI and agent batches cannot repoint them, manually resize them, or delete a Portal whose target is still a live Space. A broken Portal remains removable. Movement and ordinary Container parenting still use the same shared geometry and `SET_NODE_PARENT` semantics as other Canvas nodes.

`SET_PORTAL_NODE_PINS` is the only creation/removal path for persistent `frameRef` and `nodeRef` nodes. The server host router serializes World Pin preparation with execution, resolves the World and matching existing canonical Portals, validates pin sources while allowing broken-reference unpin, expands a newly pinned source Frame's current recursive subtree into one prepared World hierarchy, injects deterministic parent/placement hints, and rejects a batch that mixes source-local commands with World mutation. When a pinned source Space has no canonical Portal yet, the router runs the same idempotent World reconciliation before preparation instead of failing on a state the user cannot see; the precondition error survives only for a source Canvas that reconciliation does not recognize as a live Space. The shared handler deduplicates exact desired states, rejects contradictions, enforces one reference per source target inside a Portal subtree, adopts existing descendant references while preserving absolute World positions, and recursively deletes the current World subtree when a `frameRef` is unpinned. Portal and `frameRef` content-hug run after membership or child geometry changes. References retain ordinary World-owned node behavior such as locking and visual style; the topology guard rejects copied source content rather than generic Canvas metadata. Recursive Frame Pin is an explicit snapshot: re-pinning an existing `frameRef` is idempotent and never reconciles later source mutations.

Two properties make the agent loop self-correcting:

- **Per-command outcomes are visible.** Each command reports `applied` and, on failure, a typed `reason` in `results[]` (e.g. `CONNECT_NODES` → `invalid-target` when an endpoint is missing, `SET_NODE_PARENT` → `invalid-target` / `invalid-parent`). Commands are validated independently — the version bumps only if at least one command changed state; an all-rejected batch is a no-op (`toVersion === fromVersion`).
- **Created ids come back.** `results[].nodes` echoes the server-assigned id (and label) of every node a `CREATE_NODES` command created, so the next turn can wire them up with real ids instead of invented ones.

### Web-Side Apply

The web client receives the server's deltas (via tool-result + SSE broadcast) and applies them with `applyDeltas` — no local re-execution. Version-gated (`localVersion >= toVersion` skips). UI gestures still run the engine locally for optimistic feedback then POST to `/execute`; agent-originated batches are pure apply.

### IntentAction Convergence

The parallel `IntentAction` union is gone: `RecentAction` ([context.ts](../../packages/shared/src/types/agent/context.ts)) is the single shape for "what the user just did", and the whole intent-recognition module was later removed.

## Code entry points

| File                                                                                                                                       | Responsibility                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [`apps/web/src/handler/canvasCommand/uiIntent.ts`](../../apps/web/src/handler/canvasCommand/uiIntent.ts)                                   | Web-only intent and resolution contracts, including transient UI effects.             |
| [`apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts`](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts) | Materialize user-created nodes and choose an unambiguous post-create edit target.     |
| [`apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                                             | Execute resolved commands and map post-create editing to expanded or inline UI state. |
| [`apps/web/src/components/Nodes/note/NotePreview.tsx`](../../apps/web/src/components/Nodes/note/NotePreview.tsx)                           | Focus the editable note surface when expanded-view focus is requested.                |
| [`apps/web/src/components/Nodes/text/TextNode.tsx`](../../apps/web/src/components/Nodes/text/TextNode.tsx)                                 | Consume inline-edit requests and focus the text textarea.                             |
| [`packages/shared/src/canvas-engine/executor.ts`](../../packages/shared/src/canvas-engine/executor.ts)                                     | Execute host-agnostic canvas commands without web UI state.                           |
| [`packages/shared/src/canvas-engine/autoLayout/gridLayout.ts`](../../packages/shared/src/canvas-engine/autoLayout/gridLayout.ts)           | Solve structured tracks, edge-aware gutters, and resize-time frozen spacing.          |
| [`apps/web/src/store/canvasStore/slices/resizePreview.ts`](../../apps/web/src/store/canvasStore/slices/resizePreview.ts)                   | Capture and scale frozen structured gutter plans during Frame resize.                 |
| [`apps/web/src/store/canvasStore/slices/structuredReflow.ts`](../../apps/web/src/store/canvasStore/slices/structuredReflow.ts)             | Apply and reverse the live structured drop reflow preview.                            |
| [`packages/shared/src/canvas-engine/commands/setPortalNodePins.ts`](../../packages/shared/src/canvas-engine/commands/setPortalNodePins.ts) | Apply idempotent World-local Portal pin state.                                        |
| [`apps/server/src/modules/canvas/canvas-command-router.ts`](../../apps/server/src/modules/canvas/canvas-command-router.ts)                 | Route public Portal Pin commands to the workspace World.                              |
