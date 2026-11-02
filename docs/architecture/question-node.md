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

User-facing node terminology is **Agent Node** in English and **Agent 节点** in Simplified Chinese, including creation actions, layer labels, chat fallback titles, toolbar tooltips, and ink-request feedback. The persisted `question` type, code identifiers, and translation keys remain unchanged; references to the user's question still describe prompt content.

For an Ink-initiated turn, the Agent must deliver an actual Canvas response without requiring the user to open ChatPanel. The server verifies visible writes before successful completion and reports missing delivery through the existing error lifecycle; it never creates a fallback answer Note or edge. This Agent Node owns the conversation, not the reply's position: explicit Ink spatial instructions take priority, otherwise results belong near the current query and related materials. Built-in Ask is excluded from Ink destinations without changing ordinary read-only Chat. See [Ink response delivery](./sketch-node.md#41-partial-stroke-selection-as-ai-context).

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

| Field                     | Persisted | Notes                                                                                                                                         |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`                 | sidecar   | The question text; stored in `nodes/<safeLabel>.md` body like text/note (`TEXT_BEARING_NODE_TYPES`), stripped from the structure PUT          |
| `status`                  | ✅        | Optional sparse status: absent means `idle`; non-default values are `running` / `done` / `error`                                              |
| `threadId`                | ✅        | Owns one chat thread; minted on first compose                                                                                                 |
| `conversationTitleSource` | ✅        | Server-owned naming provenance (`user` / `generated` / `acp` / `fallback` / null); the title value remains the canonical `label`              |
| `agentBinding`            | ✅        | Acknowledged preparation draft; driver/Profile identity becomes immutable after canonical execution binding                                   |
| `agentBindingPolicy`      | ✅        | Optional `selectable` / `fixed`; absent means selectable, while service-created Agent Nodes use fixed before first send                       |
| `agentIcon`               | ✅        | External Agent's bind-time avatar fallback; current Profile icon wins while that Profile still exists                                         |
| `agentLaunchOverrides`    | ✅        | Optional bounded cwd and additional-initial-preamble overrides for an external Agent Node; user-created Nodes may edit cwd before binding     |
| `agentMode`               | ✅        | `operate` (default) / `ask` for the internal agent                                                                                            |
| `errorMessage`            | ✅        | Set on `status === 'error'`                                                                                                                   |
| `viewed`                  | ✅        | Drives unread terminal-state attention on the Agent avatar                                                                                    |
| `bindingState`            | ✅        | Server-owned `editing` / `bound`; Bound acknowledges a validated canonical Agenetes record and never demotes                                  |
| `invocationToken`         | ✅        | Server-owned current or last admitted prompt identity; fences terminal writes and viewed acknowledgements                                     |
| `lastActivityAt`          | ✅        | Server-owned epoch milliseconds from the latest projected durable turn-start, done, or error event; absent until a reliable event is observed |
| `responseSummary`         | reserved  | Teaser field; not yet written by the runner                                                                                                   |
| `pendingInkIntentLabel`   | ✅        | Marks only a newly created Ink Question whose placeholder may be replaced by the first reported interpretation summary                        |

Mode edits acquire the same nonblocking turn lease as prompt admission and retain it through the Canvas write. A mode change during preparation or execution is rejected as `agent_draft_busy`; unchanged mode echoes and display edits remain allowed. Unlike binding identity and launch overrides, Ask/Operate mode remains editable after binding whenever the conversation is idle.

Not persisted: the server invocation phase and cancellation controller, plus the browser's stream controller and request feedback. The complete Node is a read model, not a writable snapshot: ordinary Canvas PUT, commands, and undo omit or preserve the server-owned fields and cannot replace the thread association.
Question nodes are content nodes: preprocessing delegates their `content` to `ConversationTitleService.initializeQuestion()` rather than running a separate `generate_label` stage. The profile has no `persist_source`, so Questions do **not** enter the knowledge base. They remain visible to agents (`type: 'question'` in `get_space_outline`). See [node-preprocessing.md](./node-preprocessing.md) for the profile and option gates.

Question naming uses the same `ConversationTitleService` as panel Chat, with one storage authority per conversation. For a Question, the canonical node `label` supplies its Canvas, Preview tab, chat header, and title-query value; `conversationTitleSource` records provenance, not another title. Panel-only conversations use `ThreadRecord.hostMetadata.huabuConversationTitle` instead of hidden nodes. The service resolves current Question ownership on reads and writes, so thread metadata is not a second authority after conversion. Automatic names use `labelSource: 'auto'` with priority `user > generated > acp > fallback`; non-empty `user` or `agent` labels remain protected. Generation and ACP updates can continue naming an eligible Question but never change its first prompt, status, or transcript. Ordinary Canvas edits and undo cannot replace `conversationTitleSource`; trusted title writes use the canonical Canvas persistence and sync path. See [shared conversation naming](./agent-architecture.md#panel-conversation-titles).

---

## 3. Node lifecycle

The Canvas Toolbar's Agent Node placement button pairs Lucide's outlined `Sparkles` icon with a persistent `Agent` label, matching the other toolbar icons and inheriting the button's semantic foreground color (including its active state). Its localized tooltip and accessible name describe the action as "Add Agent Node", with the `A` shortcut shown for mouse input; its pressed state reflects active placement. This toolbar mark does not change node avatars or the generic node-type icon mapping; node avatars continue to identify the bound agent.

Automatic Question naming compares safe filenames to detect collisions but preserves the original display title, including punctuation. When a collision requires a suffix such as ` (2)`, the suffix is appended to the original title rather than replacing it with the sanitized filename. Storage path safety remains owned by the canonical persistence path.

Saving a panel Chat as a Question uses [saveChatAsQuestion](../../apps/web/src/components/Panels/ChatPanel/saveChatAsQuestion.ts) and canonical node creation to transfer naming authority to the node. A manual title becomes `labelSource: 'user'`; an ACP, generated, or fallback title becomes `labelSource: 'auto'`, with its provenance in `conversationTitleSource`. At creation the server adopts the latest effective thread title when the incoming node label is not user/agent-protected, rather than treating a stale browser cache as authoritative. Without a current title, the helper preserves the supplied node data and existing node-creation fallback. Later in-flight generation and ACP updates resolve the new Question owner and update its canonical label when priority and current-label protection permit; this is one naming service writing the current owner, not ongoing synchronization between two title values. Manual naming retains no hidden automatic candidate.

Created like any node via `CREATE_NODES` ([resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)) with `nodeType: 'question'` and empty `content`. Missing `status` is the idle state, and nothing fires automatically. From there:

- **Idle** → double-click opens compose (§5).
- An idle node with `agentBindingPolicy: fixed` opens compose with its persisted binding and a read-only Agent selector. Ordinary Editing nodes retain the picker; Bound nodes cannot switch execution identity even when a first control created no messages.
- An external Agent Node exposes a Folder button beside the Agent selector whenever its effective directory is known, including when a locked Node inherits its Profile directory. Its shared working-directory Popover shows the complete effective path and canonical device name and, while editing, accepts a Node-specific override. Empty means inherit the selected Profile without persisting a copy; an explicit value marks the trigger, survives Profile changes, and applies only to that Node. The shared folder picker appears only when the target Agentlet matches the picker's filesystem identity; picking fills the draft and explicit Done commits it. Other devices retain manual entry. Binding locks the override with the rest of execution preparation; the same Popover remains available as read-only execution context whether the locked directory is inherited or overridden. See [Preview Workspace](./preview-workspace.md) for the shared editing behavior and [Agent Profiles](./agent-profiles.md) for picker identity.
- After sending: **running → done / error**.
- `AgentThreadService` owns lifecycle for every node-backed invocation, regardless of policy. Admission publishes a new token and `running` before dispatch, installs cancellation before slow preparation, and keeps the turn lease through settlement. `AgentNodeLifecycle` fills only freshly read empty, never-submitted content and projects the matching terminal result. Existing content, previous submission tokens, and legacy conversation history prevent follow-ups from replacing authored text.
- Loading and reconnect observe server state; they never infer success from old history or repair status in the browser. A persisted running node without live tracking after restart does not establish an outcome, introduce a new badge, or trigger replay. Existing retry/admission behavior remains unchanged.
- The readable compact card places a 28px colored Agent avatar before the title, aligned with its first line, and a status pill and recent conversation time in the footer. Identity is not repeated in the footer. Running uses an information-colored pill with a loading glyph. The collapsed Agent mark retains its existing ring and identity animation outside structured Frames.
- An idle node whose conversation is actively presented in an expanded Preview Workspace panel shows "Conversation open" instead of "Not started". Switching away from its tab or collapsing the panel restores the idle copy. Opening a conversation never overrides running, approval, terminal, or conflict status, and does not change the persisted lifecycle.
- A live unresolved ACP permission request temporarily overrides every other badge state, stops working motion, and shows a warning shield pill (or the existing shield satellite on the collapsed mark); resolving or cancelling the request restores the underlying run state.
- Done, error, and conflict attention styling appears only while `viewed === false`. ChatPanel sends the terminal `invocationToken` to the viewed endpoint only after explicit interaction in the current Canvas visit, matching history hydration, and presentation of the latest end of the conversation in an active, expanded panel on a visible, focused page. Opening the Question only records read intent; it never acknowledges before rendering. Restoring Preview layout on Space navigation or reload does not record intent. The same rule applies to local and cross-Space conversations. The server acknowledges only the matching current terminal result, returning the avatar to a quiet neutral ring. Legacy terminal nodes use an explicit null-token acknowledgement that succeeds only while no new invocation token exists.
- Move / delete / resize / re-frame all go through the normal node flow; a stale
  pasted copy strips transient state so it starts fresh.
- **Create-time selection**: a question node does **not** auto-select when born
  from the compose / preprocess flow (those focus the chat input, so the canvas
  must not steal focus) — this is the default in [createNodes.ts](../../packages/shared/src/canvas-engine/commands/createNodes.ts). Paste / duplicate is the exception: [resolvePasteClipboard.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolvePasteClipboard.ts) sets `selectOnCreate: true`, which overrides that default so the pasted copy is selected like any other pasted node.
- Question height is content-driven. Like Text and Space cards, it uses `fontSizing: 'proportional'` through `useTextAutoSize`: a finite positive `data.style.fontSize` sets the content scale, otherwise `QUESTION_NODE_DEFAULT_FONT_SIZE` supplies the 24px default. Question text, avatar, insets and footer share this single scale basis. Side grips preserve the font and reflow height; aspect-locked corners, Hug Frame cascades and multi-selection multiply the starting font by the new/start outer-width ratio without fitting or rounding. The toolbar offers Accent, Width and Scale, but no height or title-only font control. Authored widths and fonts remain persisted unchanged until explicitly edited; there is no data migration. See [canvas-input-interactions.md](./canvas-input-interactions.md#3-direct-manipulation).

Two independent uses branch from here: read as content (§4) or ask in chat (§5).

Content-driven height also applies while a proportional corner drag is active. The sizing hook measures the title at the live width and font, and the store's resize mirror leaves `style.height` unset rather than forcing the pointer-proposed height onto the card. This keeps the title unclipped before pointer-up; Text uses the same policy.

The scale input has a localized **Scale** label, a compact 36px number field, and a trailing `%` unit. Entering `100` restores the default content scale. Both Question and Space cards share `SET_CARD_SCALE`, with 24px as the default title font.

The single-node toolbar reuses `FloatingToolbar.NumberInput` (integer input, 10–1000%) and derives Scale from `data.style.fontSize`; merely focusing, blurring, or confirming an unchanged rounded display never rewrites fractional stored values. `SET_CARD_SCALE` resolves the percentage against the live node into one `MERGE_NODE_DATA` + `SET_NODE_GEOMETRY` execution: font and width change by the same ratio, height stays content-driven, and both changes undo together. Width-only edits preserve the percentage. No scale field is introduced; content scale is independent of canvas viewport zoom.

Recent conversation time is a lightweight server-owned read model on the node. The mounted `conversationEventLogStore` projects the actual Tier-1 `ts` after a durable `turn_start`, `done`, or `error`, through the existing guarded Canvas projection and realtime publication path. Projection failures are logged without rejecting an already committed event. Older or duplicate timestamps cannot move the read model backwards. Token deltas, title edits, viewing, movement, resizing and metadata freshness do not change it. Rendering never fetches per-card history. Existing conversations are not bulk-backfilled, and absent/invalid timestamps are omitted until a new reliable boundary is observed. `NodeActivityTime` shares Space cards' minute timer and localized relative-time presentation, but its tooltip says "Last conversation activity" rather than Space update time.

---

## 4. As a content node

The question text lives in the markdown sidecar, so agents read it like any other text node — `read("nodes/<file>.md")` returns the body, and `get_space_outline` lists it as `type: 'question'`. No trigger is needed; it is Canvas content that also owns a thread.

Canonical Question creation owns the initial sidecar write. The web marks the optimistic node before inserting it into local state, so the generic content queue suppresses its otherwise redundant new-node PUT for both create-only and create-and-start flows. A real edit made before the create command acknowledges remains pending and waits for that same creation promise before writing; subsequent Canvas Sync content seeds the current sidecar revision, so the edit uses the authoritative baseline rather than the absent-file revision. This ordering prevents the optimistic creation path from competing with its own server command or overwriting the first prompt.

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

Agent and Space cards share `CardTitle` and the same inline-renaming gestures. A single pointer click only selects. Double-clicking an initially unselected card opens its conversation or target Space, including when the click lands on its title. If the card was already selected before the first click of the double-click sequence, double-clicking the rendered title text starts editing and selects the current text. Per-line DOM text ranges restrict renaming to visible text rather than the entire title row: whitespace, icons, and footer double-clicks still open the card. The title element remains stable across selection, and the first click captures the pre-selection state so that selection caused by the double-click itself cannot trigger renaming. Keyboard activation of a selected title also starts editing; Space cards retain their toolbar/F2 entry points. Enter or blur saves, Escape cancels, and IME confirmation is ignored. Double-clicks inside an active editor select text without opening the conversation. Locked nodes, missing-content nodes, and pending conversation forks do not expose the editor. Empty titles show validation feedback; failed saves retain the draft for correction or retry. Agent titles reuse `canvasStore.tryRename('node', ...)`, just like the chat header, preserving canonical label ownership and user naming protection without changing the first prompt, transcript, or lifecycle. Card width and content scale remain unchanged.

The shared title editor uses Common `TextArea` over an invisible, accessibility-hidden copy of the persisted display title. The placeholder retains the original title geometry while the editor soft-wraps and scrolls internally, so entering editing, changing the draft, and cancelling do not resize the card or move its footer. Successful saves reflow the card from the new persisted title; validation and save errors retain their separate inline feedback. Enter remains a save action, and pasted line breaks are removed rather than introducing multiline title data.

Double-click the node → `openInCompose()` ([QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)). Creating a question through the toolbar placement flow or the connected-node picker also mints the thread and opens compose immediately. [`questionCompose.ts`](../../apps/web/src/components/Nodes/question/questionCompose.ts) opens the Question's Preview Workspace node tab and directs the input-focus request to that thread.

- confirms server-acknowledged creation (or initializes a legacy node's missing thread association), opens the chat panel in **compose mode**, and defaults the built-in Huabu Agent to `operate`
- new Questions snapshot the browser-local recent conversational Agent unless a binding is supplied, falling back to the first selectable external Profile when that cache is absent or stale; existing Questions, Utility Agent changes, and legacy association repair retain their binding, and the user can switch an editable binding
- user types the question, hits send → first send writes `content` back to the node

Toolbar: **Ask** when idle, **View / Watch conversation** once a thread exists.

While actively viewing or composing a Question thread, the card retains its authored surface/accent and uses a state-colored outline without a conversation tail. Opening never applies a status-tinted fill to the whole card; status-label backgrounds remain independent of the user's accent. Both ordinary and open outlines use the shared 1px canvas-space boundary, independent of content Scale and without layout impact. Opening never replaces running, permission, conflict or error status, selects the node, shows editing toolbars, or changes its content geometry.

The chat panel header is the question node's rename surface in both compose and replay modes. Clicking the title (or focusing it and pressing Enter/Space) opens the same inline editor used by expanded content nodes; blur/Enter commits through `canvasStore.tryRename('node', ...)`, Escape cancels, and the shared rename path owns collision detection, persistence, and rollback. A fresh compose view continues to show the neutral “New Agent Node” title until the user assigns a name.

Opening an existing conversation from the Question body, toolbar or Agent mark defaults to latest in the virtualized history, including unread terminal results. Unread status still drives attention and the existing viewed acknowledgement; it no longer implicitly requests last-user positioning. Explicit search and best-effort reading return follow the [Preview Workspace navigation contract](./preview-workspace.md#6-focus-and-opening-position).

The readable Question uses system sans-serif text, the shared Note surface/accent treatment, and a thin outline. Its main row contains the colored Agent avatar followed by the canonical question title/first-prompt fallback; the footer contains status and recent conversation time. There is no answer summary or body clamp. The unread pill says `待查看` / `To review`, with `本轮结束 · 未查看` / `Turn ended · Not viewed` in its tooltip and accessible label, not a claim of success. Space activity badges reuse the same translation keys for running, approval, error, and unread results; idle and unknown remain distinct Space aggregation states. Skipped-write conflicts retain a warning pill and count even after acknowledgement. White accents use the neutral boundary token rather than a white-on-white mix. The active-chat outline uses the semantic foreground rather than its light tint; selection retains the shared opaque blue Canvas HUD outline. Permission, pending-fork and acknowledgement behavior is unchanged. The renderer reuses `AgentAvatarMark`, `Tooltip`, `NodeActivityTime`, `resolveTextBodyBox` and proportional text sizing.

Question and Space cards share `CONVERSATION_CARD_SPACING`: outer padding references `NODE_CONTENT_SPACING.padding` (16px), the same base inset as Note/PDF/Web, with an 8px main/footer gap and a 32px footer. The footer closely matches the 31.2px title line while accommodating the 31.2px status pill, reducing excess bottom whitespace without asymmetric padding. Frame container padding remains independently owned at 20px. The Question retains its 400px natural minimum and respects authored narrower widths. At 100% Scale its title is 24px/500 with 1.3 line-height, metadata is 18px with 1.4 line-height, the avatar is 28px, and the status icon is 16px. Content metrics scale from `effectiveFontSize / 24`; width-only changes do not change padding, unlike the existing width-scaled PDF/Web inset policy. Text measurement reserves the leading avatar plus gap through symmetric horizontal measurement insets, while rendering distributes that extra reservation to the left. Vertical measurement reserves the footer plus gap. The avatar has no tile or visible alias; its tooltip supplies the Agent name. Narrow footers truncate status text and time without displacing the avatar or changing card height; time takes at most half the footer. Only the running status icon spins. Existing Profile resolution and fallback identity remain unchanged. The historical zoom-comparison playground retains its separate `useQuestionHeaderFit` study.

Question outer corners use the shared `nodeMetricsForSize` size tiers (12 / 18 / 24px), not the title font scale. `NodeWrapper` supplies `--node-shell-radius` to the visible card, so its fill, inset outline, Canvas selection outline, and corner grips share the same outer geometry.

Question and Space title rows share a 28px leading icon slot and an 8px text gap, keeping titles aligned across card types. Header icons remain vertically centered on the first title line, not the entire multiline title. Footer badges are independent icon-and-text groups: their outer left edges align with the title row's outer left edge, without forcing status text onto the title's text column. Horizontal content insets are measured from the outer card edge in both renderers; Space subtracts its fixed layout border from the scaled inner padding to match Question's painted boundary.

The status pill has 6px horizontal padding, 3px vertical padding, a 6px icon/text gap and 6px corners at 100% Scale. The 16px status icon uses its natural width without a title-sized slot. The whole pill, including its background, stays within the shared 16px card inset; no negative margin reduces the visible left whitespace. Semantic text is mixed with the default foreground for contrast; accent never overrides runtime status colors.

Idle, conversation-open, and viewed status labels have transparent backgrounds, retaining their icons, text, and padding without suggesting a clickable control. Running, approval, unread, error, and conflict states retain their semantic backgrounds. The status pill keeps its small `6px * artworkScale` corner radius; card corners follow the independent shared node-size tiers.

At settled readable zoom the Agent avatar lives inside the card without a duplicate external badge. When the effective title font times viewport zoom falls below 5 screen pixels, the existing takeover portal crossfades to a centered full Agent mark; at 5.5 screen pixels or above it restores the card. This includes live resize fonts and retains the previous stage between thresholds. The default 24px font enters below `5 / 24` zoom (approximately 20.83%) and recovers at `5.5 / 24` (approximately 22.92%). The avatar body diameter is 75% of the card's shorter dimension; the 128-unit artwork and its 66% avatar ratio are scaled to that diameter, with proportional chrome and no screen-size floor. Frame suppression forces the plain circle without replacing the independent font-stage history. Reversible 200ms progress drives reciprocal card/portal opacity and preserves the node's stored rectangle. At zero progress the portal is hidden, inert and accessibility-hidden. Running, approval, unread/conflict and error indicators retain their meanings; open state supplies a state-colored speech bubble independently. Openable marks retain labelled keyboard/click activation and [useTakeoverMarkDrag](../../apps/web/src/hooks/useTakeoverMarkDrag.ts) with trailing-click suppression. See [canvas-zoom-rendering.md](./canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node).

### 5.2 Dispatch

All questions run through `/api/agent` ([agent.ts](../../apps/web/src/api/agent.ts) → [AgentThreadService](../../apps/server/src/modules/agent/agent-thread.service.ts)). `useAgentStream` awaits acknowledged node creation and the latest draft save before resolving the owner-first binding and dispatching:

The server resolves the request's `(canvasId, threadId)` against current Canvas state before using an `anchorNodeId`. That resolved Question is authoritative for the neighbourhood anchor and persisted mode; a mismatched anchor or a thread with no Question owner is rejected rather than combining one conversation's Agent with another node's spatial context.

A new Ink Question starts with `New ink request` and `pendingInkIntentLabel: true`. During that same Ink turn, a validated interpretation report may replace the placeholder with its `text` summary through the server Canvas executor only when the active turn still owns that exact node, its marker remains pending, and its sidecar label is still the untouched non-user placeholder. The optional `explanation` belongs to the per-turn history record, not the node title. Built-in turns use `report_ink_intent`; external turns use the authenticated, per-turn-token RFS endpoint described in [Agent Reachback](./agent-reachback.md#agent-control-plane), sharing the same writer and title protection. Any user rename clears the marker and wins the race; terminal settlement without a report, follow-up turns, and paste/duplicate consume or strip the marker without renaming. Existing Question targets are never renamed by per-turn interpretation reports.

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

Question previews retain `AgentConversationView`, whose presentation anchor and conversation owner identify the same Canvas/node; the owner also identifies the Question's thread. Browser validation checks the live Question type and thread when that Space is active and loaded, validates remote ownership through the bounded owner endpoint when another Space is active, and always checks that the presentation anchor agrees with the owner. Queued turns continue in their captured owner scope after navigation; server admission validates the current persisted Question/thread association and rejects deleted or reassigned anchors rather than falling back to an unbound chat. History, reconnect, turns, lifecycle, tools, binding/mode, and change records use that owner scope. Cross-Space conversation previews preserve this source identity without loading another editable Canvas, as described in the [Preview Workspace contract](./preview-workspace.md).

---

Questions directly inside row/column layout Frames keep their card presentation at all zoom levels instead of collapsing to Agent marks. Parent layout changes and reparenting update this policy live. The subscription reads the Question and its immediate parent from React Flow's existing `nodeLookup` index, using at most two keyed lookups per update rather than scanning the Canvas node array for every Question. Parent Frame region suppression still hides their cards like ordinary children, without leaving a floating dot; free-layout Frames and standalone Questions retain the takeover behavior above.

## 6. Code entry points

The client applies lifecycle, activity-time, and title projections as data effects on the live Question rather than replacing the entire node carried by a coarse server delta. This preserves local position, Width, Scale, Accent, and undo/redo geometry while accepting authoritative conversation observations.

| Concern               | File                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component + toolbar   | [QuestionNode.tsx](../../apps/web/src/components/Nodes/question/QuestionNode.tsx)                                                                                                                                                                                                                                                                                                   |
| Agent status surfaces | [QuestionConversationCard.tsx](../../apps/web/src/components/Nodes/question/QuestionConversationCard.tsx) renders the readable compact card; [QuestionTakeoverMark.tsx](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx) renders the collapsed mark through the existing takeover engine.                                                                     |
| Conversation time     | [conversation-stores.ts](../../apps/server/src/modules/agent/agenetes/conversation-stores.ts) projects durable log boundaries through [agent-node-projection.ts](../../apps/server/src/modules/canvas/agent-node-projection.ts); [NodeActivityTime.tsx](../../apps/web/src/components/Nodes/shared/NodeActivityTime.tsx) shares localized relative-time rendering with Space cards. |
| Compose / replay      | [questionCompose.ts](../../apps/web/src/components/Nodes/question/questionCompose.ts) and [PreviewRenderer.tsx](../../apps/web/src/components/Panels/PreviewWorkspace/PreviewRenderer.tsx) open the node target and resolve its renderer-local session                                                                                                                              |
| Conversation owner    | [conversationOwner.ts](../../apps/web/src/store/conversationOwner.ts) validates ordinary Question ownership, serializes editable draft patches, and sends token-specific viewed acknowledgements                                                                                                                                                                                    |
| Server-side creation  | [agent-node.service.ts](../../apps/server/src/modules/agent/agent-node.service.ts) validates the explicitly selected Built-In or external Profile and anchor, then creates the fixed-binding Question Node and lineage edge through the canonical Canvas executor                                                                                                                   |
| Thread lookup         | [agent-thread-resolver.ts](../../apps/server/src/modules/agent/agent-thread-resolver.ts) resolves node identity and acknowledged preparation regardless of policy                                                                                                                                                                                                                   |
| Shared naming         | [conversation-title.service.ts](../../apps/server/src/modules/agent/conversation-title.service.ts) owns title policy; [conversation-title-node-store.ts](../../apps/server/src/modules/agent/conversation-title-node-store.ts) reads and persists the canonical Question label                                                                                                      |
| Execution binding     | [agent-node-binding.ts](../../apps/server/src/modules/agent/agent-node-binding.ts) confirms canonical records and guards preparation edits                                                                                                                                                                                                                                          |
| Server invocation     | [agent-thread.service.ts](../../apps/server/src/modules/agent/agent-thread.service.ts) owns shared admission, cancellation, dispatch, and settlement; [agent-node-lifecycle.ts](../../apps/server/src/modules/agent/agent-node-lifecycle.ts) projects token-guarded transitions                                                                                                     |
| RFS Agent access      | [rfs.route.ts](../../apps/server/src/modules/remote_fs/rfs.route.ts) creates visible Agents through `POST /agent` and submits later turns through `POST /agent/:threadId/prompt`; optional parent edges are best effort                                                                                                                                                             |
| Open scroll target    | [MessageList.tsx](../../apps/web/src/components/Messages/MessageList.tsx) + [messageListScroll.ts](../../apps/web/src/components/Messages/messageListScroll.ts)                                                                                                                                                                                                                     |
| Send + observation    | [useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts) awaits drafts and owns transcript/request feedback; [conversationOwner.ts](../../apps/web/src/store/conversationOwner.ts) sends token-specific viewed acknowledgements                                                                                                                                              |
| Trusted projection    | [agent-node-projection.ts](../../apps/server/src/modules/canvas/agent-node-projection.ts) composes current FSM state under the Canvas mutex; [agent-node-association.ts](../../apps/server/src/modules/canvas/agent-node-association.ts) validates legacy initialization and undo reinsertion                                                                                       |
| Create path           | [resolveAddNodes.ts](../../apps/web/src/handler/canvasCommand/resolvers/resolveAddNodes.ts)                                                                                                                                                                                                                                                                                         |
| Dispatch API          | [agent.ts](../../apps/web/src/api/agent.ts) `streamMessage`                                                                                                                                                                                                                                                                                                                         |
| Spatial context       | [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)                                                                                                                                                                                                                                                                                                 |
| Shared types          | [node.ts](../../packages/shared/src/types/canvas/node.ts) `QuestionNodeData` · [acp.ts](../../packages/shared/src/types/api/acp.ts) `AgentBinding`                                                                                                                                                                                                                                  |

---

## 7. Open questions

- `responseSummary` is reserved but not yet written — node shows no answer teaser.
- Crash recovery and durable invocation-to-turn correlation are outside the node FSM; reads never sanitize a persisted `running` result.
- Vision channel (screenshot of neighbourhood) deferred.
- Re-run cleanup of previously created nodes is undecided.
