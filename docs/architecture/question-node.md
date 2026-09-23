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

| Field                     | Persisted | Notes                                                                                                                                |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `content`                 | sidecar   | The question text; stored in `nodes/<safeLabel>.md` body like text/note (`TEXT_BEARING_NODE_TYPES`), stripped from the structure PUT |
| `status`                  | ✅        | Optional sparse status: absent means `idle`; non-default values are `running` / `done` / `error`                                     |
| `threadId`                | ✅        | Owns one chat thread; minted on first compose                                                                                        |
| `conversationTitleSource` | ✅        | Server-owned naming provenance (`user` / `generated` / `acp` / `fallback` / null); the title value remains the canonical `label`     |
| `agentBinding`            | ✅        | Acknowledged preparation draft; driver/Profile identity becomes immutable after canonical execution binding                          |
| `agentBindingPolicy`      | ✅        | Optional `selectable` / `fixed`; absent means selectable, while service-created Agent Nodes use fixed before first send              |
| `agentIcon`               | ✅        | External Agent's bind-time avatar fallback; current Profile icon wins while that Profile still exists                                |
| `agentLaunchOverrides`    | ✅        | Optional bounded cwd and additional-initial-preamble overrides for a service-created external Agent Node                             |
| `agentMode`               | ✅        | `operate` (default) / `ask` for the internal agent                                                                                   |
| `errorMessage`            | ✅        | Set on `status === 'error'`                                                                                                          |
| `viewed`                  | ✅        | Drives unread terminal-state attention on the Agent avatar                                                                           |
| `bindingState`            | ✅        | Server-owned `editing` / `bound`; Bound acknowledges a validated canonical Agenetes record and never demotes                         |
| `invocationToken`         | ✅        | Server-owned current or last admitted prompt identity; fences terminal writes and viewed acknowledgements                            |
| `responseSummary`         | reserved  | Teaser field; not yet written by the runner                                                                                          |
| `pendingInkIntentLabel`   | ✅        | Marks only a newly created Ink Question whose placeholder may be replaced by the first structured inferred intent                    |

Not persisted: the server invocation phase and cancellation controller, plus the browser's stream controller and request feedback. The complete Node is a read model, not a writable snapshot: ordinary Canvas PUT, commands, and undo omit or preserve the server-owned fields and cannot replace the thread association.
Question nodes are content nodes: preprocessing delegates their `content` to `ConversationTitleService.initializeQuestion()` rather than running a separate `generate_label` stage. The profile has no `persist_source`, so Questions do **not** enter the knowledge base. They remain visible to agents (`type: 'question'` in `get_space_outline`). See [node-preprocessing.md](./node-preprocessing.md) for the profile and option gates.

Question naming uses the same `ConversationTitleService` as panel Chat, with one storage authority per conversation. For a Question, the canonical node `label` supplies its Canvas, Preview tab, chat header, and title-query value; `conversationTitleSource` records provenance, not another title. Panel-only conversations use `ThreadRecord.hostMetadata.huabuConversationTitle` instead of hidden nodes. The service resolves current Question ownership on reads and writes, so thread metadata is not a second authority after conversion. Automatic names use `labelSource: 'auto'` with priority `user > generated > acp > fallback`; non-empty `user` or `agent` labels remain protected. Generation and ACP updates can continue naming an eligible Question but never change its first prompt, status, or transcript. Ordinary Canvas edits and undo cannot replace `conversationTitleSource`; trusted title writes use the canonical Canvas persistence and sync path. See [shared conversation naming](./agent-architecture.md#panel-conversation-titles).

---

## 3. Node lifecycle

Automatic Question naming compares safe filenames to detect collisions but preserves the original display title, including punctuation. When a collision requires a suffix such as ` (2)`, the suffix is appended to the original title rather than replacing it with the sanitized filename. Storage path safety remains owned by the canonical persistence path.

Saving a panel Chat as a Question uses [saveChatAsQuestion](../../apps/web/src/components/Panels/ChatPanel/saveChatAsQuestion.ts) and canonical node creation to transfer naming authority to the node. A manual title becomes `labelSource: 'user'`; an ACP, generated, or fallback title becomes `labelSource: 'auto'`, with its provenance in `conversationTitleSource`. At creation the server adopts the latest effective thread title when the incoming node label is not user/agent-protected, rather than treating a stale browser cache as authoritative. Without a current title, the helper preserves the supplied node data and existing node-creation fallback. Later in-flight generation and ACP updates resolve the new Question owner and update its canonical label when priority and current-label protection permit; this is one naming service writing the current owner, not ongoing synchronization between two title values. Manual naming retains no hidden automatic candidate.

Created like any node via `CREATE_NODES` ([resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)) with `nodeType: 'question'` and empty `content`. Missing `status` is the idle state, and nothing fires automatically. From there:

- **Idle** → double-click opens compose (§5).
- An idle node with `agentBindingPolicy: fixed` opens compose with its persisted binding and a read-only Agent selector. Ordinary Editing nodes retain the picker; Bound nodes cannot switch execution identity even when a first control created no messages.
- After sending: **running → done / error**.
- `AgentThreadService` owns lifecycle for every node-backed invocation, regardless of policy. Admission publishes a new token and `running` before dispatch, installs cancellation before slow preparation, and keeps the turn lease through settlement. `AgentNodeLifecycle` fills only freshly read empty, never-submitted content and projects the matching terminal result. Existing content, previous submission tokens, and legacy conversation history prevent follow-ups from replacing authored text.
- Loading and reconnect observe server state; they never infer success from old history or repair status in the browser. A persisted running node without live tracking after restart does not establish an outcome, introduce a new badge, or trigger replay. Existing retry/admission behavior remains unchanged.
- The readable compact card shows the bound Agent avatar and alias at the upper left, a small status pill at the upper right, and the question below. Running uses an information-colored pill with a loading glyph. The collapsed Agent mark retains its existing ring and identity animation.
- A live unresolved ACP permission request temporarily overrides every other badge state, stops working motion, and shows a warning shield pill (or the existing shield satellite on the collapsed mark); resolving or cancelling the request restores the underlying run state.
- Done, error, and conflict attention styling appears only while `viewed === false`; opening or actively watching the finished thread sends its `invocationToken` to the viewed endpoint. The server acknowledges only the matching current terminal result, returning the avatar to a quiet neutral ring. Legacy terminal nodes use an explicit null-token acknowledgement that succeeds only while no new invocation token exists.
- Move / delete / resize / re-frame all go through the normal node flow; a stale
  pasted copy strips transient state so it starts fresh.
- **Create-time selection**: a question node does **not** auto-select when born
  from the compose / preprocess flow (those focus the chat input, so the canvas
  must not steal focus) — this is the default in [createNodes.ts](../../packages/shared/src/canvas-engine/commands/createNodes.ts). Paste / duplicate is the exception: [resolvePasteClipboard.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolvePasteClipboard.ts) sets `selectOnCreate: true`, which overrides that default so the pasted copy is selected like any other pasted node.
- Question height is content-driven. Like Text, it uses `fontSizing: 'proportional'` through `useTextNodeSurface` / `useTextAutoSize`: a finite positive `data.style.fontSize` sets the content scale, otherwise `QUESTION_NODE_DEFAULT_FONT_SIZE` supplies the Question-only 24px default (Text defaults to 16px; other card titles remain 28px). Insets, header geometry, and radius retain their 28px design basis, so the default Question becomes proportionally more compact while explicit stored fonts keep their existing geometry. Ordinary native transparent left/right line controls use horizontal `width` mode, with no visible side bars, and preserve the font and reflow height; restored corner grips use aspect-locked `scale` mode and multiply the gesture-start font by the new/start outer-width ratio, without fitting or rounding. Dragged height is not persisted, and there are no top/bottom height controls. Hug Frame child scaling and multi-selection scaling also scale Question content proportionally. Existing Question font values are respected, not ignored; there is no automatic persisted-data migration or height-to-font conversion. The floating toolbar exposes width and card-scale percentage, but neither height nor title-only font editing; Text retains its own font controls. See [canvas-input-interactions.md](./canvas-input-interactions.md#3-direct-manipulation) for group scaling and corner grip geometry.

Two independent uses branch from here: read as content (§4) or ask in chat (§5).

Content-driven height also applies while a proportional corner drag is active. The sizing hook measures the title at the live width and font, and the store's resize mirror leaves `style.height` unset rather than forcing the pointer-proposed height onto the card. This keeps the title unclipped before pointer-up; Text uses the same policy.

The scale input has a localized **Scale** label, a compact 36px number field, and a trailing `%` unit. There is no separate reset button; entering `100` restores the default content scale. Both the displayed percentage and `SET_QUESTION_CARD_SCALE` use `QUESTION_NODE_DEFAULT_FONT_SIZE` as their sole scale basis, not the card's independent artwork basis.

The single-node toolbar exposes **Scale** as an absolute percentage of the default title font. It reuses `FloatingToolbar.NumberInput` (integer input, 10–1000%) and derives the display from `data.style.fontSize`; merely focusing, blurring, or confirming an unchanged rounded display never rewrites fractional stored values. `SET_QUESTION_CARD_SCALE` resolves the requested percentage against the live node into one `MERGE_NODE_DATA` + `SET_NODE_GEOMETRY` execution: font and width change by the same ratio, height stays content-driven, and both changes undo together. Width-only edits preserve the percentage. No scale field or data migration is introduced. The control is not a title-only font editor and is independent of canvas viewport zoom.

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

While actively viewing or composing a Question thread, the canvas uses a state-colored light fill and outline on its rounded card without a conversation tail, or a speech bubble on its far mark. This open presentation is independent of lifecycle: it never replaces running, permission, conflict or error status, selects the node, shows editing toolbars, or changes its content geometry.

The chat panel header is the question node's rename surface in both compose and replay modes. Clicking the title (or focusing it and pressing Enter/Space) opens the same inline editor used by expanded content nodes; blur/Enter commits through `canvasStore.tryRename('node', ...)`, Escape cancels, and the shared rename path owns collision detection, persistence, and rollback. A fresh compose view continues to show the neutral “New question” title until the user assigns a name.

Opening an existing conversation from the Question body, toolbar or Agent mark defaults to latest in the recent-turn presentation window, including unread terminal results. Unread status still drives attention and the existing viewed acknowledgement; it no longer implicitly requests last-user positioning. Explicit search and best-effort reading return follow the [Preview Workspace navigation contract](./preview-workspace.md#6-focus-and-opening-position).

The readable Question uses the compact conversation-card design: a neutral `--bg-surface` shell with a thin `--edge-default` outline, no yellow depth board, and system sans-serif text. Agent identity and a status pill share the top row; the canonical question title/first-prompt fallback is below, without a fabricated answer summary. The unread terminal pill says `待查看` / `To review`, with `本轮结束 · 未查看` / `Turn ended · Not viewed` in its hover and accessible label, not a claim of success. Skipped-write conflicts retain a warning pill and count tooltip even after acknowledgement. Existing active-chat, permission, pending-fork and acknowledgement logic is unchanged. `QuestionConversationCard` reuses `AgentAvatarMark` and `resolveTextBodyBox`; `useTextNodeSurface` uses its proportional-font policy for width reflow and content-driven height, respecting stored fonts without legacy height-to-font migration.

The readable card adopts design C with roomier outer spacing: default/natural minimum width 440px, symmetric 24px padding on all sides, a 32px avatar/header, and a 12px header-to-title gap, without a left status rail. Question typography takes its 28px size and 1.3 line-height from `NODE_TYPOGRAPHY.cardTitle`, with a Question-specific 500 weight shared by rendering and measurement; Agent alias and status text reuse the card-description/body token, 18px with 1.4 line-height. Unlike fixed-typography PDF/Web cards, all Question metrics scale by `effectiveFontSize / NODE_TYPOGRAPHY.cardTitle.size`; weights and unitless line-height ratios stay unchanged. Authored widths and stored fonts are preserved. The status chip uses the semantic state background and a 16px icon; only the running icon spins. Production and playground share `useQuestionHeaderFit`, measuring the actual row, alias and status label rather than using a zoom threshold: hide the alias first, then status text, then the icon only if even that cannot fit. The identity and status descriptions remain available on their enclosing elements. Auto-height reserves the scaled 32px row plus 12px gap through symmetric measurement insets. No Question height or new lifecycle is persisted. Existing Profiles are resolved live, and fallback Agent identity remains unchanged.

At settled readable zoom the Agent avatar lives inside the card without a duplicate external badge. When the effective title font times viewport zoom falls below 5 screen pixels, the existing takeover portal crossfades to a centered full Agent mark; at 5.5 screen pixels or above it restores the card. This includes live resize fonts and retains the previous stage between thresholds. The default 24px font enters below `5 / 24` zoom (approximately 20.83%) and recovers at `5.5 / 24` (approximately 22.92%). The avatar body diameter is 75% of the card's shorter dimension; the 128-unit artwork and its 66% avatar ratio are scaled to that diameter, with proportional chrome and no screen-size floor. Frame suppression forces the plain circle without replacing the independent font-stage history. Reversible 200ms progress drives reciprocal card/portal opacity and preserves the node's stored rectangle. At zero progress the portal is hidden, inert and accessibility-hidden. Running, approval, unread/conflict and error indicators retain their meanings; open state supplies a state-colored speech bubble independently. Openable marks retain labelled keyboard/click activation and [useTakeoverMarkDrag](../../apps/web/src/hooks/useTakeoverMarkDrag.ts) with trailing-click suppression. See [canvas-zoom-rendering.md](./canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node).

### 5.2 Dispatch

All questions run through `/api/agent` ([agent.ts](../../apps/web/src/api/agent.ts) → [AgentThreadService](../../apps/server/src/modules/agent/agent-thread.service.ts)). `useAgentStream` awaits acknowledged node creation and the latest draft save before resolving the owner-first binding and dispatching:

The server resolves the request's `(canvasId, threadId)` against current Canvas state before using an `anchorNodeId`. That resolved Question is authoritative for the neighbourhood anchor and persisted mode; a mismatched anchor or a thread with no Question owner is rejected rather than combining one conversation's Agent with another node's spatial context.

A new Ink Question starts with `New ink request` and `pendingInkIntentLabel: true`. During that same built-in Ink turn, a validated `report_ink_intent` result may replace the placeholder through the server Canvas executor only when the active turn still owns that exact node, its marker remains pending, and its sidecar label is still the untouched non-user placeholder. Any user rename clears the marker and wins the race; clarify/unsupported reports, terminal settlement without a report, follow-up turns, and paste/duplicate consume or strip the marker without renaming. Existing Question targets are never renamed by per-turn Ink intent.

- **internal**: built-in Huabu Agent, `agentMode` = `operate` (default) / `ask`
- **external**: ACP agent resolved server-side from `profileId`

`anchorNodeId` is sent so the server attaches spatial context (§5.3).

Binding is independent of invocation: first actual prompt or external control realizes a canonical execution record; `AgentNodeBindingCoordinator` validates `agenetes.record(namespace, threadId)` and persists Bound before controls/run. Creating a node, opening compose, and cached capability reads do not realize an execution. Bound survives session closure, preparation failure, stop, and missing records. A failed Canvas promotion leaves the canonical record authoritative; the next guarded edit or interaction completes promotion rather than rebinding. Internal ask/operate remains separate from driver/Profile identity.

After node lifecycle admission, `ensureFallback()` persists an eligible first-prompt fallback before slow preparation, even if preparation fails without creating a driver. After durable realization, both message adapters call `start()`, which awaits fallback preparation and starts non-blocking utility-model generation. Pre-thread preprocessing can also name a Question directly without creating an Agenetes record or starting ACP. Naming never realizes an Agent solely to obtain a title.

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

| Concern               | File                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component + toolbar   | [QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)                                                                                                                                                                                                                               |
| Agent status surfaces | [QuestionConversationCard.tsx](../../apps/web/src/components/Nodes/question/QuestionConversationCard.tsx) renders the readable compact card; [QuestionTakeoverMark.tsx](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx) renders the collapsed mark through the existing takeover engine. |
| Compose / replay      | [questionCompose.ts](../../apps/web/src/components/Nodes/question/questionCompose.ts) and [PreviewRenderer.tsx](../../apps/web/src/components/Panels/PreviewWorkspace/PreviewRenderer.tsx) open the node target and resolve its renderer-local session                                                          |
| Conversation owner    | [conversationOwner.ts](../../apps/web/src/store/conversationOwner.ts) validates ordinary Question ownership, serializes editable draft patches, and sends token-specific viewed acknowledgements                                                                                                                |
| Server-side creation  | [agent-node.service.ts](../../apps/server/src/modules/agent/agent-node.service.ts) validates a selectable external Profile and anchor, then creates the fixed-binding Question Node and lineage edge through the canonical Canvas executor                                                                      |
| Thread lookup         | [agent-thread-resolver.ts](../../apps/server/src/modules/agent/agent-thread-resolver.ts) resolves node identity and acknowledged preparation regardless of policy                                                                                                                                               |
| Shared naming         | [conversation-title.service.ts](../../apps/server/src/modules/agent/conversation-title.service.ts) owns title policy; [conversation-title-node-store.ts](../../apps/server/src/modules/agent/conversation-title-node-store.ts) reads and persists the canonical Question label                                  |
| Execution binding     | [agent-node-binding.ts](../../apps/server/src/modules/agent/agent-node-binding.ts) confirms canonical records and guards preparation edits                                                                                                                                                                      |
| Server invocation     | [agent-thread.service.ts](../../apps/server/src/modules/agent/agent-thread.service.ts) owns shared admission, cancellation, dispatch, and settlement; [agent-node-lifecycle.ts](../../apps/server/src/modules/agent/agent-node-lifecycle.ts) projects token-guarded transitions                                 |
| RFS Agent access      | [rfs.route.ts](../../apps/server/src/modules/remote_fs/rfs.route.ts) creates visible Agents through `POST /agent` and submits later turns through `POST /agent/:threadId/prompt`; optional parent edges are best effort                                                                                         |
| Open scroll target    | [MessageList.tsx](../../apps/web/src/components/Messages/MessageList.tsx) + [messageListScroll.ts](../../apps/web/src/components/Messages/messageListScroll.ts)                                                                                                                                                 |
| Send + observation    | [useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts) awaits drafts and owns transcript/request feedback; [conversationOwner.ts](../../apps/web/src/store/conversationOwner.ts) sends token-specific viewed acknowledgements                                                                          |
| Trusted projection    | [agent-node-projection.ts](../../apps/server/src/modules/canvas/agent-node-projection.ts) composes current FSM state under the Canvas mutex; [agent-node-association.ts](../../apps/server/src/modules/canvas/agent-node-association.ts) validates legacy initialization and undo reinsertion                   |
| Create path           | [resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)                                                                                                                                                                                                                     |
| Dispatch API          | [agent.ts](../../apps/web/src/api/agent.ts) `streamMessage`                                                                                                                                                                                                                                                     |
| Spatial context       | [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)                                                                                                                                                                                                                             |
| Shared types          | [node.ts](../../packages/shared/src/types/canvas/node.ts) `QuestionNodeData` · [acp.ts](../../packages/shared/src/types/api/acp.ts) `AgentBinding`                                                                                                                                                              |

---

## 7. Open questions

- `responseSummary` is reserved but not yet written — node shows no answer teaser.
- Crash recovery and durable invocation-to-turn correlation are outside the node FSM; reads never sanitize a persisted `running` result.
- Vision channel (screenshot of neighbourhood) deferred.
- Re-run cleanup of previously created nodes is undecided.
