# Prompt Node — Design Document

> **Status**: In Progress  
> **Date**: 2026-04-10

---

## 1. Overview

### 1.1 What

A new canvas node type — **Prompt Node** — that serves as an AI interaction medium embedded directly on the canvas. Unlike content nodes (note, text, pdf, etc.), a prompt node carries a **user question or intent**, and uses its **spatial position and surrounding context** to invoke a dedicated AI agent that reasons about the canvas.

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
rectDistance(a: Rect, b: Rect): number           // center-to-center
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

// For prompt node — focused context around a specific node
buildPromptNodeContext(
  promptNode: SpatialNode,
  allNodes: SpatialNode[],
  edges: Array<{ source: string; target: string }>,
  nodeLabels: Map<string, string>,
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

interface PromptSpatialContext {
  groups: SpatialGroup[];
  relevantEdges: Array<{ source: string; target: string; label?: string }>;
  semanticPosition: string; // e.g. "between Group A and Group B"
}

interface SpatialGroup {
  direction: CardinalDirection; // relative to prompt node
  arrangement: string;
  nodes: Array<{ id: string; type: string; label?: string; snippet?: string }>;
}
```

### 2.3 Context Flow Changes

#### `getAgentContext()` (canvasStore)

Populate `position` and `size` on every `NodeSummary`, and include a new `spatialSummary` field computed via `buildSpatialSummary()`.

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
├── PromptNode.tsx          ← Main component
├── PromptInputArea.tsx     ← Extensible input (text for now)
└── PromptStatusBar.tsx     ← Countdown / spinner / done / error
```

### 4.2 Visual Design

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐   ← dashed border (distinct from content nodes)
  💡                                      ← icon: Sparkles or Lightbulb
│                                     │
  AI 如何 Support这个过程？
│                                     │
├─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
│ ⏳ Running in 24s    [▶ Now]  [✕]  │   ← status bar (only when pending)
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

States:

- **idle** (empty): Placeholder "Ask a question..." — no status bar
- **idle** (has content): Shows content — no status bar
- **pending**: Content readonly + countdown bar with "▶ Now" and "✕"
- **running**: Content readonly + spinner "Thinking..."
- **done**: Content readonly + "✓ Done" + response summary below
- **error**: Content readonly + "✗ Error" + error message

Accent color: distinct warm tone (e.g. amber) to differentiate from content nodes.

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
  click  │  │ (cancels timer/agent)    or │  │  │
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
                    (double-click to re-edit)
```

### 4.4 Auto-run Timer

```typescript
const DEFAULT_AUTO_RUN_DELAY = 30; // seconds

// On blur:
//   1. Commit input text
//   2. Eager-capture viewport screenshot
//   3. Set status='pending', runAt=Date.now() + delay*1000

// useEffect watches status==='pending':
//   - setTimeout for (runAt - now) ms
//   - On fire: call run(nodeId)
//   - Cleanup: clearTimeout on unmount or status change

// On double-click during pending:
//   - Cancel timer (set status='idle', runAt=undefined)
//   - Enter edit mode
```

Per-node configurable via toolbar: `[10s] [30s] [60s] [Off]`  
`Off` = manual-only mode — shows a "▶ Run" button instead.

### 4.5 Config Updates

| File                  | Change                                  |
| --------------------- | --------------------------------------- |
| `config/nodeIcons.ts` | `prompt: Sparkles`                      |
| `config/nodeSizes.ts` | `prompt: { width: 280, height: 160 }`   |
| `Canvas.tsx`          | `nodeTypes.prompt = PromptNode`         |
| `canvasStore.ts`      | `pendingNodeType` union adds `'prompt'` |
| NodeToolbar           | Add prompt node creation button         |

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

### 5.3 Eager Screenshot Capture

**Problem**: When the user clicks "Run" (or auto-run fires), the viewport may have moved away from the prompt node, making screenshot capture unreliable.

**Solution**: Capture screenshot at **blur time** (when the user finishes editing), not at run time.

```
Edit prompt node → blur
  ├── ① Commit text input
  ├── ② requestIdleCallback → capture local viewport screenshot
  ├── ③ Store in memory (_cachedScreenshot, not persisted to JSON)
  └── ④ Start countdown timer

... user may pan viewport elsewhere ...

Auto-run fires (or user clicks ▶ Now)
  └── Use cached screenshot from blur ✅ (viewport-independent)
```

**Invalidation**: If nearby nodes are moved/edited/deleted after capture, clear the cached screenshot. The text layer still provides complete spatial information.

**Adaptive viewport sizing**: Expand capture area to include at least N nearby nodes:

```typescript
function adaptivePadding(
  target,
  allNodes,
  minNodes = 5,
  maxPadding = 800,
): number {
  const sorted = findNearbyNodes(target, allNodes);
  if (sorted.length === 0) return 200;
  const idx = Math.min(minNodes - 1, sorted.length - 1);
  return Math.min(sorted[idx].distance + 100, maxPadding);
}
```

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

## 6. Prompt Node — Agent Backend (Phase 3)

### 6.1 Endpoint

```
POST /api/agent/prompt            ← Start prompt node agent run (SSE)
POST /api/agent/prompt/stop       ← Stop a running prompt node agent
```

### 6.2 Request Schema

```typescript
interface PromptAgentRequest {
  canvasId: string;
  nodeId: string;
  input: PromptInput;
  spatialContext: PromptSpatialContext; // pre-computed by frontend
  screenshot?: string; // base64 PNG, best-effort
}
```

### 6.3 Agent Design

- **Separate from chat agent** — own thread per prompt node, own system prompt
- **Reuses existing tools** — `get_node_detail`, `canvas_commands`, `web_search`, `search_knowledge`, etc.
- **System prompt emphasis**:
  - Spatial context is first-class information
  - Prefer creating/placing results near the prompt node
  - Can read full node content on demand via tools
  - Response summary should be concise (shown on the node)
- **Result**: Text response (→ `responseSummary`) + optional canvas commands (create nodes, edges, etc.)

### 6.4 SSE Events

Reuses existing `AgentStreamEvent` types:

- `text_delta` → accumulates into `responseSummary`
- `tool_start` / `tool_result` → canvas commands applied immediately
- `done` → status = `'done'`
- `error` → status = `'error'`, message stored in `errorMessage`

### 6.5 Lifecycle Management

```typescript
// canvasStore additions
activePromptRuns: Map<string, AbortController>;

// On run start:
activePromptRuns.set(nodeId, abortController);

// On completion/error:
activePromptRuns.delete(nodeId);

// On node deletion (in deleteNodes):
for (const id of nodeIds) {
  const run = activePromptRuns.get(id);
  if (run) {
    run.abort(); // frontend: cancel SSE
    agentApi.stopPromptRun(id); // backend: terminate agent
    activePromptRuns.delete(id);
  }
}
```

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

Frontend: `PromptInputArea.tsx` switches renderer by `input.kind`.  
Backend: Agent selects system prompt / tool set by `input.kind`.

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

| Path                                                       | Purpose                               |
| ---------------------------------------------------------- | ------------------------------------- |
| `packages/shared/src/utils/spatial.ts`                     | Spatial geometry primitives + queries |
| `apps/web/src/components/Nodes/prompt/PromptNode.tsx`      | Main prompt node component            |
| `apps/web/src/components/Nodes/prompt/PromptInputArea.tsx` | Extensible input area                 |
| `apps/web/src/components/Nodes/prompt/PromptStatusBar.tsx` | Status/countdown UI                   |
| `apps/web/src/hooks/usePromptAgent.ts`                     | Run/stop/context-gathering hook       |
| `apps/web/src/api/promptAgent.ts`                          | API client for prompt agent endpoints |
| `apps/server/src/modules/agent/prompt-agent.route.ts`      | HTTP endpoints                        |
| `apps/server/src/modules/agent/prompt-agent.service.ts`    | Agent execution logic                 |
| `apps/server/src/prompt/prompt-node.ts`                    | System prompt for prompt agent        |

### Modified Files

| Path                                               | Change                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/types/canvas/node.ts`         | Add `PromptNodeData`, `PromptNodeStatus`, `PromptInput`                                                                                                |
| `packages/shared/src/types/context.ts`             | Add `position?/size?` to `NodeSummary`/`SelectedNodeDetail`; add `SpatialSummary`, `PromptSpatialContext`                                              |
| `packages/shared/src/index.ts`                     | Export new types + spatial utils                                                                                                                       |
| `apps/web/src/components/Nodes/types.ts`           | Add `CanvasPromptNodeData` to union                                                                                                                    |
| `apps/web/src/components/Panels/Canvas/Canvas.tsx` | Register `prompt` in `nodeTypes`                                                                                                                       |
| `apps/web/src/config/nodeIcons.ts`                 | Add `prompt` icon                                                                                                                                      |
| `apps/web/src/config/nodeSizes.ts`                 | Add `prompt` default size                                                                                                                              |
| `apps/web/src/store/canvasStore.ts`                | `pendingNodeType` adds `'prompt'`; `getAgentContext()` adds position/size + spatialSummary; `deleteNodes` hook for active runs; `activePromptRuns` map |
| `apps/server/src/app.ts`                           | Register prompt-agent routes                                                                                                                           |
| NodeToolbar (TBD)                                  | Add prompt node creation button                                                                                                                        |

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
- [x] Config: icons, sizes
- [x] `PromptNode.tsx` (input + status inlined, not split into sub-components)
- [ ] `PromptInputArea.tsx` + `PromptStatusBar.tsx` — not split out (functionality inlined in PromptNode)
- [x] Register in `Canvas.tsx` nodeTypes
- [x] `canvasStore`: `pendingNodeType` add `'prompt'`
- [x] NodeToolbar: creation button (`CanvasToolbar.tsx`)
- [x] Build, typecheck, lint

### Phase 2 — Auto-run + Screenshot

> **Risk**: Low (frontend-only, isolated to prompt node)  
> **Dependencies**: Phase 1

- [ ] Auto-run timer logic in PromptNode (blur → pending → auto-fire)
- [ ] Configurable delay (toolbar selector)
- [x] Eager screenshot capture on blur (`captureLocalViewport()` in PromptNode)
- [ ] Screenshot cache + invalidation
- [ ] `usePromptAgent.ts` — spatial context building + screenshot management

### Phase 3 — Backend Agent

> **Risk**: Medium-High (new SSE endpoint, agent loop)  
> **Dependencies**: Phase 1, Phase 2

- [ ] `prompt-agent.route.ts` — POST /api/agent/prompt, POST /api/agent/prompt/stop
- [ ] `prompt-agent.service.ts` — agent loop (reuses pi-ai + existing tools)
- [ ] `prompt-node.ts` — system prompt with spatial context instructions
- [ ] `apps/server/src/app.ts` — register routes
- [ ] `apps/web/src/api/promptAgent.ts` — API client
- [ ] `usePromptAgent.ts` — SSE stream handling, status updates
- [ ] `canvasStore` — lifecycle management (activePromptRuns, delete hook)

> ⚠️ Phase 3 is entirely unstarted — this is the critical path to making prompt nodes functional.

### Phase 4 — Integration & Polish

> **Dependencies**: All above

- [ ] End-to-end testing
- [ ] Intent serialization: add spatial descriptions
- [x] `buildNodeSummaries()`: return position data (done in Phase 0)
- [ ] Changelog entry (`docs/user-guide/CHANGELOG.md`)

---

## 10. Persistence

### 10.1 What Gets Saved to Canvas JSON

| Field                      | Persisted | Reason                                      |
| -------------------------- | --------- | ------------------------------------------- |
| `type: 'prompt'`           | ✅        | Node identity                               |
| `input`                    | ✅        | User's question is the core content         |
| `status`                   | ✅        | But sanitized on reload (see below)         |
| `autoRunDelay`             | ✅        | User configuration                          |
| `responseSummary`          | ✅        | Preserves results across sessions           |
| `threadId`                 | ✅        | History reconstruction                      |
| `errorMessage`             | ✅        | User needs to see last error                |
| `runAt`                    | ❌        | Epoch timestamp — stale after reload        |
| `_cachedScreenshot`        | ❌        | Memory-only (too large for JSON, transient) |
| `activePromptRuns` (store) | ❌        | AbortController not serializable            |

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
3. **Prompt node creation UX**: Click-to-place (like text/note)? Or a different gesture (e.g. right-click → "Ask here")?
