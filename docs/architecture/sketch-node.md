# Sketch Node

> Sketch node (`type: 'sketch'`): freehand strokes as a persistent canvas node.
> A sketch shares the same lifecycle as every other node (create, move, delete,
> nest in a frame, recolor, relabel) and does NOT disappear after being read by
> AI.

A sketch has two **independent** relationships with AI, described separately:

- **Path A — as a content node** (§4): like an image, it carries visual
  information; agents render it to a PNG via `snapshot_node` to "see" it and fold
  it into their understanding of the Space. No explicit trigger needed.
- **Path B — as an executable gesture** (§5): the user explicitly fires
  `✨ Apply Sketch` from a toolbar; the strokes are parsed into `CanvasCommand[]`
  and applied with a preview.

§1–§3 are the shared basics (goals, data model, lifecycle); §6 is the code index.

---

## 1. Goals

| Goal             | Why                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------- |
| Ordinary node    | Lifecycle owned by the user; AI reading never auto-deletes the node                 |
| Content-bearing  | Strokes carry visual info; agents snapshot to PNG and use it as context             |
| Explicit trigger | Stroke→command recognition is user-initiated (toolbar); abortable, retryable        |
| Structured input | LLM does no OCR / geometry; the frontend pre-extracts node IDs + neighbours         |
| Canvas-bound     | Output is executable `CanvasCommand[]` (real node IDs + coords), no string guessing |

---

## 2. Data model & persistence

| Node type                                | inline in space.json                                                        | `nodes/<safeLabel>.md` | Notes                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sketch`                                 | **stroke geometry** (`points` / `initialSize` / `strokeColor` / `executed`) | ✅ frontmatter-only    | geometry inline in `state.nodes[i].data`; sidecar only persists `label` / `labelSource` (structure PUT strips them) |
| `question` / `image` / `video` / `frame` | metadata                                                                    | ✅ frontmatter-only    | same as sketch, sidecar only                                                                                        |
| `note` / `text` / `web` / `pdf`          | metadata                                                                    | ✅                     | text types also carry a markdown body                                                                               |

`MD_BACKED_NODE_TYPES` whitelist: [canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts). Footprint: ~0.5–3 KB per stroke, negligible for `space.json`.

Types:

- node: [`SketchNodeData`](../../packages/shared/src/types/canvas/node.ts)
- strokes / clusters: [`SketchStroke` / `SketchCluster`](../../packages/shared/src/types/agent/intent.ts)

---

## 3. Node lifecycle

Drawing lands a normal node; nothing fires automatically:

```
SketchOverlay.handlePointerUp
   │
   ▼
addNode({type: 'sketch', ...})
   │
   ▼
intentStore.onSketchCreated(id)        ← only updates pendingSketchIds, no timer
```

- **No idle timer**: a finished sketch is just a node, triggering nothing.
- **No dim / fade**: `executed: true` is kept but used only by the §5 state machine; rendering is unaffected.
- Move / delete / recolor / nest-in-frame / relabel all go through the normal node flow.

### 3.1 Draw does not auto-select

A freshly drawn sketch is created **unselected**: `SketchOverlay` passes `selectOnCreate: false` on `addNode`, which threads through `ADD_NODES` → `CREATE_NODES` so the engine's [createNodes.ts](../../packages/shared/src/canvas-engine/commands/createNodes.ts) skips it in the auto-selection set. Two independent guards suppress create-time selection — the type-invariant `question` exclusion and the per-creation `selectOnCreate === false` hint — do not collapse them. Rationale: a selection box mid-draw interrupts continuous freehand writing, and an unselected sketch keeps stroke-only hit-testing so it never shadows nodes beneath its transparent bbox.

### 3.2 Stroke merging is purely spatial ("regions")

On pointer-up a new stroke either starts a fresh sketch node or is appended onto the **nearest existing sketch region** within a screen-space proximity threshold ([findMergeTarget](../../apps/web/src/components/Nodes/sketch/sketchMerge.ts), threshold `SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX / zoom`; same parent frame only). Merging is **purely spatial — time plays no role in the boundary**: coming back to write next to an old region still merges into it, so a mid-writing think-pause can never split a line across nodes. It only ever targets one existing region per stroke; merging two existing regions ("bridging") is a later concern. Per-stroke `createdAt` is preserved as intra-region metadata but no longer influences the region boundary; a unified node-level "modified-after-a-gap" provenance is a separate cross-cutting concern (see [sketch-region-redesign proposal](../proposals/sketch-region-redesign.md)).

When a merge expands a sketch region bbox, geometry reads the synchronously authored `style` size before React Flow's asynchronous `measured` echo. Existing stroke coordinates are rebased against that same authoritative size, preventing fractional measurement differences from shifting the region's prior ink.

### 3.3 Draw and erase controls

Desktop and touch input share `toolStore.sketchDraft` and the same mode/parameter components, but expose the frequent mode switch at different levels:

| Input | Pen / eraser entry                                                                                                                      | Parameters                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Mouse | The Canvas Toolbar exposes one Sketch button; while active, `SketchSettingsPanel` exposes pen and eraser as compact contextual controls | Color and three editable stroke/eraser size presets appear in the panel |
| Touch | Pen and eraser remain visible in the Canvas Toolbar; tapping either activates Sketch in that mode                                       | The active mode's color and three editable size presets appear above it |

`SketchModeSwitcher` owns the shared `draw` / `erase` store updates. Draw exposes three fixed-position color slots through `SketchColorPresetPicker`, and draw/erase each expose three fixed-position size slots through `SketchPresetPicker`. Each trio is transparent by default; color and size use the same subtle grey slot-level selected surface without an accent ring. Selecting a different slot applies it immediately; selecting the active slot opens the full palette or size slider to edit that slot. Size slots render only a short rounded stroke preview whose height represents the stored value. The preset values, active indices, and current `sketchDraft` preferences persist under the `sediment-sketch-tools` localStorage key through Zustand `persist`; transient `pendingNodeType` does not persist.

During an eraser drag, each hit stroke is hidden immediately through `gesturePreviewStore` so the interaction has live visual feedback. The underlying node data is unchanged until pointer up, when all hits commit as one command batch and one undo gesture; cancelling or switching tools clears the preview and restores every uncommitted stroke.

A selected Sketch node deliberately does not use or mutate these drawing presets. Its toolbar keeps one color menu and one `SketchSizePicker` secondary menu that edit only that node's stored strokes, so post-draw edits cannot silently change future drawing preferences. `SketchControls` owns their shared open state: opening either menu closes the other, and both use the common floating-toolbar popover surface. The thickness slider fires per drag tick, so its drag is bracketed by `canvasStore.beginNodeDataGesture` / `endNodeDataGesture` (arm one pre-edit snapshot on pointer-down, release on pointer-up) — the burst of `MERGE_NODE_DATA` writes folds into a **single undo entry** instead of one per tick. A color pick is a single discrete write and needs no bracket.

### 3.4 Two-layer model: sketch node vs. stroke selection

A sketch participates in the canvas at **two distinct layers**, and keeping them apart is the key to reasoning about selection, movement, and the two AI paths:

- **Node layer (persistent, structural).** A sketch _is_ an ordinary ReactFlow node — it has an `id`, `position`, optional `parentId`, can be framed / reparented / recolored / relabeled / connected, is addressed by node id for snapshots and OCR, and flows through the same engine commands (`SET_NODE_GEOMETRY`, `SET_NODE_PARENT`, `DELETE_NODES`, …) and the same undo pipeline as every other node. **Nothing about a sketch is special here.** To move a whole sketch as an object, use the **Select** tool and drag the node.
- **Stroke layer (transient, interaction-only).** Individual strokes are **not** nodes: they are entries in the node's inline `data.strokes[]` with no graph id, z-index, edges, or framing of their own. A "stroke selection" exists **only under the Lasso tool** — a transient per-node subset (`gesturePreviewStore.sketchStrokeSelection`, never persisted or undone) that lets the user pick / delete / move / split _part_ of a sketch, which whole-node selection cannot express. Enabling partial operations is the **sole reason** this layer exists.

A sketch therefore has **two independent movement channels**: the whole node moves via the node-drag lifecycle, while a stroke subset moves via a preview translate + on-commit bake. §3.5 covers how the lasso routes into the stroke layer; when a _single_ gesture drives both channels at once (a mixed lasso), they must be reconciled — see the mixed-selection and carried-node notes there.

### 3.5 Stroke-level lasso selection & region editing

Under the **Lasso** tool, selection is split **by node type**: a sketch node contributes only the strokes the lasso actually captured (**stroke-level**), while every other node type is selected **whole** — and the two can coexist in one gesture (e.g. a note plus some sketch ink). A whole sketch enclosed by the lasso therefore yields its strokes, not a movable node; grab a whole sketch as an object with the **Select** tool instead. The stroke selection lives in `gesturePreviewStore.sketchStrokeSelection` (`nodeId -> strokeIds`, transient — never persisted or undone), is highlighted per stroke in [SketchNode.tsx](../../apps/web/src/components/Nodes/sketch/SketchNode.tsx), and is cleared when the tool changes away from Lasso or an authoritative canvas snapshot replaces the in-memory nodes. The single `gesturePreviewStore.resetCanvasScopedTransients` (fed by one `INITIAL_PREVIEW_DATA` source so it can never miss a field) clears **all** canvas-scoped transients — selection, retained polygon, move preview, carried ids, hover highlight, and the frame/snap/drop previews — on every authoritative geometry swap: canvas switch, authoritative reload, same-canvas SSE snapshot heal, and **undo / redo**. The undo/redo case matters because a retained selection is deliberately kept after a move: without the reset, moving strokes and then undoing would revert the strokes to their old position while the dashed region stayed at the moved position (a delta a generic undo cannot reverse, so the floating selection is dropped rather than re-homed). Because a sketch is never whole-node selected, it is also excluded from the in-progress lasso's whole-node preview highlight — dragging the lasso over a sketch never flashes a selection box around the whole node, only its captured strokes light up (on commit). Hit-testing (`findSketchStrokesInPolygon`) and the anchor bbox (`getSketchStrokeSelectionBounds`) live in [sketchHitTest.ts](../../apps/web/src/components/Nodes/sketch/sketchHitTest.ts); a stroke is captured when ≥ 1 of its points lands inside the polygon.

**Retained-region move (GoodNotes-style).** On lasso commit the captured flow-space polygon is retained in `gesturePreviewStore.sketchSelectionPolygon` and drawn as a dashed loop by [StrokeSelectionRegion.tsx](../../apps/web/src/components/Panels/Canvas/StrokeSelectionRegion.tsx) (a `ViewportPortal` overlay whose interior shows a `move` cursor). A `sketch-stroke-move` recognizer ordered **before** the lasso recognizer in [Canvas.tsx](../../apps/web/src/components/Panels/Canvas/Canvas.tsx) claims a pointerdown that lands **inside** that polygon; it enters the shared screen-space `canvasGestureSession` pending state and starts moving only after the pointer-specific mouse / pen / touch activation threshold locks. The drag translates the selected strokes live via `gesturePreviewStore.sketchStrokeMovePreview` (a flow delta applied to both the highlighted strokes and the region loop), and on release commits [buildMoveStrokesCommands](../../apps/web/src/components/Nodes/sketch/sketchMerge.ts) per node (bake to flow → offset moved strokes → reframe union bbox) ([useSketchStrokeMove.ts](../../apps/web/src/hooks/useSketchStrokeMove.ts)). Pointer cancellation restores every whole node to its pre-drag position, tears down snap / frame previews, and discards the pending undo snapshot without running drop or reparent resolution. A pointerdown outside the polygon falls through to the lasso (starting a fresh selection). Within a source region a stroke move is a plain in-node translate; dropping onto a _different_ region or blank canvas re-homes the strokes instead (see **Cross-region split / merge** below). When the lasso also caught **whole nodes** (a mixed selection), those selected nodes travel **together** with the strokes: they are driven live through the store's normal drag lifecycle (`onNodeDragStart` → `onNodesChange` → `onNodeDragStop`, so smart-snap / frame re-parenting / autosave behave exactly like a plain drag) and the stroke bake folds into that gesture's single undo entry. Whole nodes whose ancestor is also selected are excluded by walking the complete `parentId` chain, preventing descendants from receiving the group delta twice through nested frames.

**Framed sketch carried by a dragged ancestor.** When a mixed selection includes a frame _and_ a sketch that lives inside it (or any sketch whose `parentId` chain contains a dragged node), that sketch is **carried** by the ancestor's node-drag — ReactFlow already re-transforms its whole SVG by the group delta. Applying the stroke translate on top would move those strokes a **second** time and slide them out of the frame. To reconcile the two channels, [useSketchStrokeMove.ts](../../apps/web/src/hooks/useSketchStrokeMove.ts)`.onPointerDown` walks each stroke-selected node's `parentId` chain against the dragged-node set and publishes the carried node ids on a dedicated transient channel (`gesturePreviewStore.sketchStrokeMoveCarriedNodeIds`); [SketchNode.tsx](../../apps/web/src/components/Nodes/sketch/SketchNode.tsx) skips the move-preview translate for a carried node, and the commit bake skips it too, so the node simply rides along with its frame (its position relative to the frame is unchanged). Top-level sketches lassoed with a frame are **not** carried (empty set → their strokes follow the frame's snapped delta as before).

**Cross-region split / merge (drag).** A **pure** stroke selection (no whole node in the lasso) dropped onto **blank canvas** splits into a brand-new sketch region; dropped onto **another** sketch region it merges into it. On commit [useSketchStrokeMove.ts](../../apps/web/src/hooks/useSketchStrokeMove.ts) hit-tests the drop point in absolute flow (excluding the source regions, topmost wins) and, for a cross-region drop, dispatches the `MOVE_SKETCH_STROKES_TO_REGION` UI intent instead of the in-node translate. [resolveMoveSketchStrokesToRegion.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveMoveSketchStrokesToRegion.ts) resolves the destination parent frame from the drop point (`resolveFrameAtPoint`) and calls [buildSketchStrokeTransferCommands](../../apps/web/src/components/Nodes/sketch/sketchMerge.ts), which works in **absolute flow** (`getAbsolutePosition`) so transfers across frames stay correct and degrade to the plain in-node math when the parent is unchanged; the source side reuses the extracted pure core `computeEraseCommands` (reflow the remainder, or delete the node when emptied). Splitting **into a frame** shows the same grow-to-fit accept-preview a whole-node drag gets (`computeFrameFit` + `setFrameFitPreviews`); merge / in-place / blank-top-level drops show none. The whole transfer is **one undo entry** — `canvasStore.moveSketchStrokesToRegion` brackets it with `beginNodeDataGesture` / `endNodeDataGesture` (with an empty-op `rollbackGestureSnapshot` guard). Deferred: auto-contact ("bridging") merge, edge rewiring when a source is emptied, and OCR-rerun on split (see the [sketch-region-redesign proposal](../proposals/sketch-region-redesign.md)).

**Toolbar arbitration.** A [StrokeSelectionToolbar](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/StrokeSelectionToolbar.tsx) floats above the stroke selection: on a **pure, single-color** selection it shows color + size controls (reusing [SketchControls](../../apps/web/src/components/Nodes/sketch/SketchControls.tsx), applied only to the selected strokes — the brush preset is untouched). Each color or size tick builds one `MERGE_NODE_DATA` command containing every affected sketch patch, matching the multi-node accent path's atomic update and undo semantics; the size slider's gesture bracket folds all ticks into one undo entry. A **Delete** action (touch only — desktop uses the keyboard) reuses the eraser's `buildEraseCommands` (subset removal → bbox reflow, or node delete when empty). Delete removes the **whole selection** — strokes plus any whole nodes the same lasso caught — as **one undo entry**: the node delete takes its snapshot + intent trace, then the stroke erase folds into that same entry via [commitStrokeCommands](../../apps/web/src/components/Nodes/sketch/sketchMerge.ts) (`foldIntoOpenGesture`), mirroring the mixed stroke-move gesture. **Delete / Backspace** triggers the same combined delete (guarded against text inputs); the canonical keyboard handler in [useCanvasShortcuts.ts](../../apps/web/src/hooks/shortcuts/useCanvasShortcuts.ts) **skips its own node deletion while a stroke selection is active** so the keypress never pushes a second snapshot. To guarantee at most one floating toolbar, the node toolbars (single-select in [NodeWrapper.tsx](../../apps/web/src/components/Nodes/NodeWrapper.tsx) and MultiSelect) hide whenever a stroke selection exists — so a mixed lasso on desktop shows no toolbar at all. Rendering a stroke selection to PNG and sending it to the agent is covered in §4.1; eager auto-OCR of regions remains deferred (see [sketch-region-redesign proposal](../proposals/sketch-region-redesign.md) Stage 3).

From here the two paths are independent: read by AI (§4) or explicitly parsed (§5).

---

## 4. Path A — read by AI as a content node

No explicit trigger; any agent turn can treat a sketch as visual content:

- `read("nodes/<file>.md")` returns only the sketch's `label`, **not the strokes**;
  to see the drawing use `snapshot_node` to render a PNG vision attachment. Tool
  def: [definitions.ts](../../apps/server/src/modules/agent/tools/definitions.ts),
  impl: [snapshot-node.ts](../../apps/server/src/modules/agent/tools/handlers/snapshot-node.ts).
- The chat route auto-snapshots the user's selected sketch / image on the first
  turn (nodes ≤ 200px cluster into one PNG, strokes over image); keys go into
  user-message metadata so the agent need not re-snapshot.
- External agents: the system prompt says "use snapshot for `sketch` / `image`, not read-node".

### 4.1 Partial stroke selection as AI context

A stroke selection (§3.5) is a first-class **source**, not just an editing target. `getAgentChatContext` injects the selected strokes into the turn's selected nodes, and `snapshot_nodes` accepts an optional per-node `strokeSubsets` KEEP-list (`[{ nodeId, strokeIds }]`) so the server renders **only those strokes** — content-addressed independently of the whole-node snapshot — and labels the attachment as a partial stroke selection. If a non-empty KEEP-list no longer matches any stroke, the snapshot fails with a stale-selection error instead of widening to the whole sketch. The wire `WireSelectionNode` carries an optional `strokeIds`. Source counts (`SourceCount`) and the sent user message both count a sketch that has _only_ a stroke selection, so a pure-ink source is visible before and after sending.

**Persistence + hover re-highlight (zero migration).** The sent `strokeIds` already persist with the turn's request (`request.selectedNodes[].strokeIds`), so no new storage is needed; they surface to the client via a message-level `selectedStrokeIds` and the envelope's **optional** `focus.selection.strokeSubsets` (old records simply lack it → graceful degrade). Hovering a chat message's source chip re-highlights those strokes on the canvas through a **separate** transient channel `gesturePreviewStore.sketchStrokeHighlight` — kept apart from the active `sketchStrokeSelection` so the two never fight — and [SketchNode.tsx](../../apps/web/src/components/Nodes/sketch/SketchNode.tsx) renders `selection ∪ highlight` in the shared `--color-info`. The highlight is **best-effort against the current canvas**: SketchNode only lights strokes still present in its `data.strokes`, so erased strokes / deleted nodes fall out with no cleanup, and a deleted node's chip degrades to the shared [NodeRef](../../apps/web/src/components/Common/NodeRef.tsx) strikethrough. The count label shows the number of strokes sent _at the time_ ("N 笔"), never a recomputed value.

---

## 5. Path B — as an executable gesture

User-initiated; parse strokes into canvas commands. Three steps: trigger → recognition pipeline → Accept/Revert.

### 5.1 Trigger

| Entry             | Condition                          | Impl                                                                                                                                                      |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-select bar  | ≥ 2 nodes, all `type === 'sketch'` | [MultiSelectToolbar.tsx](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/MultiSelectToolbar.tsx)                                             |
| Single-select bar | one selected sketch                | [NodeWrapper.tsx](../../apps/web/src/components/Nodes/NodeWrapper.tsx) slot + [SketchNode.tsx](../../apps/web/src/components/Nodes/sketch/SketchNode.tsx) |

Button onClick → `intentStore.requestSketchRecognition(ids)`.

### 5.2 Recognition pipeline (3 stages)

```
requestSketchRecognition(ids) → triggerSketchRecognition()
        │
        ├── Stage 1: clusterSketches(strokes)            // handler/sketch/sketchClustering.ts
        ├── Stage 2: extractSketchContext(cluster, ...)  // handler/sketch/sketchContext.ts
        └── Stage 3: recognizeSketchCommands(shot, ctx)  // server: sketch.service.ts → CanvasCommand[]
        │
        ▼
SketchProcessingOverlay (preparing → pending → running → done)
        │
        ▼
Accept (executeCommands + delete sketch)  or  Revert (run revertCommands, keep sketch)
```

**Stage 1 · clustering** — [sketchClustering.ts](../../apps/web/src/handler/sketch/sketchClustering.ts)

- Union-Find single-linkage; distance = min bbox edge distance (`rectEdgeDistance`); threshold `CLUSTER_DISTANCE_THRESHOLD = 200`
- in `SketchStroke[]` (`id` / `rect` / `points` / `initialSize`) → out `SketchCluster[]` (`strokeIds` / `strokes` / `bbox`)
- A circle top-left and a cross bottom-right must resolve separately; the farther apart, the less they should merge.

**Stage 2 · context** — [sketchContext.ts](../../apps/web/src/handler/sketch/sketchContext.ts)

- `nearbyNodes`: non-sketch nodes within `NEARBY_RADIUS = 300px` of the bbox (max 8, distance-sorted)
- `enclosedNodes`: nodes intersecting the padded bbox with ≥ 40% area covered
- The frontend does **no** shape inference and sends **no** `startNode / endNode` — the LLM reads shape from the screenshot; the frontend only structures node IDs.

**Stage 3 · vision LLM** — chain: [api/intent.ts](../../apps/web/src/api/intent.ts) → [intent.route.ts](../../apps/server/src/modules/agent/intent.route.ts) → [sketch.service.ts](../../apps/server/src/modules/agent/sketch.service.ts) (prompt: [intent.ts](../../apps/server/src/prompt/intent.ts))

```ts
interface SketchIntentRequest {
  screenshot: string; // base64
  clusterContext: SketchClusterContext; // bbox + strokeCount + nearby/enclosed nodes + nearby edge ids
  canvasId?: string;
}
```

The server serialises `clusterContext` into dense text on the user message so the LLM can locate node IDs without OCR, returning one most-likely intent → `CanvasCommand[]`.

### 5.3 Accept / Revert preview

After commands return: `executeCommands(..., 'ui')` applies them optimistically, `SketchProcessingOverlay` ([component](../../apps/web/src/components/Nodes/sketch/SketchProcessingOverlay.tsx)) shows `preparing → pending → running → done`, and each cluster keeps its `revertCommands`:

| Action     | Behaviour                                                                 |
| ---------- | ------------------------------------------------------------------------- |
| **Accept** | keep the changes, **delete the sketch node** (default — gesture consumed) |
| **Revert** | run `revertCommands` to undo, **keep the sketch node** (edit / re-run)    |

Cancel: `cancelSketchRecognition()` aborts in-flight batches and clears the overlay.

---

## 6. Code entry points

| Concern                | File                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node type              | [packages/shared/src/types/canvas/node.ts](../../packages/shared/src/types/canvas/node.ts)                                                                                                                                                                                                                               |
| Stroke / cluster       | [packages/shared/src/types/agent/intent.ts](../../packages/shared/src/types/agent/intent.ts)                                                                                                                                                                                                                             |
| Draw tool              | [apps/web/src/components/Nodes/sketch/SketchOverlay.tsx](../../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)                                                                                                                                                                                                   |
| Draw controls          | [apps/web/src/components/Nodes/sketch/SketchSettingsPanel.tsx](../../apps/web/src/components/Nodes/sketch/SketchSettingsPanel.tsx), [SketchModeSwitcher.tsx](../../apps/web/src/components/Nodes/sketch/SketchModeSwitcher.tsx), [SketchSizePicker.tsx](../../apps/web/src/components/Nodes/sketch/SketchSizePicker.tsx) |
| Node render            | [apps/web/src/components/Nodes/sketch/SketchNode.tsx](../../apps/web/src/components/Nodes/sketch/SketchNode.tsx)                                                                                                                                                                                                         |
| Stroke lasso / merge   | [apps/web/src/components/Nodes/sketch/sketchMerge.ts](../../apps/web/src/components/Nodes/sketch/sketchMerge.ts), [sketchHitTest.ts](../../apps/web/src/components/Nodes/sketch/sketchHitTest.ts)                                                                                                                        |
| Stroke selection state | [apps/web/src/store/gesturePreviewStore.ts](../../apps/web/src/store/gesturePreviewStore.ts)                                                                                                                                                                                                                             |
| Stroke move / split    | [apps/web/src/hooks/useSketchStrokeMove.ts](../../apps/web/src/hooks/useSketchStrokeMove.ts), [StrokeSelectionRegion.tsx](../../apps/web/src/components/Panels/Canvas/StrokeSelectionRegion.tsx)                                                                                                                         |
| Cross-region intent    | [apps/web/src/handler/canvasCommand/resolvers/resolveMoveSketchStrokesToRegion.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveMoveSketchStrokesToRegion.ts)                                                                                                                                               |
| Overlay state          | [apps/web/src/components/Nodes/sketch/SketchProcessingOverlay.tsx](../../apps/web/src/components/Nodes/sketch/SketchProcessingOverlay.tsx)                                                                                                                                                                               |
| Path A · snapshot      | [apps/server/src/modules/agent/tools/handlers/snapshot-node.ts](../../apps/server/src/modules/agent/tools/handlers/snapshot-node.ts)                                                                                                                                                                                     |
| Path B · store         | [apps/web/src/store/intentStore.ts](../../apps/web/src/store/intentStore.ts)                                                                                                                                                                                                                                             |
| Path B · cluster       | [apps/web/src/handler/sketch/sketchClustering.ts](../../apps/web/src/handler/sketch/sketchClustering.ts)                                                                                                                                                                                                                 |
| Path B · context       | [apps/web/src/handler/sketch/sketchContext.ts](../../apps/web/src/handler/sketch/sketchContext.ts)                                                                                                                                                                                                                       |
| Screenshot             | [apps/web/src/handler/canvasCommand/utils/screenshot.ts](../../apps/web/src/handler/canvasCommand/utils/screenshot.ts)                                                                                                                                                                                                   |
| Path B · API           | [apps/web/src/api/intent.ts](../../apps/web/src/api/intent.ts)                                                                                                                                                                                                                                                           |
| Path B · server        | [apps/server/src/modules/agent/sketch.service.ts](../../apps/server/src/modules/agent/sketch.service.ts)                                                                                                                                                                                                                 |
| Multi-select bar       | [apps/web/src/components/Panels/Canvas/FloatingToolbars/MultiSelectToolbar.tsx](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/MultiSelectToolbar.tsx)                                                                                                                                                     |
| Single-select slot     | [apps/web/src/components/Nodes/NodeWrapper.tsx](../../apps/web/src/components/Nodes/NodeWrapper.tsx)                                                                                                                                                                                                                     |
| Persistence whitelist  | [apps/server/src/modules/canvas/canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts) `MD_BACKED_NODE_TYPES`                                                                                                                                                                                            |
