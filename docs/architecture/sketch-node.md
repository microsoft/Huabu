# Sketch Node

> Sketch node (`type: 'sketch'`): freehand strokes as a persistent canvas node.
> A sketch shares the same lifecycle as every other node (create, move, delete,
> nest in a frame, recolor, relabel) and does NOT disappear after being read by
> AI.

A sketch has two **independent** relationships with AI, described separately:

- **Path A — as a content node** (§4): like an image, it carries visual
  information; agents render it to a PNG via `snapshot_node` to "see" it and fold
  it into their understanding of the canvas. No explicit trigger needed.
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

| Node type                                | inline in canvas.json                                                       | `nodes/<safeLabel>.md` | Notes                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sketch`                                 | **stroke geometry** (`points` / `initialSize` / `strokeColor` / `executed`) | ✅ frontmatter-only    | geometry inline in `state.nodes[i].data`; sidecar only persists `label` / `labelSource` (structure PUT strips them) |
| `question` / `image` / `video` / `frame` | metadata                                                                    | ✅ frontmatter-only    | same as sketch, sidecar only                                                                                        |
| `note` / `text` / `web` / `pdf`          | metadata                                                                    | ✅                     | text types also carry a markdown body                                                                               |

`MD_BACKED_NODE_TYPES` whitelist: [canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts). Footprint: ~0.5–3 KB per stroke, negligible for `canvas.json`.

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

| Concern               | File                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node type             | [packages/shared/src/types/canvas/node.ts](../../packages/shared/src/types/canvas/node.ts)                                                                           |
| Stroke / cluster      | [packages/shared/src/types/agent/intent.ts](../../packages/shared/src/types/agent/intent.ts)                                                                         |
| Draw tool             | [apps/web/src/components/Nodes/sketch/SketchOverlay.tsx](../../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)                                               |
| Node render           | [apps/web/src/components/Nodes/sketch/SketchNode.tsx](../../apps/web/src/components/Nodes/sketch/SketchNode.tsx)                                                     |
| Overlay state         | [apps/web/src/components/Nodes/sketch/SketchProcessingOverlay.tsx](../../apps/web/src/components/Nodes/sketch/SketchProcessingOverlay.tsx)                           |
| Path A · snapshot     | [apps/server/src/modules/agent/tools/handlers/snapshot-node.ts](../../apps/server/src/modules/agent/tools/handlers/snapshot-node.ts)                                 |
| Path B · store        | [apps/web/src/store/intentStore.ts](../../apps/web/src/store/intentStore.ts)                                                                                         |
| Path B · cluster      | [apps/web/src/handler/sketch/sketchClustering.ts](../../apps/web/src/handler/sketch/sketchClustering.ts)                                                             |
| Path B · context      | [apps/web/src/handler/sketch/sketchContext.ts](../../apps/web/src/handler/sketch/sketchContext.ts)                                                                   |
| Screenshot            | [apps/web/src/handler/canvasCommand/utils/screenshot.ts](../../apps/web/src/handler/canvasCommand/utils/screenshot.ts)                                               |
| Path B · API          | [apps/web/src/api/intent.ts](../../apps/web/src/api/intent.ts)                                                                                                       |
| Path B · server       | [apps/server/src/modules/agent/sketch.service.ts](../../apps/server/src/modules/agent/sketch.service.ts)                                                             |
| Multi-select bar      | [apps/web/src/components/Panels/Canvas/FloatingToolbars/MultiSelectToolbar.tsx](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/MultiSelectToolbar.tsx) |
| Single-select slot    | [apps/web/src/components/Nodes/NodeWrapper.tsx](../../apps/web/src/components/Nodes/NodeWrapper.tsx)                                                                 |
| Persistence whitelist | [apps/server/src/modules/canvas/canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts) `MD_BACKED_NODE_TYPES`                                        |
