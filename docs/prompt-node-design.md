# Question Node — Design Overview

> **Status**: Implemented · **Last updated**: 2026-05-12
>
> Originally designed as the "Prompt Node"; shipped as the **Question Node** (`type: 'question'`). This doc uses the implementation name throughout.

A canvas node carrying a **user question**. On blur it auto-runs the existing chat agent (`ask` mode) using its **spatial position + surrounding context** to gather inputs — no manual node selection or "send" click required.

> **Metaphor**: a sticky note left on a whiteboard. An assistant notices it, reads the surrounding material, and writes back.

---

## 1. Why a node, not just a chat?

The chat panel is **spatially detached** — the user has to manually pick context, and the AI has no awareness of canvas layout. Question nodes:

- **Anchor AI interaction to a location** — position _is_ a context signal.
- **Auto-gather context** — connected edges, frame siblings, nearby nodes.
- **Run in parallel** — multiple questions can fire independently.
- **Reduce friction** — auto-run after a short delay; no "send" button.

---

## 2. Architecture at a glance

```
[QuestionNode.tsx] ──blur──▶ status='pending', runAt=now+10s
        │
        ▼
[useQuestionRunner] ──timer fires──▶ executeQuestionNode(id)
        │                                │
        │                                ├─ build spatial ctx via buildNodeNeighbourhoodContext()
        │                                ├─ prepend as [SYSTEM Context] block
        │                                └─ agentApi.streamMessage(... , 'ask', ...)
        ▼                                            │
   status updates                                    ▼
   (running → done/error)                   /api/agent (existing SSE endpoint)
                                                     │
                                                     ▼
                                       chatStore thread (viewable later)
```

Key files (everything else is a config/registration touchpoint):

| Concern            | File                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| Component          | `apps/web/src/components/Nodes/question/QuestionNode.tsx`                              |
| Auto-run + execute | `apps/web/src/hooks/useQuestionRunner.ts`                                              |
| Create command     | `apps/web/src/handler/canvasCommand/commands/createQuestion.ts`                        |
| Spatial primitives | `apps/server/src/modules/agent/node-neighbourhood.ts` (algorithm + adapter + renderer) |
| Shared types       | `packages/shared/src/types/canvas/node.ts` (`QuestionNodeData`, …)                     |
| Open in chat panel | `apps/web/src/store/chatStore.ts` → `openQuestionThread()`                             |

---

## 3. State machine

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
         │  │                      "Now"  │  │  │
         │  │                             ▼  │  │
         │  │                      ┌─────────┐ │
         │  ├───────────────────── │ running │ │
         │  │                      └──┬───┬──┘ │
         │  │                  success│   │err │
         │  │                         ▼   ▼    │
         │  │                    ┌──────┐ ┌───────┐
         │  └────────────────────│ done │ │ error │
         │                       └──────┘ └───────┘
         │                           │        │
         └───────────────────────────┴────────┘
            double-click on done/error:
              if threadId → open chat panel; else → re-edit
```

Toolbar: **Edit** (idle), **View conversation** (after run), **Cancel** (pending/running), **Run Now** (pending). Default delay 10s; per-node `autoRunDelay` exists in the type but has no UI yet.

Visual: sticky-note style, `var(--question-bg)`, cursive font, status pill (top-left). Done-unviewed adds a glow (`question-node-done-unviewed`); error pill shakes.

---

## 4. Spatial context

Resolved entirely server-side. The frontend posts `{anchorNodeId, canvasId}` to `/api/agent` and the server pipeline in `apps/server/src/modules/agent/node-neighbourhood.ts` does the rest:

1. Adapter loads `canvas.json`, normalises geometry via `buildSpatialBundle` (shared with `get_canvas_outline` / `inspect_nodes`), and extracts a `label > content[:120] > src` snippet per node.
2. **`buildNodeNeighbourhoodContext(target, allNodes, edges, snippets)`** walks inside-out (frame → grandframe → canvas) and produces a `NodeNeighbourhoodContext` made of nested `SpatialLayer`s. Each layer carries the anchor's nearest groups (clusters of co-located nodes) plus connection edges. Three priority signals seed the layers:

| Priority           | Source                       | Detail               | Why                                |
| ------------------ | ---------------------------- | -------------------- | ---------------------------------- |
| **P0 — Connected** | Edges touching question node | Full snippet         | User drew a line = explicit intent |
| **P1 — Siblings**  | Same frame as question node  | Summary + label      | Same group = topically related     |
| **P2 — Nearby**    | Distance-sorted top-N        | Label + snippet only | Proximity ≈ relevance              |

3. Renderer serialises the context as Markdown (`### Inside "X" frame`, `### Canvas Level`, `### Connections`) and the route substitutes it into the Ask agent's `nodeNeighbourhoodPreamble` template.

Neither the prompt wording nor the spatial graph crosses the wire — the web bundle has no spatial computation for the LLM path at all. (UI-only proximity work like annotation clustering still uses shared geometry helpers locally; that's separate.)

> **Two-layer info design**: the LLM gets natural-language topology ("3 nodes in a 2×2 grid"). For precise placement of new nodes, the agent fetches raw coordinates on demand via the existing `get_canvas_outline` / `inspect_nodes` tools.

> **Aside — `getIntentContext`**: the same Phase-0 work also enriched `canvasStore.getIntentContext()` with `position`/`size`/`spatialSummary`, but that serves the **intent-recognition pipeline**, not the question-node execution path. Question nodes never call `getIntentContext`.

---

## 5. Agent execution

**Decision**: reuse the existing `/api/agent` SSE endpoint in `ask` mode rather than build a question-specific backend. Each question node owns one chat thread (`createId('thread')` if missing); the conversation is viewable in the chat panel via `openQuestionThread(nodeId, threadId)`.

`useQuestionRunner.ts`:

- Subscribes to `canvasStore`. For each `pending` question with `runAt`, sets a `setTimeout` for `runAt - now`.
- On fire, re-checks status is still `pending`, then calls `executeQuestionNode`:
  1. Patch `status='running'`, reset `viewed=false`.
  2. Build `[SYSTEM Context]` block from spatial context.
  3. `agentApi.streamMessage(content, threadId, 'ask', callbacks, { canvasId, signal })`.
- SSE events stream silently (not rendered live).
- On `complete` → `status='done'`. On `error` (not aborted) → `status='error'`, `errorMessage` set.

Lifecycle (module-level `Map<nodeId, AbortController>` in the hook, not in the store — `AbortController` isn't serializable):

- User cancels → flip status to `idle` → hook aborts the run.
- Node deleted → store subscription notices → `clearTimeout` + `abortRun`.
- Hook unmounts → clear all timers + abort all runs.

---

## 6. Persistence

Saved to canvas JSON: `type`, `input`, `status`, `autoRunDelay`, `threadId`, `errorMessage`, `viewed`, `responseSummary` (reserved — not yet written by the runner), `runAt` (epoch ms; a stale value re-fires immediately on reload — see §7).

**Not persisted**: the in-memory `activeRuns` map.

**Other notes**:

- Question nodes **don't enter the knowledge base** — no `sourceId`, skipped by `triggerPreprocessing()`. They are interaction artifacts, not content sources.
- Question nodes **are visible to other agents** via `get_canvas_outline` (`type: 'question'` distinguishes them from content nodes).
- `resolvePasteClipboard` strips `responseSummary` (and other transient state) so a pasted copy starts fresh.

---

## 7. Future plans / open questions

1. **Configurable delay UI** — `autoRunDelay` exists in the type but has no toolbar selector (`[10s] [30s] [60s] [Off]`).
2. **Status sanitization on load** — `loadCanvas` should demote stale `pending`/`running` to `idle` (or `done` if a `responseSummary` ever exists) and clear `runAt`. Otherwise the timer re-fires on reopen.
3. **`responseSummary` on the node** — extract a short answer from the SSE stream and patch it back so the node shows a teaser.
4. **Vision channel** — local-screenshot capture is deferred. Worth adding for canvases with strong visual layout cues (color groupings, hand-drawn arrows).
5. **Re-run cleanup** — should previous results (created nodes) be removed when the user re-runs the same question?
6. **Token budget** — benchmark serialized `NodeNeighbourhoodContext` size for large canvases (50+ nodes).
7. **Dedicated system prompt** — currently reuses the chat agent's. A question-node-specific prompt could bias the agent toward placing answers as new notes near the question.
8. **More input kinds** — `QuestionInput` is a discriminated union but only has `'text'`. Planned shapes: `sketch` (hand strokes), `voice` (transcription), `selection` (highlighted nodes). Frontend switches renderer by `input.kind`; backend adapts context-building.
