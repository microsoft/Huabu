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
| `agentBinding`         | ✅        | Acknowledged preparation draft; driver/Profile identity becomes immutable after canonical execution binding                          |
| `agentBindingPolicy`   | ✅        | Optional `selectable` / `fixed`; absent means selectable, while service-created Agent Nodes use fixed before first send              |
| `agentIcon`            | ✅        | External Agent's bind-time avatar fallback; current Profile icon wins while that Profile still exists                                |
| `agentLaunchOverrides` | ✅        | Optional bounded cwd and additional-initial-preamble overrides for a service-created external Agent Node                             |
| `agentMode`            | ✅        | `operate` (default) / `ask` for the internal agent                                                                                   |
| `errorMessage`         | ✅        | Set on `status === 'error'`                                                                                                          |
| `viewed`               | ✅        | Drives unread terminal-state attention on the Agent avatar                                                                           |
| `bindingState`         | ✅        | Server-owned `editing` / `bound`; Bound acknowledges a validated canonical Agenetes record and never demotes                         |
| `invocationToken`      | ✅        | Server-owned current or last admitted prompt identity; fences terminal writes and viewed acknowledgements                            |
| `responseSummary`      | reserved  | Teaser field; not yet written by the runner                                                                                          |

Not persisted: the server invocation phase and cancellation controller, plus the browser's stream controller and request feedback. The complete Node is a read model, not a writable snapshot: ordinary Canvas PUT, commands, and undo omit or preserve the server-owned fields and cannot replace the thread association.
Question nodes are content nodes: their `content` runs through preprocessing's
`generate_label` (LLM) to auto-name the node — but the profile has no
`persist_source`, so they do **not** enter the knowledge base. They are still
visible to agents (`type: 'question'` in `get_space_outline`). See
[node-preprocessing.md](./node-preprocessing.md) for the profile.

Question naming is owned by the canonical node label. The Canvas node, its Preview tab, and its chat header all read that label; existing visual overflow handling is unchanged. Ordinary `generate_label` preprocessing can name an unprotected Question from its content but cannot overwrite a non-empty `user` or `agent` label. Chat titles are independent host metadata (`ThreadRecord.hostMetadata.huabuConversationTitle`, written through `Agenetes.updateHostMetadata`), not a continuing source for Question labels. Late Chat title generation, ACP updates, and panel renames never rename a Question or change its first prompt, status, or transcript. Panel-only conversations persist names on the thread instead of creating hidden nodes; see [Preview Workspace](./preview-workspace.md#2-persisted-model).

---

## 3. Node lifecycle

Saving a panel Chat as a Question uses [saveChatAsQuestion](../../apps/web/src/components/Panels/ChatPanel/saveChatAsQuestion.ts) to copy the current title once into `data.label` through canonical node creation. A current manual title (`source: 'user'`) becomes `labelSource: 'user'`; any nonmanual copied title, including an ACP, generated, or fallback title, becomes `labelSource: 'agent'`, not `auto`, so ordinary preprocessing cannot replace it. Without a current title, the helper preserves the supplied node data and existing node-creation fallback; it invents no title. Conversion stores no separate title-source field and does not recover a hidden automatic title after manual naming. Thereafter naming uses only the node label and the normal node rename path, with no ongoing Chat-title-to-Question synchronization.

Created like any node via `CREATE_NODES` ([resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)) with `nodeType: 'question'` and empty `content`. Missing `status` is the idle state, and nothing fires automatically. From there:

- **Idle** → double-click opens compose (§5).
- An idle node with `agentBindingPolicy: fixed` opens compose with its persisted binding and a read-only Agent selector. Ordinary Editing nodes retain the picker; Bound nodes cannot switch execution identity even when a first control created no messages.
- After sending: **running → done / error**.
- `AgentThreadService` owns lifecycle for every node-backed invocation, regardless of policy. Admission publishes a new token and `running` before dispatch, installs cancellation before slow preparation, and keeps the turn lease through settlement. `AgentNodeLifecycle` fills only freshly read empty, never-submitted content and projects the matching terminal result. Existing content, previous submission tokens, and legacy conversation history prevent follow-ups from replacing authored text.
- Loading and reconnect observe server state; they never infer success from old history or repair status in the browser. A persisted running node without live tracking after restart does not establish an outcome, introduce a new badge, or trigger replay. Existing retry/admission behavior remains unchanged.
- Running uses the bound Agent identity with a flowing information ring; an external Agent avatar body rotates while the built-in Huabu logo remains still.
- A live unresolved ACP permission request temporarily overrides every other badge state, stops working motion, and shows a static warning ring with a shield satellite; resolving or cancelling the request restores the underlying run state.
- Done, error, and conflict attention styling appears only while `viewed === false`; opening or actively watching the finished thread sends its `invocationToken` to the viewed endpoint. The server acknowledges only the matching current terminal result, returning the avatar to a quiet neutral ring. Legacy terminal nodes use an explicit null-token acknowledgement that succeeds only while no new invocation token exists.
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

- confirms server-acknowledged creation (or initializes a legacy node's missing thread association), opens the chat panel in **compose mode**, and defaults the built-in Huabu Agent to `operate`
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

The Agent avatar above the node is also its run-status surface. Compose shows the currently selected Agent inside a question bubble; running uses the flowing ring; unread done/error/conflict outcomes use their semantic ring, glow, and low-frequency attention nudge. Existing Profiles are resolved live, so alias and icon edits update old Question nodes. Saving an external selection stores its alias in `agentBinding` and effective icon in `agentIcon`; those values preserve historical identity if the Profile disappears without copying its complete `customData`. The built-in Agent uses the Huabu brand logo directly and does not persist an avatar snapshot.

As the canvas zooms out, a question node's agent mark **takes over** as the node's stand-in **continuously** ([QuestionTakeoverMark](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx)): the mark's size and position are a smooth (smoothstep-eased) function of the node's on-screen width, so the badge glides from the readable card's top-left corner into a centred stand-in mark and resizes in lock-step with the zoom gesture — there is no discrete stage swap and no one-shot animation. At full zoom it is the sticky card plus a corner badge that scales with the card; as the node shrinks the badge moves corner → centre and resizes; once the node is too small to read, the card fades out (a single binary `data-lod-body` signal) and only the centred mark remains. The mark's glyph is size-driven: a full agent avatar down to a few px, then a solid identity dot (via [AgentAvatarMark](../../apps/web/src/components/Common/AgentAvatarMark.tsx)), so a field of zoomed-out question nodes reads as tidy colour-coded dots. An idle (never-asked) node shows a quiet neutral dot instead of borrowing an agent's identity colour. When the mark can open an existing conversation, it renders as a labelled, keyboard-focusable shared button; non-interactive marks remain hidden from the accessibility tree. Because the collapsed mark hides the node's tiny footprint, dragging the node from the mark is handled by the takeover layer ([useTakeoverMarkDrag](../../apps/web/src/hooks/useTakeoverMarkDrag.ts)) rather than React Flow's native node-drag: a short press still opens the conversation, while a press that crosses the drag-activation distance moves the node (through the normal drag lifecycle) and suppresses the trailing open click. The morph is driven by the takeover engine ([useNodeTakeover](../../apps/web/src/hooks/useNodeTakeover.ts) / [NodeTakeoverLayer](../../apps/web/src/components/Nodes/NodeTakeoverLayer.tsx)); the `open` chat bubble is the shared [QuestionAgentBubble](../../apps/web/src/components/Nodes/question/QuestionAgentBubble.tsx) and status colour is shared via [questionBadgeChrome.ts](../../apps/web/src/components/Nodes/question/questionBadgeChrome.ts). See [canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node](./canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node) and [proposals/question-node-zoom-lod-avatar.md](../proposals/question-node-zoom-lod-avatar.md).

### 5.2 Dispatch

All questions run through `/api/agent` ([agent.ts](../../apps/web/src/api/agent.ts) → [AgentThreadService](../../apps/server/src/modules/agent/agent-thread.service.ts)). `useAgentStream` awaits acknowledged node creation and the latest draft save before resolving the owner-first binding and dispatching:

- **internal**: built-in Huabu Agent, `agentMode` = `operate` (default) / `ask`
- **external**: ACP agent resolved server-side from `profileId`

`anchorNodeId` is sent so the server attaches spatial context (§5.3).

Binding is independent of invocation: first actual prompt or external control realizes a canonical execution record; `AgentNodeBindingCoordinator` validates `agenetes.record(namespace, threadId)` and persists Bound before controls/run. Creating a node, opening compose, and cached capability reads do not realize an execution. Bound survives session closure, preparation failure, stop, and missing records. A failed Canvas promotion leaves the canonical record authoritative; the next guarded edit or interaction completes promotion rather than rebinding. Internal ask/operate remains separate from driver/Profile identity.

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

The owner node persists the initial inherited selection and subsequent Editing draft changes through acknowledged Canvas commands, including mode. `resolveConversationAgentBinding` is shared by panel and send and reads the owner before the ChatStore cache. Saves require an applied command and version-aware reconciliation; a failed or conflicting save prevents dispatch, and a delayed response cannot replay an optimistic patch over newer SSE state. Built-in model/reasoning settings remain cached until a durable thread owns them. The browser owns unsent input and request feedback, not node lifecycle or history-based repair.

### 5.5 Conversation ownership

Ordinary Question previews retain `AgentConversationView`, whose presentation anchor and conversation owner identify the same active Canvas/node; the owner also identifies the Question's thread. Validation checks the live Question type and thread before use. History, reconnect, turns, lifecycle, tools, binding/mode, and change records use that owner scope. The legacy World `nodeRef` shortcut is retired: a view-only Space Preview does not mount or invoke the source Question, so opening its conversation requires entering the source Space.

---

## 6. Code entry points

| Concern              | File                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component + toolbar  | [QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)                                                                                                                                                                                                                                                                             |
| Agent status mark    | [QuestionTakeoverMark.tsx](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx) renders the readable corner badge and the zoomed-out collapsed mark in one component; zoom morph via [NodeTakeoverLayer.tsx](../../apps/web/src/components/Nodes/NodeTakeoverLayer.tsx) + [useNodeTakeover.ts](../../apps/web/src/hooks/useNodeTakeover.ts) |
| Compose / replay     | [questionCompose.ts](../../apps/web/src/components/Nodes/question/questionCompose.ts) and [PreviewRenderer.tsx](../../apps/web/src/components/Panels/PreviewWorkspace/PreviewRenderer.tsx) open the node target and resolve its renderer-local session                                                                                                        |
| Conversation owner   | [conversationOwner.ts](../../apps/web/src/store/conversationOwner.ts) validates ordinary Question ownership, serializes editable draft patches, and sends token-specific viewed acknowledgements                                                                                                                                                              |
| Server-side creation | [agent-node.service.ts](../../apps/server/src/modules/agent/agent-node.service.ts) validates a selectable external Profile and anchor, then creates the fixed-binding Question Node and lineage edge through the canonical Canvas executor                                                                                                                    |
| Thread lookup        | [agent-thread-resolver.ts](../../apps/server/src/modules/agent/agent-thread-resolver.ts) resolves node identity and acknowledged preparation regardless of policy                                                                                                                                                                                             |
| Execution binding    | [agent-node-binding.ts](../../apps/server/src/modules/agent/agent-node-binding.ts) confirms canonical records and guards preparation edits                                                                                                                                                                                                                    |
| Server invocation    | [agent-thread.service.ts](../../apps/server/src/modules/agent/agent-thread.service.ts) owns shared admission, cancellation, dispatch, and settlement; [agent-node-lifecycle.ts](../../apps/server/src/modules/agent/agent-node-lifecycle.ts) projects token-guarded transitions                                                                               |
| RFS Agent access     | [rfs.route.ts](../../apps/server/src/modules/remote_fs/rfs.route.ts) creates visible Agents through `POST /agent` and submits later turns through `POST /agent/:threadId/prompt`; optional parent edges are best effort                                                                                                                                       |
| Open scroll target   | [MessageList.tsx](../../apps/web/src/components/Messages/MessageList.tsx) + [messageListScroll.ts](../../apps/web/src/components/Messages/messageListScroll.ts)                                                                                                                                                                                               |
| Send + observation   | [useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts) awaits drafts and owns transcript/request feedback; [conversationOwner.ts](../../apps/web/src/store/conversationOwner.ts) sends token-specific viewed acknowledgements                                                                                                                        |
| Trusted projection   | [agent-node-projection.ts](../../apps/server/src/modules/canvas/agent-node-projection.ts) composes current FSM state under the Canvas mutex; [agent-node-association.ts](../../apps/server/src/modules/canvas/agent-node-association.ts) validates legacy initialization and undo reinsertion                                                                 |
| Create path          | [resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)                                                                                                                                                                                                                                                                   |
| Dispatch API         | [agent.ts](../../apps/web/src/api/agent.ts) `streamMessage`                                                                                                                                                                                                                                                                                                   |
| Spatial context      | [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)                                                                                                                                                                                                                                                                           |
| Shared types         | [node.ts](../../packages/shared/src/types/canvas/node.ts) `QuestionNodeData` · [acp.ts](../../packages/shared/src/types/api/acp.ts) `AgentBinding`                                                                                                                                                                                                            |

---

## 7. Open questions

- `responseSummary` is reserved but not yet written — node shows no answer teaser.
- Crash recovery and durable invocation-to-turn correlation are outside the node FSM; reads never sanitize a persisted `running` result.
- Vision channel (screenshot of neighbourhood) deferred.
- Re-run cleanup of previously created nodes is undecided.
