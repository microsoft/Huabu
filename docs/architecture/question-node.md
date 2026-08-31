# Question Node

> Question node (`type: 'question'`): a canvas node that anchors a chat thread
> to a location on the Space. It carries a **user question** as ordinary
> searchable content and, when asked, runs the agent with the node's spatial
> neighbourhood as context. The conversation is owned by the node and replayable
> in the chat panel.
>
> Originally specced as the "Prompt Node" with blur-triggered auto-run; the
> current implementation drops the auto-run timer in favour of a manual compose
> flow. This doc describes the shipped behaviour.

Like sketch nodes, a question node has two independent relationships with AI:

- **As a content node** (§4): it carries text, never disappears after being
  answered, and is visible to every agent via `get_space_outline` /
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

| Field                  | Persisted | Notes                                                                                                                                |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `content`              | sidecar   | The question text; stored in `nodes/<safeLabel>.md` body like text/note (`TEXT_BEARING_NODE_TYPES`), stripped from the structure PUT |
| `status`               | ✅        | Optional sparse status: absent means `idle`; non-default values are `running` / `done` / `error`                                     |
| `threadId`             | ✅        | Owns one chat thread; minted on first compose                                                                                        |
| `agentBinding`         | ✅        | Internal or external agent, locked on first send                                                                                     |
| `agentBindingPolicy`   | ✅        | Optional `selectable` / `fixed`; absent means selectable, while service-created Agent Nodes use fixed before first send              |
| `agentIcon`            | ✅        | External Agent's bind-time avatar fallback; current Profile icon wins while that Profile still exists                                |
| `agentLaunchOverrides` | ✅        | Optional bounded cwd and additional-initial-preamble overrides for a service-created external Agent Node                             |
| `agentMode`            | ✅        | `operate` (default) / `ask` for the internal agent                                                                                   |
| `errorMessage`         | ✅        | Set on `status === 'error'`                                                                                                          |
| `viewed`               | ✅        | Drives unread terminal-state attention on the Agent avatar                                                                           |
| `responseSummary`      | reserved  | Teaser field; not yet written by the runner                                                                                          |

Not persisted: the in-flight `AbortController` (module-level in `useAgentStream`).
Question nodes are content nodes: their `content` runs through preprocessing's
`generate_label` (LLM) to auto-name the node — but the profile has no
`persist_source`, so they do **not** enter the knowledge base. They are still
visible to agents (`type: 'question'` in `get_space_outline`). See
[node-preprocessing.md](./node-preprocessing.md) for the profile.

---

## 3. Node lifecycle

Created like any node via `CREATE_NODES` ([resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)) with `nodeType: 'question'` and empty `content`. Missing `status` is the idle state, and nothing fires automatically. From there:

- **Idle** → double-click opens compose (§5).
- An idle node with `agentBindingPolicy: fixed` opens compose with its persisted binding and a read-only Agent selector; ordinary nodes with an absent or `selectable` policy retain the existing pre-send picker.
- After sending: **running → done / error**.
- For fixed Agent Nodes, `AgentThreadService` resolves the persisted binding, writes first content and `status` / `errorMessage` through the server Canvas executor, and applies launch overrides before the first ACP realization. The Web client writes only `viewed`; selectable Question Nodes retain the existing client-authored lifecycle.
- Selectable Question Node lifecycle patches are optimistically reflected in the active Canvas and persisted through the canonical Canvas executor. Loading never infers `done` merely from `threadId` plus authored content because a persisted conversation may terminate in `error`; legacy nodes with an unknown status stay neutral but remain reopenable.
- Running uses the bound Agent identity with a flowing information ring; an external Agent avatar body rotates while the built-in Huabu logo remains still.
- A live unresolved ACP permission request temporarily overrides every other badge state, stops working motion, and shows a static warning ring with a shield satellite; resolving or cancelling the request restores the underlying run state.
- Done, error, and conflict attention styling appears only while `viewed === false`; opening the finished thread marks it viewed and returns the avatar to a quiet neutral ring.
- Move / delete / resize / re-frame all go through the normal node flow; a stale
  pasted copy strips transient state so it starts fresh.
- **Create-time selection**: a question node does **not** auto-select when born
  from the compose / preprocess flow (those focus the chat input, so the canvas
  must not steal focus) — this is the default in [createNodes.ts](../../packages/shared/src/canvas-engine/commands/createNodes.ts). Paste / duplicate is the exception: [resolvePasteClipboard.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolvePasteClipboard.ts) sets `selectOnCreate: true`, which overrides that default so the pasted copy is selected like any other pasted node.
- Question height is content-driven like text nodes. Drag-resize may use the
  transient box height to derive a locked `data.style.fontSize`, but the node's
  top-level `style.height` is not persisted. The floating toolbar therefore
  exposes width + font size for question/text nodes rather than an editable
  height field.

Two independent uses branch from here: read as content (§4) or ask in chat (§5).

---

## 4. As a content node

The question text lives in the markdown sidecar, so agents read it like any other
text node — `read("nodes/<file>.md")` returns the body, and `get_space_outline`
lists it as `type: 'question'`. No trigger needed; it is just canvas content that
also happens to own a thread.

The sidecar body holds only the **first** user prompt, so canvas search (Cmd+F)
also has a dedicated **`conversation`** tier
([canvas-search.ts](../../apps/server/src/modules/canvas/canvas-search.ts)): it
follows the node's `threadId` into `<threadId>.turns.jsonl` and matches every
user message + assistant reply across all turns, deliberately skipping tool
calls / results. Only question nodes carry a `threadId`, so threads not anchored
to a node are out of search scope.

Activating a `conversation` result row ([CanvasSearchResults.tsx](../../apps/web/src/components/Panels/CanvasLayerPanel/CanvasSearchResults.tsx)) focuses the node on the canvas **and** opens its Question target through `openPreviewNode`, then highlights the query and scrolls the matched message into view inside the mounted tab — the chat scroller is tagged `data-chat-thread-root` so the shared highlight / `scheduleScrollToMatch` helpers can target it, mirroring how preview-body matches are handled.

---

## 5. As a chat anchor — compose & run

### 5.1 Trigger

Double-click the node → `openInCompose()` ([QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)). Creating a question through the toolbar placement flow or the connected-node picker also mints the thread and opens compose immediately. [`questionCompose.ts`](../../apps/web/src/components/Nodes/question/questionCompose.ts) opens the Question's Preview Workspace node tab and directs the input-focus request to that thread.

- mints a `threadId` if missing, opens the chat panel in **compose mode**, and defaults the built-in Huabu Agent to `operate`
- inherits the canvas's last-used agent binding; user can switch agent
- user types the question, hits send → first send writes `content` back to the node

Toolbar (single action): **Ask** when idle, **View / Watch conversation** once a
thread exists.

While the chat panel is expanded and viewing or composing a question node
thread, the canvas renders four glowing corners outside that node
([QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)).
This is an informational "active chat anchor" affordance only: it does not set
React Flow selection, does not show editing toolbars, does not cover the
question status badge, and does not affect which selected nodes are sent as
additional chat context.

The chat panel header is the question node's rename surface in both compose and replay modes. Clicking the title (or focusing it and pressing Enter/Space) opens the same inline editor used by expanded content nodes; blur/Enter commits through `canvasStore.tryRename('node', ...)`, Escape cancels, and the shared rename path owns collision detection, persistence, and rollback. A fresh compose view continues to show the neutral “New question” title until the user assigns a name.

The Agent avatar above the node is also its run-status surface. Compose shows the currently selected Agent inside a question bubble; running uses the flowing ring; unread done/error/conflict outcomes use their semantic ring, glow, and low-frequency attention nudge. Existing Profiles are resolved live, so alias and icon edits update old Question nodes. For an external Agent, the first send also stores the current alias in `agentBinding` and the effective icon in `agentIcon`; if the Profile is later deleted or unavailable, those bind-time values preserve the historical identity without copying the Profile's full `customData` bag into the node. The built-in Agent uses the Huabu brand logo directly and does not persist an avatar snapshot.

As the canvas zooms out, a question node's agent mark **takes over** as the node's stand-in **continuously** ([QuestionTakeoverMark](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx)): the mark's size and position are a smooth (smoothstep-eased) function of the node's on-screen width, so the badge glides from the readable card's top-left corner into a centred stand-in mark and resizes in lock-step with the zoom gesture — there is no discrete stage swap and no one-shot animation. At full zoom it is the sticky card plus a corner badge that scales with the card; as the node shrinks the badge moves corner → centre and resizes; once the node is too small to read, the card fades out (a single binary `data-lod-body` signal) and only the centred mark remains. The mark's glyph is size-driven: a full agent avatar down to a few px, then a solid identity dot (via [AgentAvatarMark](../../apps/web/src/components/Common/AgentAvatarMark.tsx)), so a field of zoomed-out question nodes reads as tidy colour-coded dots. An idle (never-asked) node shows a quiet neutral dot instead of borrowing an agent's identity colour. When the mark can open an existing conversation, it renders as a labelled, keyboard-focusable shared button; non-interactive marks remain hidden from the accessibility tree. Because the collapsed mark hides the node's tiny footprint, dragging the node from the mark is handled by the takeover layer ([useTakeoverMarkDrag](../../apps/web/src/hooks/useTakeoverMarkDrag.ts)) rather than React Flow's native node-drag: a short press still opens the conversation, while a press that crosses the drag-activation distance moves the node (through the normal drag lifecycle) and suppresses the trailing open click. The morph is driven by the takeover engine ([useNodeTakeover](../../apps/web/src/hooks/useNodeTakeover.ts) / [NodeTakeoverLayer](../../apps/web/src/components/Nodes/NodeTakeoverLayer.tsx)); the `open` chat bubble is the shared [QuestionAgentBubble](../../apps/web/src/components/Nodes/question/QuestionAgentBubble.tsx) and status colour is shared via [questionBadgeChrome.ts](../../apps/web/src/components/Nodes/question/questionBadgeChrome.ts). See [canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node](./canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node) and [proposals/question-node-zoom-lod-avatar.md](../proposals/question-node-zoom-lod-avatar.md).

### 5.2 Dispatch

All questions run through `/api/agent` ([agent.ts](../../apps/web/src/api/agent.ts) → [intent](../../apps/server/src/modules/canvas/node-neighbourhood.ts)). On first send `useAgentStream` ([useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)) locks `agentBinding` + `agentMode` onto the node:

- **internal**: built-in Huabu Agent, `agentMode` = `operate` (default) / `ask`
- **external**: ACP agent resolved server-side from `profileId`

`anchorNodeId` is sent so the server attaches spatial context (§5.3).

### 5.3 Spatial context (server-side)

Resolved entirely on the server — no spatial geometry crosses the wire. `renderNodeNeighbourhoodMarkdown(canvasId, anchorNodeId)` ([node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)) serialises a bounded, priority-tiered neighbourhood into the agent's preamble:

| Priority | Source                                              | Inclusion rule                              | Why                                  |
| -------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| P0       | nodes connected directly to the anchor              | always, regardless of distance              | explicit user intent                 |
| P1       | the direct containing Frame and its direct siblings | always, regardless of distance              | preserves the anchor's local context |
| P2       | other distance-sorted spatial neighbours            | at most 400 px edge-to-edge from the anchor | bounds prompt token consumption      |

The LLM gets natural-language topology; for exact coordinates it calls
`get_space_outline` / `inspect_nodes` on demand.

### 5.4 State machine

```text
idle ──double-click──▶ compose (no status change)
                            │ user sends
                            ▼
                        running ──┬─ done event ─▶ done (viewed=false → glow)
                                  └─ error event ─▶ error (errorMessage set)
```

Conversation replay: `openPreviewNode` activates the Question's semantic target, and [`PreviewRenderer.tsx`](../../apps/web/src/components/Panels/PreviewWorkspace/PreviewRenderer.tsx) resolves the live node into a required `ChatSession`. The node is the single source of truth for agent mode. An unresolved permission renders one actionable tray above ChatInput while its original MessageList position remains a passive history record. Messages, loading, drafts, binding, settings, and pending attachments are keyed by the session's thread, so two Question tabs can remain mounted without sharing presentation state.

Before the first send, the thread's binding, mode, and built-in settings remain in the persisted Chat compose cache so an idle Question survives reload. Once the first send locks binding and mode onto the Question node, their cached mirrors are removed; built-in settings remain cached until the first server event confirms that the durable thread now owns them. Conversation history and built-in settings for an established thread remain server-owned.

### 5.5 World presentation

A World `nodeRef` may present a source question in its own Preview Workspace tab without loading the source Canvas. `AgentConversationView` separates the World presentation anchor from the source conversation owner. History, reconnect, turns, lifecycle, tools, binding/mode, and change records use the source `{ canvasId, nodeId, threadId }`; World selection is omitted and the source question is the request anchor. The reference never mints a thread, and a source question without `threadId` is surfaced as an integrity error. Opening the owner Space passes a one-shot router intent that opens the source Question tab after its Canvas loads.

---

## 6. Code entry points

| Concern              | File                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component + toolbar  | [QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)                                                                                                                                                                                                                                                                                |
| Agent status mark    | [QuestionTakeoverMark.tsx](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx) renders the readable corner badge and the zoomed-out collapsed mark in one component; zoom morph via [NodeTakeoverLayer.tsx](../../apps/web/src/components/Nodes/NodeTakeoverLayer.tsx) + [useNodeTakeover.ts](../../apps/web/src/hooks/useNodeTakeover.ts)    |
| Compose / replay     | [questionCompose.ts](../../apps/web/src/components/Nodes/question/questionCompose.ts) and [PreviewRenderer.tsx](../../apps/web/src/components/Panels/PreviewWorkspace/PreviewRenderer.tsx) open the node target and resolve its renderer-local session                                                                                                           |
| Cross-Canvas owner   | [conversationOwner.ts](../../apps/web/src/store/conversationOwner.ts) resolves presentation/owner addresses and routes headless lifecycle mutations                                                                                                                                                                                                              |
| Server-side creation | [agent-node.service.ts](../../apps/server/src/modules/agent/agent-node.service.ts) validates a selectable external Profile and anchor, then creates the fixed-binding Question Node and lineage edge through the canonical Canvas executor                                                                                                                       |
| Fixed-thread lookup  | [agent-thread-resolver.ts](../../apps/server/src/modules/agent/agent-thread-resolver.ts) is the thin Canvas-scan boundary for resolving a fixed Agent Node by thread; a Workspace-global DB index will replace only its storage lookup after issue #60                                                                                                           |
| Server invocation    | [agent-thread.service.ts](../../apps/server/src/modules/agent/agent-thread.service.ts) resolves fixed identity for UI and RFS, owns shared lease/stop/dispatch, and wraps runs with [agent-node-lifecycle.ts](../../apps/server/src/modules/agent/agent-node-lifecycle.ts) first-content, running, done, and error patches through the canonical Canvas executor |
| RFS Agent access     | [rfs.route.ts](../../apps/server/src/modules/remote_fs/rfs.route.ts) creates visible Agents through `POST /agent` and submits later turns through `POST /agent/:threadId/prompt`; optional parent edges are best effort                                                                                                                                          |
| Open scroll target   | [MessageList.tsx](../../apps/web/src/components/Messages/MessageList.tsx) + [messageListScroll.ts](../../apps/web/src/components/Messages/messageListScroll.ts)                                                                                                                                                                                                  |
| Send + state writes  | [useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts) owns selectable-node lifecycle and client `viewed` state; it does not write fixed-node content, status, or errors                                                                                                                                                                                |
| Create path          | [resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)                                                                                                                                                                                                                                                                      |
| Dispatch API         | [agent.ts](../../apps/web/src/api/agent.ts) `streamMessage`                                                                                                                                                                                                                                                                                                      |
| Spatial context      | [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)                                                                                                                                                                                                                                                                              |
| Shared types         | [node.ts](../../packages/shared/src/types/canvas/node.ts) `QuestionNodeData` · [acp.ts](../../packages/shared/src/types/api/acp.ts) `AgentBinding`                                                                                                                                                                                                               |

---

## 7. Open questions

- `responseSummary` is reserved but not yet written — node shows no answer teaser.
- Stale `running` on reload: needs sanitisation back to `idle` on `loadCanvas`.
- Vision channel (screenshot of neighbourhood) deferred.
- Re-run cleanup of previously created nodes is undecided.
