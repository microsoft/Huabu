# Prompt Node — Design Document

> **Status**: Largely Complete (Phase 3 architecture simplified, screenshot deferred)  
> **Date**: 2026-04-21

---

## 1. Overview

### 1.1 What

A new canvas node type — **Prompt Node** — that serves as an AI interaction medium embedded directly on the canvas. Unlike content nodes (note, text, pdf, etc.), a prompt node carries a **user question or intent**, and uses its **spatial position and surrounding context** to invoke the existing chat AI agent (in `ask` mode) that reasons about the canvas.

### 1.2 Why

The current AI interaction model (chat panel) is **spatially detached** — the user must manually select nodes to provide context, and the AI has no awareness of where things are on the canvas. Prompt nodes fix this by:

- **Anchoring AI interaction to a specific location** — the node's position _is_ the context signal
- **Automatic context gathering** — nearby nodes, connected edges, frame membership are inferred from spatial relationships
- **Parallel AI runs** — multiple prompt nodes can run independently
- **Lower friction** — auto-run after a configurable delay, no manual "send" step

### 1.3 Guiding Metaphor

> Placing a sticky note on a whiteboard and walking away. An assistant notices it, reads the surrounding material, thinks about the question, and writes back.

---

## 2. Spatial Infrastructure (Phase 0)

Before building the prompt node itself, we need a shared spatial reasoning layer. Currently **the AI agent has zero spatial awareness** — `NodeSummary`, `SelectedNodeDetail`, and intent context carry no position data at all.

### 2.1 `packages/shared/src/utils/spatial.ts` — Pure Functions

Zero-dependency, runs on both frontend and server.

#### Geometry Primitives

```typescript
interface Rect { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }

rectCenter(r: Rect): Point
pointDistance(a: Point, b: Point): number
rectCenterDistance(a: Rect, b: Rect): number     // center-to-center
rectEdgeDistance(a: Rect, b: Rect): number       // edge-to-edge (0 if overlap)
rectsOverlap(a: Rect, b: Rect): boolean
rectIntersectionArea(a: Rect, b: Rect): number
```

#### Direction Classification

```typescript
type CardinalDirection = 'left' | 'right' | 'above' | 'below'

relativeDirection(a: Rect, b: Rect): CardinalDirection   // B relative to A
```

#### Spatial Queries

```typescript
interface SpatialNode {
  id: string
  rect: Rect
  type?: string
  parentId?: string | null
}

interface ProximityResult<T extends SpatialNode = SpatialNode> {
  node: T
  distance: number          // edge distance
  centerDistance: number     // center distance
  direction: CardinalDirection
}

findNearbyNodes<T>(target, candidates, opts?): ProximityResult<T>[]
findClusters<T>(nodes, maxGap): T[][]            // union-find by edge distance
nodesInRect<T>(nodes, region): T[]
```

#### Layout Detection

```typescript
detectArrangement(nodes: SpatialNode[]): string
// → "3 nodes in a horizontal row"
// → "4 nodes in a 2×2 grid"
// → "5 nodes in a vertical column"
// → "6 nodes scattered"

sortByReadingOrder(nodes: SpatialNode[]): SpatialNode[]
// left→right, top→bottom
```

#### High-Level Builders

```typescript
// For chat agent / intent — whole-canvas summary
buildSpatialSummary(
  nodes: SpatialNode[],
  edges: Array<{ source: string; target: string }>,
  opts?: { clusterGap?: number },
): SpatialSummary

// For prompt node — three-layer spatial context around a specific node
buildSpatialLayers(
  promptNode: SpatialNode,
  allNodes: SpatialNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  nodeSnippets?: Map<string, string>,
): SpatialLayer[]

buildPromptNodeContext(
  promptNode: SpatialNode,
  allNodes: SpatialNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  nodeSnippets?: Map<string, string>,
  opts?: { maxDistance?: number },
): PromptSpatialContext
```

### 2.2 Type Enhancements (`packages/shared/src/types/context.ts`)

```typescript
// Existing types gain position data
interface NodeSummary {
  // ...existing fields
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

interface SelectedNodeDetail {
  // ...existing fields
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

// New types
interface SpatialSummary {
  clusters: SpatialCluster[];
  isolated: string[]; // node IDs
}

interface SpatialCluster {
  frameId?: string;
  frameLabel?: string;
  nodeIds: string[]; // ordered by reading order
  arrangement: string; // human-readable
}

interface SpatialLayer {
  frameId?: string;
  frameLabel?: string;
  groups: SpatialGroup[];
  description: string;
}

interface PromptSpatialContext {
  layers: SpatialLayer[]; // nested from innermost to outermost
  groups: SpatialGroup[]; // flat list across all layers
  relevantEdges: Array<{
    source: string;
    target: string;
    sourceLabel?: string;
    targetLabel?: string;
  }>;
  semanticPosition: string; // natural language description
}

interface SpatialGroup {
  dx: number; // X offset from reference center
  dy: number; // Y offset from reference center
  arrangement: string; // human-readable pattern
  frameId?: string;
  frameLabel?: string;
  nodes: Array<{ id: string; type?: string; label?: string; snippet?: string }>;
  _minEdgeDist: number; // internal: min edge distance to reference
}
```

### 2.3 Context Flow Changes

#### `getAgentContext()` (canvasStore)

Populate `position` and `size` on every `NodeSummary`, and include a new `spatialSummary` field computed via `buildSpatialSummary()`. Uses `getCachedSpatialData()` — a module-level cache with FNV-1a fingerprint-based invalidation to avoid O(n²) clustering on every call.

#### Server Serialization

Convert `SpatialSummary` to natural-language text before injecting into LLM prompt:

```
## Canvas Layout

### "Research" frame
4 nodes in a 2×2 grid:
  Top row:    "Climate Data" [pdf], "IPCC Report" [web]
  Bottom row: "Key Findings" [note], "Questions" [note]

### Cluster (ungrouped)
2 nodes side-by-side:
  "Policy Options" [note] ←→ "Cost Analysis" [note]

### Isolated
- "Meeting Notes" [note] — far upper-right
```

### 2.4 Two-Layer Information Design

| Layer                                        | Purpose                            | Source                                               | Consumers                                                |
| -------------------------------------------- | ---------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| **Pre-computed topology** (natural language) | LLM reasoning — "what's near what" | `buildSpatialSummary()` / `buildPromptNodeContext()` | System prompt, prompt node context                       |
| **Raw coordinates** (x, y, w, h)             | Agent placing new nodes precisely  | `get_canvas_state` tool response                     | Agent tool calls for `SET_NODE_GEOMETRY`, `CREATE_NODES` |

The LLM receives natural-language descriptions like "3 nodes in a horizontal row" for reasoning, and retrieves raw coordinates on-demand through the `get_canvas_state` tool when it needs to calculate exact placement.

### 2.5 Beneficiaries Beyond Prompt Node

| Consumer                       | Current           | After Phase 0                                    |
| ------------------------------ | ----------------- | ------------------------------------------------ |
| Chat Agent (`getAgentContext`) | No spatial info   | Clusters + arrangement descriptions              |
| Intent Recognition             | No position data  | Can describe "user selected the left group"      |
| `get_canvas_state` tool        | No positions      | Returns coordinates for precise placement        |
| Frame auto-nesting             | Own rect code     | Can reuse `rectsOverlap`, `rectIntersectionArea` |
| Edge smart routing             | Own distance calc | Can reuse `relativeDirection`                    |
| Auto-layout solver             | Own absolute pos  | Can reuse `rectCenter`, `pointDistance`          |

---

## 3. Prompt Node — Type System (Phase 1)

### 3.1 Shared Types (`packages/shared/src/types/canvas/node.ts`)

```typescript
// Add to CanvasNodeType union
export type CanvasNodeType =
  | 'note' | 'text' | 'image' | 'pdf' | 'video' | 'web' | 'frame'
  | 'prompt'

// Prompt execution status
export type PromptNodeStatus =
  | 'idle'       // no input or manually cancelled
  | 'pending'    // countdown to auto-run
  | 'running'    // agent executing
  | 'done'       // completed successfully
  | 'error'      // agent failed

// Extensible input kind (text now, sketch/voice later)
export type PromptInput =
  | { kind: 'text'; content: string }
  // future: | { kind: 'sketch'; strokes: StrokeData[]; imageDataUrl?: string }
  // future: | { kind: 'voice'; transcription: string; audioUrl?: string }

export interface PromptNodeData extends BaseNodeData {
  type: 'prompt'
  input: PromptInput
  status: PromptNodeStatus
  /** Epoch ms when auto-run triggers. Set on blur. */
  runAt?: number
  /** Per-node auto-run delay override (seconds). */
  autoRunDelay?: number
  /** Agent thread ID (set when run starts). */
  threadId?: string
  /** Error message when status === 'error'. */
  errorMessage?: string
  /** Short AI response shown on node after completion. */
  responseSummary?: string
  /** Whether user has viewed the completed response in chat panel. */
  viewed?: boolean
}

// Add to NodeData union
export type NodeData = ... | PromptNodeData

// Type guard
export function isPromptNode(data: NodeData): data is PromptNodeData
```

### 3.2 Canvas Types (`apps/web/src/components/Nodes/types.ts`)

```typescript
export type CanvasPromptNodeData = SharedPromptNodeData & {
  [key: string]: unknown;
};
// Add to CanvasNodeData union
```

---

## 4. Prompt Node — Frontend Component (Phase 1)

### 4.1 File Structure

```
apps/web/src/components/Nodes/prompt/
└── PromptNode.tsx          ← Main component (input + status inlined)
```

> **Decision**: Input area and status bar are inlined in `PromptNode.tsx` rather than split into sub-components. The component is manageable as a single file.

### 4.2 Visual Design

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐   ← sticky-note style, rounded corners
  ❓                                      ← icon: BadgeQuestionMark
│                                     │
  AI 如何 Support这个过程？               ← font: Comic Sans MS / STXingkai / cursive
│                                     │
  [⏳ 8s]                                 ← status badge (top-left, only when active)
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

States:

- **idle** (empty): Placeholder "Ask a question..." — no status badge
- **idle** (has content): Shows content — no status badge
- **pending**: Content readonly + `Clock` badge with countdown (e.g. "8s")
- **running**: Content readonly + `Loader` spinner badge
- **done**: Content readonly + `Check` badge (glow effect if `viewed === false`)
- **error**: Content readonly + `X` badge + error message

Accent color: uses `var(--prompt-bg)` CSS variable. Done-unviewed state shows a visual glow (`prompt-node-done-unviewed` class).

Toolbar buttons (shown on node selection):

- **Edit** (`Pencil`): Enter edit mode (hidden during pending/running)
- **View conversation** (`MessageSquare`): Open in chat panel (shown when `hasRun && threadId`)
- **Cancel** (`Square`): Cancel pending timer or running agent
- **Run Now** (`Play`): Immediately fire pending prompt

### 4.3 State Machine & Interaction

```
         ┌──────────────────────────────────────┐
         │                                      │
         ▼                                      │
      ┌──────┐  blur (has content)  ┌─────────┐ │
  ──▶ │ idle │ ───────────────────▶ │ pending │ │
      └──┬───┘                      └─────┬───┘ │
         │  ▲                       timer │  ▲  │
  double │  │ double-click          fires │  │  │
  click  │  │ (enters edit mode)       or │  │  │
         │  │                      "Now" │  │  │
         │  │                            ▼  │  │
         │  │                      ┌─────────┐ │
         │  ├───────────────────── │ running  │ │
         │  │                      └──┬───┬──┘ │
         │  │                  success│   │err │
         │  │                         ▼   ▼    │
         │  │                    ┌──────┐ ┌───────┐
         │  └────────────────────│ done │ │ error │
         │                       └──────┘ └───────┘
         │                           │        │
         └───────────────────────────┴────────┘
             double-click on done/error:
               if threadId → open chat panel
               else → re-edit
```

### 4.4 Auto-run Timer

```typescript
const DEFAULT_AUTO_RUN_DELAY = 10; // seconds (was 30 in original design)

// On blur:
//   1. Commit input text (with undo recording)
//   2. Set status='pending', runAt=Date.now() + delay*1000

// usePromptRunner() hook watches canvas store:
//   - Subscribes to node changes
//   - For each pending prompt node: setTimeout for (runAt - now) ms
//   - On fire: executePromptNode(nodeId)
//   - Cleanup: clearTimeout on unmount or node deletion
```

Per-node `autoRunDelay` field is supported but no UI selector has been built yet. Default is 10 seconds.

### 4.5 Config Updates

| File                  | Change                                  |
| --------------------- | --------------------------------------- |
| `config/nodeIcons.ts` | `prompt: BadgeQuestionMark`             |
| `config/nodeSizes.ts` | `prompt: { width: 280, height: 160 }`   |
| `Canvas.tsx`          | `nodeTypes.prompt = PromptNode`         |
| `canvasStore.ts`      | `pendingNodeType` union adds `'prompt'` |
| `CanvasToolbar.tsx`   | Prompt node creation button             |

---

## 5. Prompt Node — Spatial Context (Phase 2)

### 5.1 Three-Priority Spatial Layers

| Priority           | Source                     | Detail Level                         | Why                                      |
| ------------------ | -------------------------- | ------------------------------------ | ---------------------------------------- |
| **P0 — Connected** | Edges touching prompt node | Full content (via `get_node_detail`) | User drew a line = explicit intent       |
| **P1 — Siblings**  | Same frame as prompt node  | Summary + keywords                   | Same group = topically related           |
| **P2 — Nearby**    | Distance-sorted top-N      | Label + snippet only                 | Spatial proximity ≈ conceptual relevance |

### 5.2 Dual Modality: Vision + Text

Both channels serve the AI, but carry different strengths:

| Channel                           | Captures                                              | Cannot capture                                          |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| **Text** (structured description) | Exact content, edge semantics, cluster membership     | Visual gestalt, color groupings, hand-drawn annotations |
| **Vision** (local screenshot)     | Spatial layout feel, color patterns, arrow directions | Fine text in small nodes, nodes outside viewport        |

**Text is the foundation (always available). Vision is best-effort enhancement.**

### 5.3 Screenshot Capture

> **Status**: NOT IMPLEMENTED — deferred.

The original design called for eager screenshot capture at blur time with caching and invalidation. This has not been built. The text-based spatial context (via `buildPromptNodeContext()`) is the sole context channel.

Future implementation could add vision as a best-effort enhancement on top of the always-available text layer.

### 5.4 Text Context Format (Example)

For the canvas shown in the discussion (informal visual thinking → formalized structured representation):

```markdown
## Prompt Node Context

### Your Question

"AI 如何 Support这个过程？"

### Spatial Position

Between two groups, below the flow arrow
"Informal visual thinking → Formalized structured representation".

### Group A — LEFT of your question

4 notes stacked vertically:

1. "最非结构化：自由草图 (Freeform Sketching)" [note]
   随手画的框、箭头、符号，不规则布局，涂画边界...
2. "空间组织 (Spatial Organization)" [note]
   把内容"摆在空间里"，簇...
3. "连线与关系 (Relational Linking)" [note]
   箭头、线条、连接，标注关系...
4. "标注与批注 (Annotation)" [note]
   在已有内容上圈、划线、写 comment...

### Group B — RIGHT of your question

4 notes in a 2×2 grid:

1. "(1) Diagram (图结构)" [note]
2. "(2) Textual structure (文本结构)" [note]
3. "(3) Executable form (可执行结构)" [note]
4. "(4) Conceptual abstraction (抽象表达)" [note]

### Canvas Flow

"Informal visual thinking" ──→ "Formalized structured representation"
(Your question sits at the transition point between these two.)
```

---

## 6. Prompt Node — Agent Execution (Phase 3)

> **Decision**: Rather than building a separate prompt agent backend, the implementation reuses the existing `/api/agent` endpoint in `ask` mode. Spatial context is serialized to natural language and prepended to the user's question.

### 6.1 Endpoint

```
POST /api/agent                   ← Existing chat agent endpoint (SSE)
```

No separate prompt-specific routes were needed. The prompt node's `usePromptRunner` hook calls `agentApi.streamMessage()` with mode `'ask'`.

### 6.2 Execution Flow (`usePromptRunner.ts`)

```typescript
async function executePromptNode(nodeId: string): Promise<void> {
  // 1. Build spatial context from cached spatial data
  const { spatialNodes } = getCachedSpatialData();
  const target = spatialNodes.find((n) => n.id === nodeId);
  const spatialCtx = target
    ? buildPromptNodeContext(target, spatialNodes, edges, snippets)
    : undefined;

  // 2. Serialize spatial context to natural-language markdown
  const contextMsg = spatialCtx
    ? buildContextMessage(question, spatialCtx)
    : undefined;

  // 3. Prepend context to user's question
  const messageContent = contextMsg
    ? `${contextMsg.content}\n\n${question}`
    : question;

  // 4. Stream to existing /api/agent in 'ask' mode
  await agentApi.streamMessage(
    messageContent,
    threadId, // unique per prompt node, created via createId('thread')
    'ask',
    callbacks,
    { canvasId, signal: abortController.signal },
  );
}
```

### 6.3 Agent Design

- **Reuses existing chat agent** — own thread per prompt node (created if missing), same system prompt
- **Reuses existing tools** — `get_node_detail`, `canvas_commands`, `web_search`, `search_knowledge`, etc.
- **Spatial context injected** as `[SYSTEM Context]` preamble in the message content
- **Conversation viewable** in chat panel via `openPromptThread(nodeId, threadId)`

### 6.4 SSE Events

Reuses existing `AgentStreamEvent` types. Events stream in the background — the full conversation is viewed later by opening the chat panel linked to the prompt node's `threadId`.

- On complete: `status = 'done'`
- On error: `status = 'error'`, error message stored in `errorMessage`

### 6.5 Lifecycle Management

```typescript
// Module-level in usePromptRunner.ts (NOT in canvasStore)
const activeRuns = new Map<string, AbortController>();

// On run start:
activeRuns.set(nodeId, abortController);

// On completion/error:
activeRuns.delete(nodeId);

// On node deletion (detected by store subscription):
// Cleans up timers and aborts active runs
```

Active run tracking is managed at module-level in `usePromptRunner.ts`, not as a store property. The store subscription detects node deletions and triggers cleanup.

---

## 7. Extensibility

### 7.1 Input Kinds

`PromptInput` is a discriminated union on `kind`. Adding new modalities is zero-cost at the type level:

```typescript
export type PromptInput =
  | { kind: 'text'; content: string }
  | { kind: 'sketch'; strokes: StrokeData[]; imageDataUrl?: string }
  | { kind: 'voice'; transcription: string; audioUrl?: string }
  | { kind: 'selection'; selectedNodeIds: string[] };
```

Frontend: `PromptNode.tsx` switches renderer by `input.kind` (currently only `text`).  
Backend: Agent receives appropriate context based on `input.kind`.

### 7.2 Agent Strategy per Input Kind

| Kind        | Vision Input                                        | System Prompt Focus                               |
| ----------- | --------------------------------------------------- | ------------------------------------------------- |
| `text`      | Local screenshot (optional)                         | Reason about spatial context + answer question    |
| `sketch`    | Screenshot (required — contains hand-drawn strokes) | Interpret visual intent + execute on canvas       |
| `voice`     | Local screenshot (optional)                         | Process spoken instruction with spatial awareness |
| `selection` | Highlighted nodes screenshot                        | Analyze selected subset in spatial context        |

---

## 8. File Change Inventory

### New Files

| Path                                                  | Purpose                                 | Status |
| ----------------------------------------------------- | --------------------------------------- | ------ |
| `packages/shared/src/utils/spatial.ts`                | Spatial geometry primitives + queries   | ✅     |
| `apps/web/src/components/Nodes/prompt/PromptNode.tsx` | Main prompt node component (all-in-one) | ✅     |
| `apps/web/src/hooks/usePromptRunner.ts`               | Auto-run timer + agent execution hook   | ✅     |

### Planned but Not Created

| Path                                                       | Reason Not Created                         |
| ---------------------------------------------------------- | ------------------------------------------ |
| `apps/web/src/components/Nodes/prompt/PromptInputArea.tsx` | Inlined in PromptNode.tsx                  |
| `apps/web/src/components/Nodes/prompt/PromptStatusBar.tsx` | Inlined in PromptNode.tsx                  |
| `apps/web/src/api/promptAgent.ts`                          | Reuses existing `agentApi.streamMessage()` |
| `apps/server/src/modules/agent/prompt-agent.route.ts`      | Reuses existing `/api/agent` endpoint      |
| `apps/server/src/modules/agent/prompt-agent.service.ts`    | Reuses existing chat agent service         |
| `apps/server/src/prompt/prompt-node.ts`                    | Reuses existing system prompt              |

### Modified Files

| Path                                                      | Change                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/canvas/node.ts`                | Add `PromptNodeData`, `PromptNodeStatus`, `PromptInput`                                                                     |
| `packages/shared/src/types/context.ts`                    | Add `position?/size?` to `NodeSummary`/`SelectedNodeDetail`; add `SpatialSummary`, `PromptSpatialContext`                   |
| `packages/shared/src/index.ts`                            | Export new types + spatial utils                                                                                            |
| `apps/web/src/components/Nodes/types.ts`                  | Add `CanvasPromptNodeData` to union                                                                                         |
| `apps/web/src/components/Panels/Canvas/Canvas.tsx`        | Register `prompt` in `nodeTypes`                                                                                            |
| `apps/web/src/config/nodeIcons.ts`                        | Add `prompt` icon                                                                                                           |
| `apps/web/src/config/nodeSizes.ts`                        | Add `prompt` default size                                                                                                   |
| `apps/web/src/store/canvasStore.ts`                       | `pendingNodeType` adds `'prompt'`; `getAgentContext()` adds position/size + spatialSummary; `getCachedSpatialData()` helper |
| `apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx` | Prompt node creation button                                                                                                 |

---

## 9. Implementation Phases

### Phase 0 — Spatial Infrastructure

> **Risk**: Low (pure additive, no behavioral changes)  
> **Dependencies**: None

- [x] `packages/shared/src/utils/spatial.ts` — all geometry + query functions
- [x] `packages/shared/src/types/context.ts` — add position/size fields + spatial types
- [x] `packages/shared/src/index.ts` — export new code
- [x] `apps/web/src/store/canvasStore.ts` — `getAgentContext()` fills position/size + spatialSummary
- [x] Build shared, run typecheck

### Phase 1 — Prompt Node Frontend

> **Risk**: Medium (new node type, touches registration + config)  
> **Dependencies**: Phase 0

- [x] Shared types: `PromptNodeData`, `PromptNodeStatus`, `PromptInput`
- [x] Web types: `CanvasPromptNodeData`
- [x] Config: icons (`BadgeQuestionMark`), sizes (`280×160`)
- [x] `PromptNode.tsx` (input + status inlined, not split into sub-components)
- [x] ~~`PromptInputArea.tsx` + `PromptStatusBar.tsx`~~ — decided against splitting; functionality inlined in PromptNode
- [x] Register in `Canvas.tsx` nodeTypes
- [x] `canvasStore`: `pendingNodeType` add `'prompt'`
- [x] NodeToolbar: creation button (`CanvasToolbar.tsx`)
- [x] Build, typecheck, lint

### Phase 2 — Auto-run + Screenshot

> **Risk**: Low (frontend-only, isolated to prompt node)  
> **Dependencies**: Phase 1

- [x] Auto-run timer logic: `usePromptRunner.ts` (blur → pending → auto-fire, default 10s)
- [ ] Configurable delay UI (toolbar selector) — per-node `autoRunDelay` field exists but no UI
- [ ] ~~Eager screenshot capture~~ — deferred (text context is sufficient)
- [ ] ~~Screenshot cache + invalidation~~ — deferred
- [x] `usePromptRunner.ts` — spatial context building + agent execution

### Phase 3 — Agent Execution

> **Risk**: ~~Medium-High~~ Low (reuses existing agent infrastructure)  
> **Dependencies**: Phase 1, Phase 2
>
> **Decision**: Instead of building a separate prompt agent backend, the implementation reuses the existing `/api/agent` endpoint in `ask` mode with spatial context prepended to the message.

- [x] ~~`prompt-agent.route.ts`~~ — not needed; reuses existing `/api/agent`
- [x] ~~`prompt-agent.service.ts`~~ — not needed; reuses existing chat agent
- [x] ~~`prompt-node.ts`~~ — not needed; reuses existing system prompt
- [x] ~~`apps/server/src/app.ts`~~ — no changes needed
- [x] ~~`apps/web/src/api/promptAgent.ts`~~ — not needed; reuses `agentApi.streamMessage()`
- [x] `usePromptRunner.ts` — SSE stream handling, status updates, spatial context serialization
- [x] Lifecycle management — module-level `activeRuns` Map in `usePromptRunner.ts`

### Phase 4 — Integration & Polish

> **Dependencies**: All above

- [ ] End-to-end testing
- [ ] Intent serialization: add spatial descriptions
- [x] `buildNodeSummaries()`: return position data (done in Phase 0)
- [ ] Changelog entry (`docs/user-guide/CHANGELOG.md`)
- [ ] Configurable delay UI selector (`[10s] [30s] [60s] [Off]`)
- [ ] Screenshot capture (vision channel — deferred)

---

## 10. Persistence

### 10.1 What Gets Saved to Canvas JSON

| Field                 | Persisted | Reason                                     |
| --------------------- | --------- | ------------------------------------------ |
| `type: 'prompt'`      | ✅        | Node identity                              |
| `input`               | ✅        | User's question is the core content        |
| `status`              | ✅        | But sanitized on reload (see below)        |
| `autoRunDelay`        | ✅        | User configuration                         |
| `responseSummary`     | ✅        | Preserves results across sessions          |
| `threadId`            | ✅        | History reconstruction                     |
| `errorMessage`        | ✅        | User needs to see last error               |
| `viewed`              | ✅        | Whether user has viewed completed response |
| `runAt`               | ❌        | Epoch timestamp — stale after reload       |
| `activeRuns` (module) | ❌        | AbortController not serializable           |

### 10.2 Status Sanitization on Load

When a canvas is loaded, `running` and `pending` states are no longer valid (the agent process is gone). The store sanitizes on load:

- `running` / `pending` with `responseSummary` → `done` (show previous result)
- `running` / `pending` without `responseSummary` → `idle` (user can re-trigger)
- `runAt` → cleared to `undefined`

### 10.3 Knowledge Base

Prompt nodes **do not enter the knowledge base**. They have no `sourceId`, do not trigger the preprocessing pipeline, and are skipped by `triggerPreprocessing()`. They are interaction artifacts, not content sources.

### 10.4 Agent Visibility

Prompt nodes **are visible** to other agents (chat agent, other prompt nodes) via `get_canvas_state`. Their `type: 'prompt'` distinguishes them from content nodes. This lets agents understand "a user asked a question here" as part of the canvas context.

---

## 11. Open Questions

1. **Multiple re-runs**: When re-running, should previous results (created nodes) be cleaned up automatically, or left in place?
2. **Token budget**: How much spatial context is too much? Benchmark token usage of `SpatialSummary` serialization for large canvases (50+ nodes).
3. ~~**Prompt node creation UX**~~: Resolved — click-to-place via toolbar button (same as note/text/frame).
4. **Screenshot / vision channel**: Deferred. Text-only spatial context is working well. Should vision be added for complex visual layouts?
5. **Configurable delay UI**: The `autoRunDelay` field is supported but has no UI. Should a toolbar selector be built?
6. **Dedicated prompt agent**: Current implementation reuses the chat agent. Should a specialized system prompt be created for better prompt-node-specific reasoning?
