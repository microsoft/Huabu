# Question Node

> Question node (`type: 'question'`): a canvas node that anchors a chat thread
> to a location on the canvas. It carries a **user question** as ordinary
> searchable content and, when asked, runs the agent with the node's spatial
> neighbourhood as context. The conversation is owned by the node and replayable
> in the chat panel.
>
> Originally specced as the "Prompt Node" with blur-triggered auto-run; the
> current implementation drops the auto-run timer in favour of a manual compose
> flow. This doc describes the shipped behaviour.

Like sketch nodes, a question node has two independent relationships with AI:

- **As a content node** (§4): it carries text, never disappears after being
  answered, and is visible to every agent via `get_canvas_outline` /
  `read("nodes/<file>.md")`.
- **As a chat anchor** (§5): the user opens it in the chat panel, picks an agent,
  and sends — the node binds to that thread and runs against its surroundings.

§1–§3 are the shared basics (goals, data model, lifecycle); §6 is the code index.

---

## 1. Goals

| Goal                | Why                                                                      |
| ------------------- | ------------------------------------------------------------------------ |
| Spatial anchoring   | Position _is_ a context signal — the question knows what's around it     |
| Auto-gather context | Connected edges, frame siblings, nearby nodes, no manual selection       |
| Persistent node     | Content stays as a searchable node; answering never deletes it           |
| Manual, explicit    | User composes + sends in the chat panel; no surprise auto-runs           |
| Reuse the agent     | Runs the existing `/api/agent` SSE endpoint, not a question-only backend |

---

## 2. Data model & persistence

`QuestionNodeData` ([node.ts](../../packages/shared/src/types/canvas/node.ts)):

| Field             | Persisted | Notes                                                                                                                                |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `content`         | sidecar   | The question text; stored in `nodes/<safeLabel>.md` body like text/note (`TEXT_BEARING_NODE_TYPES`), stripped from the structure PUT |
| `status`          | ✅        | `idle` / `running` / `done` / `error`                                                                                                |
| `threadId`        | ✅        | Owns one chat thread; minted on first compose                                                                                        |
| `agentBinding`    | ✅        | Internal or external agent, locked on first send                                                                                     |
| `agentMode`       | ✅        | `ask` (default) / `operate` for the internal agent                                                                                   |
| `errorMessage`    | ✅        | Set on `status === 'error'`                                                                                                          |
| `viewed`          | ✅        | Drives the done-unviewed glow                                                                                                        |
| `responseSummary` | reserved  | Teaser field; not yet written by the runner                                                                                          |

Not persisted: the in-flight `AbortController` (module-level in `useAgentStream`).
Question nodes are content nodes: their `content` runs through preprocessing's
`generate_label` (LLM) to auto-name the node — but the profile has no
`persist_source`, so they do **not** enter the knowledge base. They are still
visible to agents (`type: 'question'` in `get_canvas_outline`). See
[node-preprocessing.md](./node-preprocessing.md) for the profile.

---

## 3. Node lifecycle

Created like any node via `ADD_NODES` ([resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)) with `status: 'idle'` and empty `content`. Nothing fires automatically. From there:

- **Idle** → double-click opens compose (§5).
- After sending: **running → done / error**.
- Move / delete / resize / re-frame all go through the normal node flow; a stale
  pasted copy strips transient state so it starts fresh.

Two independent uses branch from here: read as content (§4) or ask in chat (§5).

---

## 4. As a content node

The question text lives in the markdown sidecar, so agents read it like any other
text node — `read("nodes/<file>.md")` returns the body, and `get_canvas_outline`
lists it as `type: 'question'`. No trigger needed; it is just canvas content that
also happens to own a thread.

---

## 5. As a chat anchor — compose & run

### 5.1 Trigger

Double-click the node → `openInCompose()` ([QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)):

- mints a `threadId` if missing, opens the chat panel in **compose mode**
- inherits the canvas's last-used agent binding; user can switch agent
- user types the question, hits send → first send writes `content` back to the node

Toolbar (single action): **Ask** when idle, **View / Watch conversation** once a
thread exists.

### 5.2 Dispatch

All questions run through `/api/agent` ([agent.ts](../../apps/web/src/api/agent.ts) → [intent](../../apps/server/src/modules/canvas/node-neighbourhood.ts)). On first send `useAgentStream` ([useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)) locks `agentBinding` + `agentMode` onto the node:

- **internal**: built-in agent, `agentMode` = `ask` (default) / `operate`
- **external**: ACP agent resolved server-side from `profileId`

`anchorNodeId` is sent so the server attaches spatial context (§5.3).

### 5.3 Spatial context (server-side)

Resolved entirely on the server — no spatial geometry crosses the wire. `renderNodeNeighbourhoodMarkdown(canvasId, anchorNodeId)` ([node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)) walks inside-out (frame → grandframe → canvas) and serialises a priority-tiered neighbourhood into the agent's preamble:

| Priority | Source                       | Detail          | Why                   |
| -------- | ---------------------------- | --------------- | --------------------- |
| P0       | edges touching the node      | full snippet    | explicit user intent  |
| P1       | same-frame siblings          | summary + label | topically related     |
| P2       | distance-sorted nearby nodes | label + snippet | proximity ≈ relevance |

The LLM gets natural-language topology; for exact coordinates it calls
`get_canvas_outline` / `inspect_nodes` on demand.

### 5.4 State machine

```
idle ──double-click──▶ compose (no status change)
                            │ user sends
                            ▼
                        running ──┬─ done event ─▶ done (viewed=false → glow)
                                  └─ error event ─▶ error (errorMessage set)
```

Conversation replay: `openQuestionThread` ([chatStore.ts](../../apps/web/src/store/chatStore.ts)) re-opens a running/finished thread read-only; the node is the single source of truth for the agent mode.

---

## 6. Code entry points

| Concern             | File                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component + toolbar | [QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)                                                                  |
| Compose / replay    | [chatStore.ts](../../apps/web/src/store/chatStore.ts) `openQuestionCompose` / `openQuestionThread`                                                 |
| Send + state writes | [useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)                                                                                    |
| Create path         | [resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)                                                        |
| Dispatch API        | [agent.ts](../../apps/web/src/api/agent.ts) `streamMessage`                                                                                        |
| Spatial context     | [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)                                                                |
| Shared types        | [node.ts](../../packages/shared/src/types/canvas/node.ts) `QuestionNodeData` · [acp.ts](../../packages/shared/src/types/api/acp.ts) `AgentBinding` |

---

## 7. Open questions

- `responseSummary` is reserved but not yet written — node shows no answer teaser.
- Stale `running` on reload: needs sanitisation back to `idle` on `loadCanvas`.
- Vision channel (screenshot of neighbourhood) deferred.
- Re-run cleanup of previously created nodes is undecided.
