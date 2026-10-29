# Agent Context

> The full path that carries "thinking on the Space" to the AI agent: which
> signals are exposed, how they reach the model, and what's still missing.
> Maps to the README principles **Externalize Thinking** / **Share Cognitive Space**.

Core mental model: **chat sends a thin payload (selected nodes only) and the agent
fetches the rest via tools.**

---

## 1. The wire shape

Types live in [packages/shared/src/types/agent/context.ts](../../packages/shared/src/types/agent/context.ts).

| Shape              | For        | Carries                                   | Entry             |
| ------------------ | ---------- | ----------------------------------------- | ----------------- |
| `AgentChatContext` | chat agent | only `selectedNodes: WireSelectionNode[]` | `POST /api/agent` |

Chat is deliberately thin: everything else (geometry / edges / content / screenshot) is fetched by the agent via tools. Web assembly: `getAgentChatContext()` ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)).

The Chat composer lets users omit live Canvas selection from the next text message without changing Canvas node or stroke selection. The included selected-node chip has a leading remove action; after removal, it keeps its count as a dashed `+` candidate button, reusing the adjacent-preview source button's styling and whole-button add interaction without strikethrough text. Clicking it includes the entire current selection again, whereas the adjacent-preview candidate adds one explicit node source. The in-memory exclusion flag belongs to the thread and is consumed with its submitted draft; a rejected submission restores it when the original draft is restored. `useAgentStream` passes an explicit empty node/stroke selection to `captureAgentTurnSources` before preparing the immutable turn, so built-in and external Agents receive `canvasContext.selectedNodes: []`, with no automatic selected-node visual inputs or selected-source transcript metadata. Retry uses the original message's captured source metadata rather than the current Canvas selection. Explicit attachments, excerpts, quoted comments, anchor/neighbourhood context, and prior conversation history are unaffected; explicit Ink-intent submission still requires its selected strokes and does not consume this composer flag.

Quoted Comments are independent of live Canvas sources. Chat captures earlier assistant passages in the current conversation; expanded Note rich text stages into an explicitly resolved existing conversation. Both retain quote, bounded neighboring context and user comment in the same structured `quotedComments` field. Note quotes additionally retain `source: { kind: 'note', canvasId, nodeId, snapshotRevision }`, frozen from the rendered document at excerpt capture rather than resolved again on Send/retry/history replay. The canonical escaped prompt renderer selects Chat or Note source wording and includes Note metadata as untrusted reference evidence, not in user-authored text or title/search text. A snapshot revision is a content fingerprint, not a save acknowledgement or edit capability. Adding a Comment never adds a whole-Note attachment or changes the live-selection inclusion control; a separately selected Note or parent Frame can still contribute context under existing rules. Sent metadata persists with the envelope/history; unsent drafts remain runtime-only.

File Reference Preview uses the same structured Comment staging with a `file-reference` source. The model receives the captured device/path, filesystem `contentVersion`, UTF-16 selection range, loaded-text extent/completeness and bounded selection context, not an automatic whole-file attachment or a fresh read on Send. Its escaped template explicitly distinguishes the source device from the Agent execution device and treats metadata and text as untrusted reference evidence. Refresh, read-more and source-file changes do not rewrite an opened or staged snapshot. File Comment does not change bootstrap machine identity, execution cwd, live Canvas inclusion or Ink submission.

---

## 2. Chat path: the conversation module

Chat context is assembled by [conversation/](../../apps/server/src/modules/agent/conversation) into a `ChatEnvelope`, then serialised into pi-ai messages.

Handwritten `#` references are an optional Ink-only `inkResources` array, defined in the shared [Sigil wire schema](../../packages/shared/src/types/api/ink-sigil.ts). Each of at most 32 entries freezes one target, its visible label, geometry fingerprint, source bounds, and exactly four `{nodeId, strokeId}` sources. Shared request validation requires every source to belong to the actual submitted partial-Ink selection, forbids overlapping binding ownership, and requires grounding even for Sigil-only Ink. The client validates the live source fingerprint before freezing; the server validates the wire membership and reads eligible targets through the same Space's canonical `nodes.readMany`. It does not recompute the historical fingerprint or reread a mutable durable binding, which must not retarget an already frozen attempt.

Envelope `focus.resources` retains all binding associations but prepares canonical refs and images once per target, deduplicated against recursively selected nodes. These references do not enter `canvasContext.selectedNodes`, widen grounding, imply an internal PDF paragraph, or alter the receiving conversation. Missing/type-changed targets and unavailable required images fail explicitly. The shared internal/external renderer emits escaped `<ink_resource_references>` plus `<referenced_nodes>` guidance; labels are untrusted content, not instructions or permissions. Required raw-Ink images must still originate from the Ink snapshot inputs: referenced or optional images cannot satisfy that evidence requirement. Request, frozen retry, rendered input, and user-message history preserve the references, with source chips deduplicated against ordinary selection and attachments.

History reconstruction excludes both selected resource IDs and existing user-attachment `originNodeId` values before synthesizing Sigil source chips. An explicit attachment keeps its original metadata and appears once even when an off-selection Sigil references the same resource, matching live user-message assembly.

The normalized user input kind is `text` or `ink-intent`. An `ink-intent` turn may have empty text but must contain at least one partial Sketch selection with non-empty `strokeIds`; its selected strokes are the user's request rather than merely optional context. Envelope construction and canonical rendering therefore require a real image part for every required partial-Ink source and reject before Agent invocation if snapshotting or inlining fails. Legacy text turns retain best-effort optional visual behavior.

Ink envelopes also retain `focus.selection.inkGeometry`: per-Sketch `{ nodeId, strokeIds, bounds }` entries in absolute Canvas coordinates, computed from the same prepared node snapshot as the required image. Shared stroke projection and bounds helpers account for nested frames and scaling while excluding unselected strokes. Missing selected strokes or invalid geometry fail preparation explicitly. The shared renderer emits `<ink_query_geometry>` for built-in and external Agents; canonical rendered history preserves those coordinates rather than resolving them again. Older envelopes may omit the field. The per-turn directive requires agent-authored Canvas replies, follows explicit Ink spatial instructions first, and otherwise anchors results near the current query and related materials after live layout inspection. Conversation ownership remains independent of response placement.

The Lasso toolbar explicitly chooses one Ink destination: a new Agent conversation or an existing Question/Agent Node on the current Space. Selected Question nodes never infer a destination and are excluded from the captured source tree, including children of selected Frames; selecting several Questions is not a target ambiguity. No selected-node conversation history, summary, or memory is attached as reference content. Explicit continuation retains only the receiving conversation's normal history. Source exclusion reuses `getAgentChatContext`'s recursive exclusion list and feeds the same canonical tree to grounding metadata; ordinary text Chat references are unchanged.

When an Azure AI Vision endpoint and key are configured through Settings > General or the `VISION_ENDPOINT` / `VISION_KEY` environment fallbacks, envelope preparation also derives a transient white-background, dark-stroke OCR raster from the same frozen selected-stroke node snapshot used for the required visual. Images, ordinary objects, grounding pixels, and unselected strokes are excluded. Azure Vision recognition waits for at most 3 seconds; missing configuration, empty text, timeout, malformed output, or provider failure continues with the required image alone, while a user cancellation still stops the whole turn. A successful bounded result is rendered immediately after the Ink-intent directive inside an escaped `<ink_ocr>` block that tells the Agent to verify the approximate transcription against the image and clarify material conflicts. The browser never submits OCR text, and recognition is not projected into user text, source chips, inferred intent, Question naming, Sketch content, or search.

The OCR adapter implements Azure AI Vision's Image Analysis Read protocol only and restricts destinations to official public-cloud Azure resource or regional endpoints; it is not a generic OCR or LLM connector. Settings uses the existing secret-entry and deployment-readiness components, and all writes require writable secure storage. Endpoint and key overrides are committed as one encrypted configuration record. They take precedence independently over environment values and apply to the next OCR call without restarting; an in-flight provider request retains the complete configuration it already captured. See [credential storage](./credential-storage.md) for endpoint policy, migration, masked status, and removal semantics.

A mixed `ink-intent` turn also carries `focus.groundingVisual`: a bounded PNG captured from the browser's currently rendered React Flow DOM before asynchronous submission work. It preserves the user's current zoom-driven LOD, text truncation, clipping, and Ink/object placement while excluding selection outlines, retained-Lasso chrome, handles, toolbars, and drag/snap previews. The final captured `AgentChatContext.selectedNodes` tree is canonical for both dispatch and grounding metadata: selected Frames recursively include their children, partial Sketches already present in that tree are not appended again at the top level, and grounding node/stroke IDs are derived from the frozen tree. A Question anchor is excluded recursively even when nested in a selected Frame. The request schema requires those IDs and stroke subsets to match the submitted selection exactly. The image is rendered as a hidden canonical vision part for built-in and ACP Agents, persists in `AgentSubmission.rendered`, and is never projected as a user attachment or source chip.

```
POST /api/agent (agent.route.ts)
  ├─ loadAgent(mode)                  # system prompt + tool set
  ├─ readWorkspaceMemory()            # append <workspace_memory> to system prompt (built-in agent only)
  ├─ loadTurns + rebuildContextMessages   # rebuild prior turns
  ├─ buildChatEnvelope()              # this turn: text + selection + anchor + skills
  └─ runAgent(context, envelope)      # tool loop
```

`buildChatEnvelope()` ([envelope.ts](../../apps/server/src/modules/agent/conversation/envelope.ts)) renders this turn into tagged blocks:

- `<selected_nodes>` — selected nodes `id/type/label/filename/preview?`, **no content** ([prompt/selected-nodes.ts](../../apps/server/src/modules/agent/conversation/prompt/selected-nodes.ts))
- `<canvas_neighbourhood>` — bounded spatial neighbourhood of the anchor node (used by prompt/question nodes, [prompt/neighbourhood.ts](../../apps/server/src/modules/agent/conversation/prompt/neighbourhood.ts)). Ordinary spatial neighbours are limited to a 400 px edge-distance radius; every directly connected node, the direct containing Frame, and every direct sibling in that Frame remain included regardless of distance. Rendered **only on the live turn**: `rebuildContextMessages` passes `includeNeighbourhood: false`, so replayed history turns drop it while the current turn re-injects a fresh snapshot. This keeps the neighbourhood accurate (never a stale copy) and the committed message prefix cache-friendly (no N stale blocks piling up). The stored envelope keeps its snapshot untouched — this is a render-time gate only.
- `<invoked_skills>` — skills explicitly invoked via `/cmd` (see §3.2)
- `<ink_ocr>` — optional bounded server-derived handwriting evidence for explicit Ink-intent submissions; persisted as structured data in `AgentSubmission.content.focus.selection.inkRecognition` and as escaped untrusted approximate content in `AgentSubmission.rendered`. Replay consumes the canonical rendered inputs without another OCR call ([prompt/ink-ocr.ts](../../apps/server/src/modules/agent/conversation/prompt/ink-ocr.ts)).
- attachments → vision parts ([prompt/attachments.ts](../../apps/server/src/modules/agent/conversation/prompt/attachments.ts))

---

## 3. Prompt-level injection: workspace memory + skills + Space Prompt

These two are **cross-turn-stable** system-prompt injections (they don't change per turn), kept separate from the per-turn focus signals in §4.

### 3.1 Workspace memory

Every turn appends `user.md` as a `<workspace_memory>` tag block at the end of the system prompt (cache-friendly); built-in agent only — external/ACP has its own preamble. See [agent-memory.md](./agent-memory.md).

### 3.2 Skills — two injection paths

Skills are **not tools**; they reach the prompt via two complementary paths:

| Path                      | Trigger       | Form                                                                                                                                               | Where                                                                                                 |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **catalogue (on-demand)** | agent decides | system prompt expands `{{skillCatalogue}}` into a list (id/name/description only); the agent `read("skills/<id>/SKILL.md")` when it wants the body | [catalogue.ts](../../apps/server/src/prompt/skills/catalogue.ts) `getSkillCatalogue(scope)`           |
| **invoked (explicit)**    | user `/cmd`   | the skill's **entire body** is inlined as an `<invoked_skills>` block (authoritative for this turn)                                                | [prompt/invoked-skills.ts](../../apps/server/src/modules/agent/conversation/prompt/invoked-skills.ts) |

The catalogue is filtered by the agent's frontmatter `skillScope` (ask/operate/external); a `null` scope injects no catalogue. The difference: catalogue is "a menu you pull from on demand", invoked is "the user named it, full body forced into this turn".

### 3.3 Space instruction Frames

Space instruction Frames use two channels: Prompt Frames inject instructions into Agent Nodes, while Skill Frames extend the authenticated guide returned by `GET /skill`. Their trimmed, NFC-normalized labels match `prompt`, `prompt: <name>`, `skill`, or `skill: <name>` case-insensitively and require `labelSource` to be explicitly `user` or `agent`. Auto-generated, missing, or invalid label provenance never activates instruction Frame behavior; a colon without a non-whitespace suffix is also not recognized. The shared `classifySpaceInstructionFrame()` predicate in [node.ts](../../packages/shared/src/types/canvas/node.ts) is the canonical recognizer used by the server and the Frame badges.

[space-instruction-frames.ts](../../apps/server/src/modules/agent/space-instruction-frames.ts) scans one complete Space topology snapshot and canonical node records. A Prompt Frame with no direct Agent Node neighbours is global; when it has one or more direct Agent neighbours, it applies only to those Agents. An Agent Node is a Question Node with a non-empty `threadId`. Adjacency is one hop and endpoint-order independent; EdgeStyle, connections to non-Agent nodes, Agent-to-Agent paths, Frame descendants, and containing Frames do not expand the target set. Applicable instruction Frames are ordered by world `y`, world `x`, then stable Frame id. Only direct children participate; children are ordered by Frame-local `y`, Frame-local `x`, then stable node id, with Text and Note nodes left interleaved in that order.

Prompt Frames inject Text bodies and Note bodies eagerly in the same stable reading order. Each Note is wrapped in a source-attributed `<note id label file rev>` boundary and its body is capped at 10 KiB UTF-8 before entering the total Prompt budget; per-Note truncation is code-point-safe and reported by node id. Skill Frames keep Notes as lazy self-closing `<note id label file rev />` catalogue references whose bodies remain available through the RFS/download surface. Empty Text is omitted, unsupported direct-child types and missing canonical records are omitted with diagnostics, and nested descendants do not participate. Locked nodes remain eligible because locking constrains editing and layout rather than visibility; Huabu currently has no node-level private/hidden permission state to bypass.

The complete rendered `<space_prompt>` fragment, including stable template prose and diagnostics, is capped at 32 KiB UTF-8. Total-budget truncation is code-point-safe, reports that the budget was exhausted, and lists later nodes omitted completely from the rendered fragment. The live `<space_skill>` module remains capped at 16 KiB. A full-Space collection failure rejects first realization instead of silently producing an incomplete instruction set.

Space Prompt is captured for every Canvas-backed Agent Node, independently of whether its pre-first-turn binding policy is `selectable` or `fixed`. Ordinary node-less Canvas Chat, node-less ACP sessions, and the Memory Agent do not receive it. Creating an Agent without starting it and editing Canvas edges do not create a workload or capture a Prompt. Capture occurs at the first explicit interaction: a message for built-in Agents, or a message or mode/model/config control for external Agents. A create-and-start request completes Agent creation and then immediately reaches this boundary; callers that need to establish Prompt connections first use create-only, connect the nodes, and then prompt the Agent. GET-only capability reads do not realize the thread. Prompt applicability and content are read from one Space snapshot at realization, and the captured fragment is persisted in the complete durable WorkloadSpec and reused on later turns, so editing Prompt Frames or topology affects newly realized Agent Nodes but does not mutate existing conversations. Built-in agents place it after their trusted AGENT.md/workspace context and before node-specific initial instructions; external ACP agents place it after Huabu's mandatory bootstrap and before node-specific initial instructions. It remains user-authored context subordinate to system, developer, host-policy, and tool instructions, and it coexists with per-turn selection and neighbourhood context rather than replacing them.

Space Prompt and the Huabu Skill intentionally use separate delivery channels while sharing discovery, ordering, and diagnostics but applying channel-specific Note rendering and byte budgets. Prompt Frames state what Agent Nodes in this Space should do, inline their Note bodies, and are captured once. Skill Frames retain lazy Note references, are resolved live on every authenticated `GET /skill`, append after the current root guide, and never enter Agent Node preambles. Anonymous `GET /skill` continues to return only the bundled public guide. A legacy Space-specific `skill.md` remains the root-guide override; when present, live Skill Frames append after that override so existing behavior and new modular customization coexist. Skill Frame collection is additive: if topology or node records cannot be read, the failure is logged and the root guide is still served.

Recognized Prompt and Skill Frames carry a solid text badge beside the editable title in the internal canvas-space Frame header. Prompt uses the semantic info tone and displays its topology-derived scope as `Global`, `1 Agent`, or `N Agents`; Skill uses the semantic success tone. Badge typography derives from the responsive Frame title at 42%, clamped to 12–20 px, while its height and horizontal padding scale from that result; no icon slot is reserved. The badge is non-interactive and uses the same shared classifier and direct-Agent predicate as delivery.

---

## 4. Three "user pointing" signals: selection / anchor / attachment

The envelope splits "where the user pointed this turn" into orthogonal parts ([envelope.ts](../../apps/server/src/modules/agent/conversation/envelope.ts) `user` / `focus`):

| Signal         | What                                                              | Rendered as                                                                 | Carries                                                                              | Distinction                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **selection**  | nodes the user selected on the canvas                             | `<selected_nodes>`                                                          | `id/type/label/filename/preview?`, **no content**                                    | "I picked these nodes"; frames include children; selected sketch/image also auto-snapshot to a PNG vision part                                                                                                                                                                                   |
| **anchor**     | the single node the request is anchored at (e.g. a question node) | anchor identity named in prompt + `<canvas_neighbourhood>` (live turn only) | `nodeId/label` + spatial neighbourhood                                               | "I'm asking from this node" — only present on anchored turns; the neighbourhood disambiguates "this" / "the one above". The `<canvas_neighbourhood>` block rides **only the live turn** (omitted from rebuilt history, see §2) — a fresh snapshot each turn, kept out of the cache-stable prefix |
| **attachment** | off-canvas uploads pasted into the chat                           | `<attachment>`                                                              | image→base64 vision; pdf/web→extracted text; oversized images degrade to a text note | unrelated to the canvas; not a node                                                                                                                                                                                                                                                              |

Key differences: **selection / anchor point at existing canvas nodes** (enriched with a `preview` via node-ref; content via tools); **attachment is a one-off off-canvas asset** (content inlined directly). Anchor is "a single focus point + neighbourhood"; selection is "a set of node metadata".

Chat fragment comments are distinct from all three Canvas pointing signals. The browser captures selected visible assistant text and neighboring context, then stages a structured quoted comment in the owning thread's composer on explicit **Add to input** without rewriting its ordinary text draft. The optional `quotedComments` request field is validated once through the shared schema and preserved in `ChatEnvelope.user`; each entry holds quote, contextBefore, contextAfter and comment strings, not a permanent source reference. Both built-in and ACP rendering use the same escaped `<quoted_comments>` prompt section, where quoted response content and context are reference material rather than invoked slash commands or elevated instructions. The composer and historical user messages render the structured entries as quotation/comment cards; old records without this field remain plain text. The existing submission, binding/mode, attachment, permission and Stop behavior remains authoritative. A quotation is a capture-time snapshot: later source edits or message identity reconciliation do not remap it. See [Preview Workspace](./preview-workspace.md#1-ownership-boundaries) for editing, immediate submission-time clearing, failure recovery and draft lifetime.

### 4.1 Anchored conversation ownership

The web retains `AgentConversationView` for anchored Question conversations. Its `presentationAnchor` and `conversationOwner` identify the same Canvas and node, with the owner also carrying `threadId`. Validation requires that Canvas to be active and the live Question's thread to match. Legacy World `nodeRef` presentation and its source-reference resolver are removed; a Space Preview cannot open a source-owned conversation in the host Canvas.

History, reconnect, `/api/agent`, tools, lifecycle writes, binding/mode, and change records use the conversation owner's Canvas. The Question is sent as `anchorNodeId`; Canvas selection is included only when it belongs to that same Canvas. Unbound Chat has no anchored conversation view and uses its session Canvas.

First-turn composition requires `status: idle` and no non-empty authored `content` on the ordinary Question. No separately resolved World-reference content flag participates in this decision.

For every anchored `/api/agent` request, the server resolves `(canvasId, threadId)` to the authoritative Question owner before constructing the envelope. A client anchor that differs from that node, or an anchor for a thread with no Question owner, is rejected; the resolved node also supplies the effective persisted mode and fixed binding policy.

For both selection and anchor, the server enriches each node into an agent-facing object via the shared `describeNode` assembler (see §5) — `filename` (`nodes/<safeLabel>.md`) + `preview` (ladder `summary > content[:120] > src`) + `rev`, plus the parent label for frames. **No content / geometry sent** — content via `read("nodes/<id>.md")`, layout/style via `inspect_nodes`.

---

## 5. How a node becomes context (`describeNode` / `renderNodes`)

Every node that reaches the model — a selected node, a neighbour, an outline/inspect row — is assembled by **one** function and (for prompt text) rendered by **one** translator. This is the single place the node's `label / filename / preview / rev` shape is decided, so the call sites cannot drift.

Code: [node-prompt.ts](../../apps/server/src/modules/canvas/node-prompt.ts) (assemble) + [node-element.ts](../../apps/server/src/modules/agent/conversation/prompt/node-element.ts) (`renderNodes`).

### 5.1 `describeNode(store, input, level)` — node → data object

ONE rule: **the node carries whatever authored info the caller already has; anything missing (label / body / summary / src) is filled from the node's on-disk `.md` sidecar** — the canonical source. `space.json` never persists `data.label` and strips note bodies, so a caller holding only the raw canvas node hands in almost nothing and the sidecar supplies the rest (the caller's own value wins when present — e.g. the client wire `label` on a selection).

`level` is what the caller claims it needs:

| level       | shape              | fields                                                         |
| ----------- | ------------------ | -------------------------------------------------------------- |
| `'preview'` | `AgentNodePreview` | id, type, label, **filename**, preview, **rev**                |
| `'outline'` | `AgentNodeOutline` | preview + position, absolutePosition, size, parentFrame, style |

Both agent-facing levels **always carry `rev`** (the freshness / CAS token — see [agent-node-freshness-cas-plan](../proposals/agent-node-freshness-cas-plan.md)). The rev-less L0 `ref` is **deliberately not** an agent-facing shape: a node without `rev` can't participate in re-read / write-guard, so it stays internal to the pure ref builder. Parent-frame labels (a bare string, not a node) use `nodeLabel(store, id)`.

`AgentNodeOutline` carries geometry as a **local-vs-world pair**: `position` is parent-local (relative to the direct parent frame, or absolute for a root node) and is the sole writable coordinate; `absolutePosition` is the parent-chain-resolved world coordinate, read-only.

`filename` is `nodes/<safeLabel>.md`, derived from the (sidecar) label — the same path the RFS serves and whose `ETag` equals `rev`. Sourcing the label from the sidecar is what keeps that path real; reading it from `space.json` (always empty) would collapse it to a dead `nodes/<id>.md`.

### 5.2 `renderNodes(nodes)` — data object → `<node/>` XML

The single translator from data objects to the `<node id=… type=… label=… file=… rev=… preview=… />` elements the prompt shows. `file=` is always emitted — both backends address a node by its path (built-in `read()`s it; external/ACP downloads it over the RFS). Used by `<selected_nodes>` and `<canvas_neighbourhood>`.

**JSON tool results skip rendering:** `get_space_outline` / `inspect_nodes` return the `describeNode(…, 'outline')` objects directly as JSON; only the two XML prompt blocks go through `renderNodes`.

### 5.3 Where each caller plugs in

| Caller                                 | Assemble                                               | Render        | Medium |
| -------------------------------------- | ------------------------------------------------------ | ------------- | ------ |
| selection `<selected_nodes>`           | `describeNode(store, wireNode, 'preview')`             | `renderNodes` | XML    |
| neighbourhood `<canvas_neighbourhood>` | `describeNode(store, spatialNode, 'preview')` per node | `renderNodes` | XML    |
| `get_space_outline` / `inspect_nodes`  | `describeNode(store, spatialNode, 'outline')`          | — (direct)    | JSON   |

The envelope stores the **data objects** (not pre-rendered strings): the same node is rendered per-backend, so rendering is deferred to `renderNodes` at serialization time.

---

## 6. Tools (fetch the rest on demand)

[tools/definitions.ts](../../apps/server/src/modules/agent/tools/definitions.ts), assigned by each agent's `tools` frontmatter:

| Tool                            | scope       | Purpose                                                                |
| ------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `get_space_outline`             | ask/operate | whole-canvas geometry + topology + clusters, optional 120-char preview |
| `inspect_nodes`                 | ask/operate | predicate query of node geometry/style                                 |
| `inspect_edges`                 | ask/operate | edge direction/style                                                   |
| `read` / `grep` / `find` / `ls` | ask/operate | read/search canvas files                                               |
| `snapshot_nodes`                | ask/operate | node → PNG vision                                                      |
| `space_commands`                | operate     | mutate the canvas (server-side execution)                              |
| `fs_write`                      | operate     | memory/skill writes                                                    |
| `generate_image`                | operate     | AI image generation                                                    |
| `web_search`                    | ask/operate | Tavily                                                                 |

Skills are not tools (injection in §3.2). Spatial geometry primitives are in [canvas-spatial.ts](../../apps/server/src/modules/canvas/canvas-spatial.ts); the neighbourhood pipeline is in [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts).

---

## 7. Code entry points

| Concern                 | File                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context types           | [agent/context.ts](../../packages/shared/src/types/agent/context.ts)                                                                                                                                                                                                                                                   |
| Web assembly            | [canvasStore.ts](../../apps/web/src/store/canvasStore.ts)                                                                                                                                                                                                                                                              |
| Chat route              | [agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts)                                                                                                                                                                                                                                                   |
| Turn envelope           | [conversation/envelope.ts](../../apps/server/src/modules/agent/conversation/envelope.ts)                                                                                                                                                                                                                               |
| Ink OCR provider        | [conversation/ink-ocr.ts](../../apps/server/src/modules/agent/conversation/ink-ocr.ts)                                                                                                                                                                                                                                 |
| Ink OCR prompt          | [conversation/prompt/ink-ocr.ts](../../apps/server/src/modules/agent/conversation/prompt/ink-ocr.ts)                                                                                                                                                                                                                   |
| History rebuild         | [conversation/transcript/history.ts](../../apps/server/src/modules/agent/conversation/transcript/history.ts)                                                                                                                                                                                                           |
| Node → context assembly | [node-prompt.ts](../../apps/server/src/modules/canvas/node-prompt.ts) (`describeNode` / `nodeLabel`) · [node-ref.ts](../../apps/server/src/modules/agent/node-ref.ts) (pure ref/preview/outline builders) · [node-element.ts](../../apps/server/src/modules/agent/conversation/prompt/node-element.ts) (`renderNodes`) |
| Tool defs / executor    | [tools/definitions.ts](../../apps/server/src/modules/agent/tools/definitions.ts) · [tools/executor.ts](../../apps/server/src/modules/agent/tools/executor.ts)                                                                                                                                                          |
| System prompts          | [prompt/agents/](../../apps/server/src/prompt/agents) (ask / operate / memory each an AGENT.md, loaded by loader.ts)                                                                                                                                                                                                   |
| Skill injection         | [skills/catalogue.ts](../../apps/server/src/prompt/skills/catalogue.ts) (catalogue) · [conversation/prompt/invoked-skills.ts](../../apps/server/src/modules/agent/conversation/prompt/invoked-skills.ts) (invoked)                                                                                                     |
| External realization    | [external-agent-realization.ts](../../apps/server/src/modules/agent/acp/external-agent-realization.ts) (first interaction) · [space-instruction-frames.ts](../../apps/server/src/modules/agent/space-instruction-frames.ts) (Prompt collection)                                                                        |
| Spatial / neighbourhood | [canvas-spatial.ts](../../apps/server/src/modules/canvas/canvas-spatial.ts) · [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)                                                                                                                                                      |
