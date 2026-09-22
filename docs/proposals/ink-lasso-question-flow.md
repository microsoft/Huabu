# Ink Lasso Question Flow

> Status: **Proposed** · Last updated: 2026-09-22

## 1. Summary

Huabu should let a user lasso handwritten Sketch strokes together with optional Canvas nodes and explicitly submit that bounded selection as an Agent request. The selected Ink is a source that carries the user's intent. New tasks use the built-in Huabu `operate` Agent to infer that intent from the partial-stroke image and execute it through the existing Agent and Canvas toolchain; an existing Question thread retains its internal or external binding and effective mode.

The V1 flow reuses the existing Lasso gesture, retained stroke selection, partial-stroke snapshotting, Question Node lifecycle, Agent request pipeline, and Chat history. It does not add a second pointer engine, a separate Ink runtime, an intent-recognizer model call, or an Ink-specific execution backend. The executing Agent may publish one structured inferred-intent summary from the same turn so the generated Question and Ink history row become understandable without pretending the user typed that text.

The Post-V1 amendments add interaction polish in §14 and optional submission-time handwriting OCR enrichment in §15. When Azure Vision is configured, the server waits within a fixed deadline for an approximate transcription of a pure-Ink raster and includes a successful result beside the required Ink image in the same durable turn. OCR never replaces the image, becomes user-authored text, or arrives as a later Agent message; unavailable, empty, failed, or timed-out recognition falls back to the existing image-only flow.

The earlier interactive HTML concept was a visual exploration and is not included in this branch. This Markdown proposal is the self-contained implementation contract and records the deliberate differences from that concept in §3.

## 2. Goals

1. Turn an existing retained Lasso selection into an explicit, inspectable Agent submission.
2. Require at least one selected Sketch stroke so every V1 submission has an Ink intent source.
3. Let ordinary selected Canvas nodes accompany the Ink as additional sources.
4. Create a visible Question Node for a new task or continue one existing Question thread when the selection names it.
5. Let the Question's bound Agent infer a clear intent and act through its existing capabilities, or ask a focused clarification question when the intent is materially ambiguous.
6. Reuse Huabu's existing material-consistency boundary: materialize visual sources while building the envelope, persist canonical rendered inputs, expose revisions on referenced nodes, and protect Agent writes through read-set CAS.
7. Keep Chat available through the Question Node without opening it automatically for a normal submission.
8. Reuse one Agent-turn pipeline for Chat and Lasso submissions so lifecycle, persistence, streaming, cancellation, and error behavior cannot drift. Question anchoring is an optional capability of that pipeline, not a requirement imposed on ordinary node-less Chat.
9. Preserve the visible relationship between submitted Ink and selected Canvas objects through a hidden grounding image captured at the user's current zoom and text-detail level.
10. Replace generic Ink placeholders with a concise Agent-inferred intent when the executing Agent reports one, while preserving the original Ink provenance and every user-authored rename.
11. Optionally improve Chinese and mixed-language handwriting comprehension through bounded server-side OCR without adding another user message, Agent turn, or durable Sketch transcription.

## 3. Approved V1 Product Decisions

| Topic                               | Decision                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent inference                    | The Question's bound Agent interprets Ink in the same turn. New tasks use built-in `operate`; existing tasks retain their internal or external binding and effective mode. There is no separate intent-model call.                                                                                                              |
| Ambiguous Ink                       | The Agent does not guess an operation; it asks one focused clarification question in the Question thread.                                                                                                                                                                                                                       |
| Submission requirement              | At least one selected Sketch stroke is required. Ordinary nodes are optional additional sources.                                                                                                                                                                                                                                |
| Source language                     | The UI calls every included item a `source`; it does not expose separate intent/reference categories.                                                                                                                                                                                                                           |
| No Question Node selected           | Create a Question Node below the selection with collision avoidance, keep Chat closed, and start immediately. An open Preview/Chat Question is not an implicit target.                                                                                                                                                          |
| One Question Node selected          | Continue the Question/Agent Node actually selected by this Lasso, inherit its internal or external binding and effective mode, and exclude the Question Node itself from sources.                                                                                                                                               |
| Two or more Question Nodes selected | Disable submission and ask the user to narrow the selection. V1 does not merge threads or ask the user to choose a target.                                                                                                                                                                                                      |
| New Agent binding                   | New tasks use the built-in Huabu `operate` Agent. V1 has no Agent/Profile picker.                                                                                                                                                                                                                                               |
| New node title                      | Show `New ink request` while inference is pending. The first successful built-in Ink turn may replace only that untouched placeholder with its structured inferred intent; existing Question titles and user-renamed nodes never change.                                                                                        |
| Submission UI                       | Extend the existing `StrokeSelectionToolbar`; do not add a second floating toolbar or remove current stroke-editing actions.                                                                                                                                                                                                    |
| Agent target feedback               | Place a compact Agent target hint beside the source count. No selected Agent Node displays `New · Huabu`; one valid selected Agent Node displays its bound Agent name; multiple or invalid targets display the corresponding blocked state.                                                                                     |
| Mixed Ink grounding                 | A mixed Ink/object submission includes a hidden visual grounding image of the relevant visible Canvas region. It preserves the current viewport zoom, node LOD, text truncation, and Ink/object placement instead of re-rendering hidden detail.                                                                                |
| Grounding presentation              | The grounding image is Agent input, not a user attachment or source. ChatPanel never renders its thumbnail, filename, attachment row, or source chip, and it does not change the source count.                                                                                                                                  |
| Inferred intent presentation        | A structured inferred intent becomes the primary text of that Ink row and may name its newly created Question. It remains Agent-derived metadata, never user-authored `content`; the Pen affordance preserves Ink provenance.                                                                                                   |
| Missing or ambiguous inference      | Keep the generic `Ink request` / `New ink request` presentation. Clarification remains an assistant response, and Huabu never derives intent by parsing arbitrary reply text.                                                                                                                                                   |
| Request semantics                   | Persist a structured `ink-intent` marker. Do not pretend the user typed a synthetic text message.                                                                                                                                                                                                                               |
| Submission-time OCR                 | When Azure Vision credentials are configured, derive an approximate transcription from a pure-Ink raster after the required partial-stroke visual is prepared and before canonical rendering. A successful non-empty result enters the same envelope and turn; it never replaces the required Ink image or becomes `user.text`. |
| OCR deadline and fallback           | Wait at most 2,000 ms for OCR in the initial implementation. Disabled, empty, failed, malformed, or timed-out recognition continues image-only; a result arriving after the attempt deadline is discarded and never appended to a running or completed turn.                                                                    |
| OCR presentation                    | OCR is hidden Agent input and does not appear as a Chat message, attachment, source chip, Question title, inferred intent, or Sketch transcription. The prompt identifies it as approximate evidence that must be checked against the Ink image.                                                                                |
| Successful submission               | Clear the retained Lasso selection only after the server accepts the turn. The original Canvas content remains.                                                                                                                                                                                                                 |
| Failed submission                   | A rejection before acceptance keeps the selection and any created Question for retry. A transport failure with unknown acceptance requires reconciliation before resubmission. An accepted turn's later runtime failure uses normal Chat recovery.                                                                              |
| Consistency                         | Reuse Huabu's existing split semantics: visual sources are materialized for the turn, ordinary nodes remain revisioned live references, and Agent content writes use read-set CAS. Never widen a fully stale partial Sketch selection to the whole Sketch.                                                                      |

### 3.1 Differences from the HTML concept

The V1 product contract differs from the HTML concept in these deliberate ways:

- Voice input is absent, including the microphone affordance, recording state, transcription, and audio protocol.
- Selected Ink counts as a source. A selection containing one partial Sketch plus a PDF and a Note displays three sources.
- The submit action lives in the existing stroke-selection toolbar instead of a separate submit pill.
- Two or more Question Nodes block submission instead of creating a synthesized task.
- New tasks always use the built-in Huabu `operate` Agent.
- Existing Question targets retain an explicitly selected external Agent rather than being rebound to Huabu.
- New nodes initially display `New ink request`; a same-turn structured inferred intent may replace that untouched placeholder without a separate title-model call.
- Mixed Ink/object requests add a hidden WYSIWYG relationship image; they do not expose that derived image as a Chat attachment.

## 4. V1 Non-Goals

The V1 baseline does not include the following. Section 14 amends local interaction behavior and §15 adds only explicit submission-time OCR enrichment; the remaining exclusions still apply.

- voice recording or transcription;
- background or passive Sketch OCR, recognized text written back to Sketch nodes, OCR-backed search/indexing, or editable transcription UI;
- a standalone intent recognizer or utility-model role;
- an intent preview or confirmation step before execution;
- general-purpose automatic Question naming, parsing the Agent's prose for a title, or overwriting a user-authored title;
- an Agent/Profile picker in the Lasso toolbar or automatic rebinding of a target Question;
- a new ACP vision-capability negotiation protocol;
- multi-Question synthesis, thread merging, or target selection;
- handwritten sigils, capability palettes, Skill pinning, or task-level approval configuration;
- changes to Lasso hit-testing, pointer ownership, stroke movement, split/merge, erase, or undo behavior;
- a server-rendered or force-zoomed "ideal" node screenshot that reveals text/detail absent from the user's current Canvas LOD;
- a new Agent endpoint or a second SSE protocol.

## 5. Existing Architecture to Reuse

| Existing surface                                                                                                        | Current responsibility                                                                                                     | V1 use                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`gesturePreviewStore.ts`](../../apps/web/src/store/gesturePreviewStore.ts)                                             | Holds transient `sketchStrokeSelection` as `nodeId -> strokeIds` and clears Canvas-scoped previews.                        | Source of the retained partial-stroke selection; cleared only after accepted dispatch.                         |
| [`StrokeSelectionToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/StrokeSelectionToolbar.tsx) | Anchors stroke style/delete actions and arbitrates the single floating toolbar.                                            | Adds source count, blocked-state explanation, and submit action.                                               |
| [`agent.ts`](../../packages/shared/src/types/api/agent.ts)                                                              | Defines and validates `/api/agent` request context and `WireSelectionNode.strokeIds`.                                      | Adds only the durable Ink-submission semantic marker; source identity keeps its existing shape.                |
| [`envelope.ts`](../../apps/server/src/modules/agent/conversation/envelope.ts)                                           | Enriches selected nodes with previews/revisions and auto-snapshots selected Sketch/image nodes, including `strokeSubsets`. | Builds the point-in-time partial-stroke visual source and revisioned material refs without a new capture path. |
| [`build-prompt.ts`](../../apps/server/src/modules/agent/conversation/prompt/build-prompt.ts)                            | Renders one canonical text/image input sequence for built-in and ACP backends.                                             | Injects the host-owned Ink-intent directive for a structured `ink-intent` turn.                                |
| [`useAgentStream.ts`](../../apps/web/src/hooks/useAgentStream.ts)                                                       | Owns Question lifecycle, request scope, Agent binding, SSE, history, cancellation, and refresh.                            | Supplies behavior to the shared Agent-turn controller, retaining ordinary node-less Chat support.              |
| [`questionCompose.ts`](../../apps/web/src/components/Nodes/question/questionCompose.ts)                                 | Centralizes Question Node/thread creation and compose entry.                                                               | Supplies the canonical node/thread creation primitives without opening compose.                                |
| [`screenshot.ts`](../../apps/web/src/handler/canvasCommand/utils/screenshot.ts)                                         | Rasterizes the rendered React Flow Canvas DOM while preserving its current visual state.                                   | Supplies the canonical capture primitive for a cropped visible-Canvas grounding image.                         |
| [`agent-node-freshness-cas-plan.md`](./agent-node-freshness-cas-plan.md)                                                | Defines node revision signals, read-before-write, the per-session read-set, and executor CAS.                              | Remains the only content freshness and write-conflict mechanism for referenced materials.                      |
| [`question-node.md`](../architecture/question-node.md)                                                                  | Defines Question ownership, anchoring, lifecycle, and neighbourhood context.                                               | Remains the task and conversation model.                                                                       |
| [`sketch-node.md`](../architecture/sketch-node.md)                                                                      | Defines retained Lasso selection and partial-stroke AI context.                                                            | Remains the Ink selection and visual-source model.                                                             |

The key architectural fact is that partial Ink is already a first-class Agent source. `WireSelectionNode.strokeIds` persists with the request and `snapshot_nodes` accepts a KEEP-list. The snapshot implementation rejects a non-empty KEEP-list that no longer matches any stroke rather than rendering the whole Sketch, but the current envelope builder catches snapshot failures and continues without the image. V1 must propagate missing required Ink visuals through the shared preparation path; request rejection is a requirement, not existing behavior. V1 adds submission intent and routing, not another Ink representation.

## 6. Interaction Contract

### 6.1 Readiness

The toolbar derives a submission candidate from one coherent Canvas snapshot:

```text
retained stroke selection
        +
selected whole nodes
        |
        v
capture source ids and classify Question targets
        |
        +-- no Ink --------------------------> hidden or disabled
        +-- 2+ Question Nodes --------------> disabled: narrow selection
        +-- invalid Question target ---------> disabled: repair target
        +-- 0/1 valid Question target -------> ready
```

The presence of at least one non-empty `strokeIds` array is the V1 intent gate. A whole Sketch selected through ordinary Select does not satisfy this gate because it does not identify the Ink the user is submitting as the request.

Every included non-Question selection member uses the existing source-count contract. A partial selection from one Sketch node is one source regardless of its stroke count. The routing Question Node is an anchor, not a source, and is removed from the outbound selected-node list exactly as current anchored Chat already does.

Question targeting is exclusively Canvas-gesture-owned. The target set comes from the current Lasso's whole-node selection; the active Preview Workspace tab, open Chat thread, and most recently viewed Question never act as fallbacks. At collapsed zoom, a Question/Agent Node is hit-tested against the visible takeover mark's blended Canvas-space rectangle rather than the faded React Flow card footprint, so circling the Agent mark selects the node the user can actually see.

### 6.2 Toolbar behavior

`StrokeSelectionToolbar` remains the only floating surface for a retained stroke selection.

- The submit action and source count appear for pure and mixed selections on mouse, pen, and touch.
- A compact Agent target hint appears in the same toolbar metadata cluster as the source count. It indicates whether this Lasso includes a routing Agent Node and is not included in the source count.
- With no selected Agent Node, the hint reads `New · Huabu`, communicating that submission will create a new Question bound to the built-in Agent. With exactly one valid selected Agent Node, it shows that Question's effective bound Agent display name, including an external Agent Profile name when applicable; it never substitutes the Question title.
- With multiple selected Agent Nodes or one invalid target, the hint shows the matching blocked state instead of an Agent name, and the send control remains disabled. Long Agent names truncate without resizing the toolbar and expose the complete name through a tooltip and accessible label.
- Existing color and size controls remain available only for a pure stroke selection.
- Existing touch delete behavior remains available.
- Mixed desktop selection no longer makes the toolbar disappear: it suppresses style controls but retains the submit action.
- The send control uses the shared `Button`/`FloatingToolbar` primitives and a Lucide send icon, with an accessible label and disabled-state explanation.
- Pointer-down inside toolbar controls must not start a stroke move or a new Lasso gesture.
- Repeated activation while the same turn is submitting is ignored.

### 6.3 New task

When this Lasso selected no Question Node, the client creates one Question Node and one thread before dispatch:

1. Compute the absolute bounds of the retained stroke and whole-node selection.
2. Choose a point below those bounds using the existing placement and collision-avoidance helpers.
3. Create a Question Node with a fresh node ID and thread ID, the built-in Agent binding, `operate` mode, the V1 placeholder `New ink request`, and an explicit pending-inferred-label marker. A user rename clears that marker.
4. Await a success-reporting form of the existing Canvas save boundary so the server can resolve the new anchor and selected Ink. Reuse the structure scheduler and node-content queue behind `drainPendingSaves()`; its current navigation-oriented promise settles even on save failures, so awaiting it alone does not prove persistence. Keep the action-log `flushCanvasEvents()` separate. Do not use a timer or a second save implementation.
5. Dispatch the structured Ink turn with the new node as `anchorNodeId` and keep the Preview Workspace closed.

The Question Node's position gives the Agent the normal bounded neighbourhood. Nearby Canvas nodes are ambient context only; they do not become selected sources unless the user lassoed them.

### 6.4 Existing task

When exactly one Question/Agent Node selected by this Lasso owns a valid thread, that node becomes the conversation owner and `anchorNodeId`. The turn inherits its persisted or pre-first-turn cached binding and effective mode. This includes a newly created selectable Question whose user explicitly chose an external Agent before its first send. The target node is excluded from selected sources, while the selected Ink and ordinary nodes become the new turn's sources.

For internal bindings, inheritance includes `ask`: it interprets the handwritten request using its normal read-only tool set and does not become `operate` merely because the input is Ink. New tasks still start in `operate`. External bindings retain their existing ACP session and capability surface; Ink submission does not silently rebind them or invent an internal mode.

External ACP delivery is explicitly best effort in V1. Huabu's canonical renderer already carries the required partial-stroke image as an ACP image content block, and external Agents already receive Canvas-scoped RFS read/write access. Huabu does not yet have a reliable ACP/Profile field that proves the selected Agent's underlying model supports vision, so the toolbar must not claim compatibility or silently switch models. An Agent that cannot process the image follows its existing error or clarification behavior; the Question and retained selection remain available when the request is rejected before durable acceptance.

### 6.5 Completion and clarification

The bound Agent receives a host-owned directive equivalent to:

```text
Treat the selected Sketch strokes as the user's request. Infer the intended task from the Ink and the other selected Canvas sources, then respond using the current mode and its available tools. In operate mode, execute a clear task. In ask mode, answer within its read-only capabilities. If the intended task is materially ambiguous, do not guess; ask one focused clarification question.
```

This directive is product policy, not OCR output and not Canvas-authored text. The selected Ink remains user content and cannot override higher-level safety, permission, or tool policy.

A configured submission-time OCR result is additional approximate evidence for this same interpretation step. The directive tells the Agent to verify the transcription against the required Ink image, preserve uncertainty, and choose `clarify` when a material image/OCR conflict changes the likely operation. OCR does not remove the requirement to call `report_ink_intent`, and it cannot override higher-level instructions or tool policy.

A clear request follows the normal `running -> done/error` lifecycle. An ambiguous request completes the turn with a clarification question; the Question Node's unread terminal-state affordance leads the user into the existing Chat UI. V1 does not introduce a separate `clarifying` node status.

Existing permission requests remain authoritative. Ink submission never enables auto-approval or bypasses a configured approval boundary.

### 6.6 Visible Canvas relationship grounding

A mixed selection containing Ink plus at least one ordinary non-Question Canvas object requires a relationship grounding image in addition to the existing partial-stroke visual and node refs. The partial-stroke image answers "what Ink was submitted" and the node refs/read path answer "what the objects contain"; the grounding image answers "where the Ink landed relative to the visible object and its currently visible internal elements." Without this third signal, an arrow aimed at one visible list item can be misread as an instruction to resize or rewrite the whole node.

The Web client captures the grounding image from the rendered Canvas DOM at activation time, before asynchronous save/Question creation can alter the scene. Its semantic content must match what the user could see at that moment:

- preserve the exact current viewport transform, zoom-derived node LOD, visible text hierarchy, truncation, clipping, collapsed Agent marks, and relative Ink/object geometry;
- crop the union of the submitted strokes and selected ordinary objects, intersected with the visible viewport and padded enough to retain arrow shafts, underlines, and nearby target context;
- include user-authored Canvas content and Ink, but suppress transient application chrome such as the floating toolbar, selection outlines, resize handles, ports, retained-Lasso dashes, hover effects, and the newly created Question Node; suppressing chrome must not change node layout or LOD;
- never force zoom, expand a node, substitute canonical full text, re-render at another breakpoint, or include off-screen/hidden detail. Raster scaling may resize pixels for transport, but it must not cause the DOM to choose a different detail level;
- record the capture's viewport, zoom, crop rectangle, device-pixel ratio, selected ordinary node IDs, and stroke subsets so the model-facing caption can distinguish relation evidence from canonical object content.

The grounding visual defines interpretation granularity. At a zoom where only a node shell/title is visible, the Agent may infer only node-level pointing. At a zoom where a particular paragraph, list item, or diagram label is visibly rendered, the Agent may use the Ink landing position as evidence for that visible sub-element. The Agent still reads canonical node content through `read()` and exact geometry through `inspect_nodes()`; those channels may explain the selected object but must not retroactively manufacture a more precise visual target than the grounding image shows.

The request carries this image in a dedicated grounding field rather than `attachments`, `imageAttachments`, or the user-visible source projection. The canonical renderer wraps it as host-labelled user-content evidence equivalent to "Visible Canvas relationship at submission zoom" and sends it to built-in and external Agents as an image part. It remains untrusted Canvas content, cannot override host/tool policy, and must not be described as a file the user uploaded.

The grounding image is deliberately invisible in ChatPanel. Optimistic messages and durable history continue to show only the Ink request row, actual source chips, stroke counts, and user attachments. They do not show a grounding thumbnail, filename, attachment count, source chip, hover target, download action, or placeholder. The image and its capture metadata persist inside the turn envelope/canonical `AgentSubmission.rendered` input so reconnect and replay deliver the same model input without exposing a second user-visible message artifact.

### 6.7 Inferred intent presentation

The generic `New ink request` Question label and `Ink request` Chat row are pending-state fallbacks, not the final description when the executing Agent can state what it understood. Commit 6 adds one structured, hidden intent-reporting primitive to the existing turn rather than a second inference call. For built-in Ink turns, the host makes `report_ink_intent` available as a narrow internal tool and the Ink directive asks the Agent to invoke it once, before acting or asking for clarification:

```ts
type InkIntentReport =
  | { status: 'inferred'; text: string }
  | { status: 'clarify' | 'unsupported' };
```

`text` is trimmed plain text, one line, contains no Markdown, and is bounded to a concise display length. It describes the actionable interpretation rather than narrating recognition, for example `Expand the third comparison step in the left note`. The tool invocation and validated payload are persisted inside the same Agent turn but are hidden from ordinary tool-call rendering; live and history projections expose only a typed `inferredIntent` field on the corresponding Ink user item. Huabu never extracts this field from assistant prose, plans, `session_info_update.title`, tool side effects, or the Question label.

The ChatPanel preserves authorship honestly. Before a valid report arrives, the row shows the existing localized `Ink request` fallback. After an `inferred` report, the inferred text becomes the row's primary text while the Pen icon and accessible description identify it as an Agent interpretation of Ink. The original user `content` remains empty and immutable, the hidden grounding image remains invisible, and source chips/attachments are unchanged. `clarify`, `unsupported`, a missing report, malformed text, or an Agent error leaves the fallback in place.

Only a Question created by this Ink attempt is eligible for automatic naming. The server resolves the reporting turn's authoritative Question owner and updates its label through the canonical Canvas executor only when the node still carries the pending-inferred-label marker and its label remains the untouched placeholder. The patch writes `labelSource: 'agent'`, clears the pending marker, and never writes the inferred text into `QuestionNodeData.content` or `responseSummary`. Existing Question targets are thread titles rather than per-turn summaries and are never renamed; a user rename wins even if it races with the report.

The folded turn retains the validated report so history hydration and conversation search can project the same inferred text without rerunning a model or reading the current Question label. Each Ink follow-up owns its own report. Reconnect observes the already persisted report; an explicit retry creates a new turn whose row begins with the fallback and may receive a new report, while the original turn keeps its original interpretation.

External ACP Agents do not currently have an authoritative host intent-reporting capability. Their Ink turns therefore keep the generic fallback unless a future ACP capability exposes the same validated structured primitive; Huabu must not repurpose ACP session titles or parse external reply prose. Full external parity requires a later ACP contract or a separately approved preflight inference call, neither of which blocks external Ink execution itself.

## 7. Durable Request and Material Consistency

### 7.1 Structured submission kind

The shared `/api/agent` request schema gains a backward-compatible structured marker. The exact schema should remain zod-first in [`packages/shared/src/types/api/agent.ts`](../../packages/shared/src/types/api/agent.ts); web code imports only inferred types.

Conceptually:

```ts
type AgentInputKind = 'text' | 'ink-intent';

interface AgentRequestInput {
  inputKind?: AgentInputKind; // absent means legacy text
  content: string;
  groundingVisual?: VisibleCanvasGrounding;
}

interface InkRecognition {
  provider: 'azure-vision';
  apiVersion: string;
  lines: Array<{
    text: string;
    confidence?: number;
  }>;
  originNodeIds: string[];
}
```

Validation rules:

- absent or `text` requires non-empty `content`, preserving current behavior;
- `ink-intent` permits empty `content` but requires Canvas context with at least one partial Sketch selection;
- `ink-intent` accepts internal and external bindings; new tasks use built-in `operate`, while existing targets preserve their authoritative binding and effective mode;
- the complete kind and captured source list persist in the existing durable submission, not in a second Ink request store;
- durable recovery/replay consumes stored rendered input without rendering against a newer Canvas; the currently unimplemented HTTP fork operation is not added by this feature.
- `groundingVisual` is accepted only for `ink-intent`, is required when the captured selection contains at least one ordinary non-Question object, and is validated as a bounded Canvas screenshot plus capture metadata; it is never projected as a Chat attachment/source.

For an external Agent, the live ACP `session/prompt` carries the same required image blocks as the persisted rendered submission. If Agenetes cannot resume the native ACP session and must reconstruct earlier turns through its text-only history channel, historical image bodies become explicit `image omitted` placeholders. This makes the loss visible but cannot guarantee that every external Agent asks for resubmission; a follow-up that depends on omitted Ink may require the user to submit the relevant strokes again. V1 does not claim image-faithful ACP fallback replay and does not disable an otherwise usable live external turn because of that recovery limitation.

`ChatEnvelope.user` carries the normalized input kind so prompt rendering and transcript projection do not infer behavior from empty text or node types. The transcript renders an Ink request row plus normal source chips and stroke hover re-highlighting. It does not render the host directive as if the user typed it.

`InkRecognition` is server-derived preparation data under `ChatEnvelope.focus.selection`, not a field accepted from the browser in `AgentRequestInput`. The server bounds line count and total text length, validates the Azure response, and renders the result inside a host-owned `<ink_ocr>` boundary as untrusted approximate user-content evidence. XML-special characters are escaped. Line order and available confidence values remain structured until rendering; the server does not auto-correct, promote, or write the transcription back to a Sketch.

The inferred intent is a turn result, not request content. It is persisted from the validated `report_ink_intent` call in the folded turn and projected into `ChatHistoryItem.inferredIntent`; it is never inserted into `ChatEnvelope.user.text`, `QuestionNodeData.content`, `responseSummary`, or the immutable submitted grounding image.

### 7.2 Reuse the existing submission boundary

Ink submission does not add client-authored revision fields or a second all-or-nothing material validation protocol. It reuses the same server-owned boundary as ordinary Huabu Chat:

1. `/api/agent` resolves the effective thread and binding, then builds one `ChatEnvelope` before invoking the Agent.
2. Envelope construction reads selected-node records from the canonical store, emits metadata refs with their current `rev`, and materializes selected Sketch/Image visuals through `snapshotNodesToArtifacts()`.
3. When submission-time OCR is configured, the server derives a separate pure-Ink raster from the same frozen stroke subsets and waits within the §15 deadline for recognition. It does not OCR a mixed Sketch/Image composite or the visible-Canvas grounding image.
4. The Agent service renders the complete envelope into canonical `AgentInput[]` before `handle.run()` and stores those inputs in `AgentSubmission.rendered` with the turn.
5. Replay consumes the stored `rendered` inputs byte-for-byte, including image parts and any rendered OCR evidence, instead of rebuilding them or calling the OCR provider again.

This gives each source kind the same temporal semantics it already has in Huabu:

| Source kind                      | Turn-time behavior after the user submits                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selected Ink / Sketch visual     | The server renders the selected `strokeIds` into the turn's image artifact while building the envelope. Later Canvas edits do not alter the persisted rendered input. An unmatched non-empty KEEP-list fails snapshotting instead of widening to the whole Sketch. V1 must additionally stop an Ink-intent turn when required visual preparation fails; the current envelope builder treats snapshot errors as best-effort omissions. |
| Selected Image visual            | The server resolves the selection visual into the canonical rendered input; replay does not resolve the current node again.                                                                                                                                                                                                                                                                                                           |
| Uploaded or excerpted attachment | Its submitted content is rendered and persisted with the turn.                                                                                                                                                                                                                                                                                                                                                                        |
| Selected Note/PDF/Web/other node | The envelope stores a metadata ref with `file`, preview, and `rev`, not a full body snapshot. If the Agent needs the body, `read()` returns the latest canonical content and its current revision.                                                                                                                                                                                                                                    |
| Mixed Ink/object grounding       | The browser captures the visible relationship at the activation-time viewport/LOD and the server persists it as a hidden canonical image part. It provides pointing evidence only; canonical object content still comes from refs and `read()`.                                                                                                                                                                                       |
| Submission-time OCR              | The server derives a pure-Ink raster from the same stroke KEEP-lists after required visual validation. A successful bounded result becomes hidden canonical text evidence in this turn; disabled, empty, failed, malformed, or timed-out recognition leaves no OCR block and preserves image-only behavior.                                                                                                                           |

The selected Note/PDF/Web/other-node row is intentionally a live-reference contract. If a user edits an ordinary selected material after submitting but before the Agent first reads it, the Agent reads the newer content. Huabu surfaces the envelope revision and fresh read revision so the change is observable; V1 does not fork or duplicate the node merely to preserve the earlier body. The grounding image remains the point-in-time visual evidence of what was visible when the gesture was submitted.

Capturing source identities is not an atomic material snapshot at click time: metadata, neighbourhood, and images are read during separate server preparation steps. The client captures IDs and stroke KEEP-lists consistently, while the existing server determines their materialized content.

### 7.3 Reuse read-set CAS for write conflicts

Reading a node through the built-in `read()` tool records its current revision in the thread's session read-set. Any later Agent-authored content mutation receives `expectRev` from that read-set at the `canvas_commands` boundary. The executor rejects two unsafe cases through the existing structured conflict result:

- `not-read`: the Agent attempts to rewrite authored content it did not read;
- `stale`: the user or another turn changed the node after the Agent read it.

The Agent then re-reads, reconciles, and retries through the existing tool loop. The Ink feature must not add a bypass, a parallel expected-revision field, or toolbar-owned conflict resolution. Geometry and structure continue to follow their existing command/realtime-sync semantics because content revisions deliberately exclude those fields.

The selected Question target is still resolved server-side from the current thread ownership and binding rules. Existing conversation-integrity validation remains authoritative; the Ink path does not duplicate it in the selection wire.

## 8. One Shared Agent-Turn Pipeline

The current `useAgentStream.startStream()` combines Chat input collection, optional Question lifecycle, and turn execution. It rejects empty text and reads selection at multiple points around asynchronous work. Calling it unchanged from a hidden Chat instance, or calling `/api/agent` directly from the toolbar, would preserve the wrong ownership boundary.

Extract the existing implementation into a component-independent, thread-scoped controller with two thin input adapters. Keep ordinary node-less Chat, anchored Chat, and cross-Canvas conversation ownership working through the same path. This is a focused extraction, not a new Agent framework or a migration of all Question lifecycle ownership to the server.

```text
Chat composer -> text/skills/uploads + captured Canvas sources
Lasso adapter -> ink-intent + captured Canvas sources + Question target
                                                                              |
                                                      shared turn controller
                                                                              |
                                                 existing Agent API/SSE
                                                                              |
                                          envelope -> rendered input -> Agent
```

### 8.1 Explicit input, shared normalization

Only the input payload discriminates text from Ink. Sources, attachments, owner, mode, settings, and stream options remain common controller arguments using existing shared types. Do not introduce an Ink-only equivalent of `AgentChatContext`, `ChatSession`, `ChatEnvelope`, or `AgentSubmission`.

- Capture source node IDs and stroke IDs before the first asynchronous validation or Question creation. Extract or parameterize the serializer behind `getAgentChatContext()` so both adapters use its partial-stroke merging and recursive Frame handling. Derive wire context, optimistic history metadata, and source count from that same captured selection.
- For a mixed Ink/object submission, capture the visible-Canvas grounding bitmap and metadata from the same synchronous selection/viewport snapshot. Keep it outside Chat drafts, pending attachments, source count, optimistic attachment rows, and source chips.
- Captured selection fixes membership, not content revisions. Do not reread the active Canvas selection later to decide what this turn includes. Server materialization retains §7 semantics.
- The Chat adapter owns draft consumption, slash-command parsing, staged uploads, and the shared text-excerpt attachment. Preserve its current UI behavior during extraction. The Lasso adapter supplies no such extras in V1 and must neither consume nor clear another composer's draft, uploads, excerpt, or invoked skills, even when that composer shows the same target thread.
- Resolve the target's binding, mode, model, and reasoning settings through the existing conversation/thread mechanisms. New Ink tasks explicitly select internal `operate` and otherwise use ordinary built-in defaults. Existing targets retain their own cached or persisted internal/external binding; they never inherit an unrelated active tab's Profile or settings.
- Keep presentation-only guards, such as whether a submitting Chat tab still exists, in the adapter. Keep owner integrity and Canvas scope validation shared; a background caller must not need a fabricated Preview tab.

### 8.2 Reuse Map and Ownership

| Concern                   | Existing owner to reuse                                                                 | Required shared boundary                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation identity     | `conversationOwner.ts`, `ChatSession`, Preview Workspace                                | Use owner Canvas/node/thread, not active UI globals. Preserve World/headless selection exclusion; V1 does not introduce cross-Canvas Ink source transfer.                                    |
| Sources and source chips  | `canvasStore.getAgentChatContext()`, `WireSelectionNode`, transcript selection fields   | One serializer and one source projection for both inputs, including Frame children and stroke KEEP-lists. The Question anchor is not a source.                                               |
| Settings and binding      | `chatStore` thread selectors, conversation binding resolution, server thread settings   | Retain first-send locking, fixed-owner authority, and compose-cache handoff. Ink adds no settings store or model-routing policy.                                                             |
| Duplicate dispatch        | `agentStreamCoordinator.ts`, per-thread loading, `AgentThreadService` lease             | Reuse the same Canvas/thread claim for POST and attach, including sends initiated from another surface. Busy rejection remains `thread_busy`; a lease is not request idempotency.            |
| Saving before preparation | Existing structure scheduler and node-content queue behind `drainPendingSaves()`        | Add a success-reporting submission barrier in the save layer, used by both adapters. Preserve navigation's non-rejecting drain behavior. Keep behavioral-event flushing separate.            |
| Question lifecycle        | `questionCompose.ts`, `conversationOwner.ts`, existing fixed/selectable lifecycle split | Extract create-without-opening from compose creation; reuse binding, running/error/done, viewed/unread, and owner refresh. Do not copy lifecycle code into the toolbar.                      |
| Stream and cancellation   | `agentApi`, `handleStreamEvent`, stream coordinator                                     | One event reducer and one stop path. Stream ownership outlives Chat mount; closing a tab is not stopping the Agent. Opening Chat during an Ink run must not create a duplicate subscription. |
| History and recovery      | `useChatHistory`, shared transcript projection, existing stream attach                  | Preserve rendered submissions, event replay, history loading, settings restoration, and deduplication through existing paths. Do not add Ink-only history hydration.                         |
| Retry                     | Current Chat retry action and shared user-message metadata                              | Replace text-only resubmission with a typed retry descriptor derived from the submitted input. Both text and Ink use this one retry path; see §9.                                            |
| Tools and context         | Existing envelope/renderer, memory, skills, Space Prompt realization, tool policy       | Input kind changes only turn interpretation and required-input validation. No second system prompt, tool loop, memory scope, approval policy, or automatic Skill inference.                  |
| Feedback and changes      | Existing Question mark, Chat messages, permission tray, thread change-review store      | Feed the same stores and reuse their presentation. Preserve all event kinds during extraction, including ACP permission and change-review behavior.                                          |

### 8.3 Controller Lifetime and Question Creation

The shared controller is callable without React mounting. Reuse or extend the module-level stream coordinator rather than adding a parallel Ink controller registry. Chat hooks subscribe to thread state and delegate sending/stopping; the Lasso adapter calls the same service. A newly opened Chat can stop a run started from the Canvas. Unmounting the initiating toolbar or closing a tab cannot discard its lifecycle callbacks or turn state.

Split `createQuestionNodeAndCompose()` into a canonical create/initialize primitive plus the existing open/focus effect. Existing Chat and placement callers retain their behavior. The Ink caller uses the create-only primitive with an explicit binding/mode. Selection geometry and collision-aware placement stay in the Canvas layer and never enter the stream controller.

`New ink request` is a pending display label, not authored `content` and not a synthetic first user message. Ink first-send initialization skips the textual content write that triggers Question label generation. Reuse the normal non-idle lifecycle and first-turn binding rules so an empty-content Ink Question is not repeatedly treated as a new compose session. Only the structured §6.7 report may replace the untouched placeholder; do not add a separate `inkRunning` flag or parse the Agent's reply for a title.

### 8.4 Shared Gaps to Close, Not New Ink Services

Five existing mechanisms require a small shared extension before either adapter can safely rely on the new contract:

1. **Persistence result:** current action-log flushing is unrelated to node persistence, and `drainPendingSaves()` reports settlement rather than success. The submission barrier must report failed/conflicted structure or content saves and verify the intended Canvas scope before sending. Use existing queues and conflict handling, not direct toolbar HTTP writes or a new autosave path.
2. **Durable acceptance:** the initial SSE `meta` precedes turn persistence. Expose a typed acceptance notification through the existing Agent SSE/transport/controller after the canonical turn-start boundary, reusing the existing turn-start readiness mechanism. It must carry canonical turn identity and be tested against preparation/persistence failure; do not infer acceptance from the first arbitrary event.
3. **Required visual input:** ordinary Chat snapshots and image inlining are currently best effort. In the same envelope/renderer, derive required Ink visuals from `inputKind` and the partial selection. If a required source cannot be snapshotted or inlined as an actual image part, reject preparation instead of executing a text fallback with the handwritten request missing. For built-in Agents, inspect the effective model's existing image capability metadata, including explicit per-thread model overrides. For external Agents, deliver the image block best effort because ACP currently has no authoritative vision-capability field; do not silently change Agents/models or imply guaranteed support. Preserve best-effort behavior for optional visuals on legacy text turns.
4. **Visible relationship grounding:** extend the existing Canvas DOM screenshot primitive with a bounded semantic-content capture mode that preserves current zoom/LOD while excluding UI chrome. Carry the result through the shared request/envelope/renderer as a hidden required image for mixed Ink/object turns. Do not overload user attachments, source snapshots, or transcript projection with this derived visual.
5. **Structured inferred intent:** add the built-in `report_ink_intent` tool and one typed folded projection shared by live and history rendering. The handler validates concise plain text, associates it with the active Ink turn, and conditionally renames only the pending auto-created Question through the server executor. Keep the tool row hidden and keep the interpretation out of user-authored content.

The shared Stop path participates in durable acceptance. `POST /api/agent/stop/:threadId` aborts the active invocation and returns its synchronously recorded turn-start state before the browser aborts its local stream. If the turn has started, the response carries the same acceptance identity; if it has not, Stop seals the state as unaccepted and both Agent runners check cancellation immediately before starting durable execution. The controller routes SSE and Stop acknowledgements through one deduplicating acceptance sink. This prevents a Stop racing with turn persistence from retaining an already-consumed Ink selection and making duplicate submission appear safe without making Stop wait on pre-turn preparation.

The input-kind branches belong at validation/rendering and honest message presentation boundaries. Loading, errors, retries, cancellation, replay, settings, and tool execution must not branch into separate Ink implementations. Characterize existing text Chat before extraction and add cross-entry tests for each shared extension.

## 9. State and Failure Model

```text
selection-ready -> capture operands + reserve local preparation
      -> resolve/create Question -> await successful saves
      -> shared request preparation and dispatch
           +-- known rejection -> retain target + selection for retry
           +-- transport ambiguity -> reconcile history/live stream
           +-- durable acceptance -> running + retire captured selection
                                        +-- answer/task -> done/error
                                        +-- ambiguity -> done + clarification
```

The new Question Node is retained if dispatch fails after creation. Automatic deletion would require unsafe compensation across Canvas persistence and Agent history boundaries and could remove a node the user has already seen or moved. Keep the created target in the local submission attempt: retrying that failed attempt or reactivating the unchanged candidate must reuse its node/thread, not classify the still-selected sources as another new task. Guard local preparation before minting IDs; the shared per-thread stream claim cannot prevent two nodes being created before a thread exists. This local guard is not a second stream coordinator.

The accepted boundary must be explicit and shared with text Chat. The current initial SSE `meta` is emitted before the invocation is consumed and before `handle.run()` persists the submission, so it is not a durable acceptance acknowledgement. V1 needs a shared, typed acknowledgement emitted only after the canonical turn-start persistence boundary; the client transport/controller must expose it to both callers. Neither a resolved `fetch` nor the current `meta` event authorizes selection clearing. This is an extension to the existing Agent SSE contract, not a separate Ink protocol.

At acknowledgement, retire the retained selection only if the originating Canvas and Lasso gesture identity still match the captured attempt. That identity is derived from the retained polygon plus its partial-stroke subsets, not React Flow's whole-node `selected` projection, because Question creation and Canvas lifecycle synchronization may refresh that projection before acceptance without creating a new Lasso. A different polygon or stroke subset, undo/reset, or Canvas switch must not be cleared by a delayed callback. Once a turn has been accepted, a later Agent error does not restore an obsolete selection over the user's current work.

OCR does not add another state machine. The server waits only during pre-acceptance preparation. A 1,500 ms threshold is observability-only; the initial 2,000 ms hard deadline is the sole flow-control timeout. The OCR fetch should consume the request/preparation `AbortSignal` when one is available and must always enforce its own deadline. Physical cancellation is an optimization, not the correctness boundary: after timeout, abort, or attempt completion, a late promise result is logically ineligible and cannot mutate the envelope, rendered inputs, history, Question, inferred intent, or any active turn.

### 9.1 Retry Is Not Replay

The current Chat retry action calls `startStream(lastUserMsg.content, mode)`, losing the original source/attachment/Skill input and failing outright on an empty-text Ink message. Replace it in the shared path, not with an Ink-only retry button:

- **Reconnect/recovery:** observe the already-started turn through existing history/live-stream attachment. Durable rendered inputs remain unchanged; do not issue another POST or re-snapshot sources.
- **Explicit retry after a known rejection or terminal failure:** submit a new turn to the same owner with the original input kind, user text, attachment refs, source IDs/stroke IDs, explicit invoked skills, and the original hidden grounding visual/capture metadata. The grounding image records the original gesture's pointing evidence and is reused rather than silently recaptured from an unrelated current viewport; ordinary node/Ink materialization otherwise follows the existing fresh-read semantics. Do not borrow current selection or pending composer attachments. Resolve binding/mode and current target-thread settings through the normal path, and make the user create a new Lasso submission when they intend a new visual relationship.
- **Unknown acceptance after connection loss:** keep the target and reconcile using the existing thread history/stream before offering resubmission. Neither the local claim nor server lease provides idempotency. Do not silently auto-POST after reconnect; if reconciliation cannot resolve the outcome, report it and require an explicit user decision before risking another turn.

Persist the input kind and sufficient source metadata through the common transcript/history projection so retry works after reload as well as for an optimistic row. A pre-acceptance attempt and retained Lasso selection remain transient; reloading is not a guarantee that an unsent draft survives. The retained Question is the recovery entry, not a second durable Ink task queue.

## 10. Implementation Plan and Commit Sequence

The feature should ship as one PR built from reviewable commits. Tests belong with the behavior they introduce; the sequence below is not a request to defer all tests to the end.

### Commit 1 — `docs: propose ink lasso question flow`

- Add this proposal and link it from [`docs/README.md`](../README.md).
- Record the differences from the earlier HTML concept without requiring the concept file as part of this proposal.
- Record approved scope, protocol, failure behavior, and acceptance criteria before product code changes.

### Commit 2 — `feat(agent): add durable ink intent submissions`

- Add the zod-first `ink-intent` marker to the existing Agent request contract without adding a parallel revision protocol.
- Validate Ink requirements and effective thread ownership/binding at the server boundary; preserve internal `ask` and external ACP bindings on existing targets.
- Carry the normalized kind through `ChatEnvelope`, durable request records, replay, and transcript projection.
- Render the host-owned infer/execute/clarify directive and reuse existing envelope refs, partial-stroke snapshot attachments, canonical `rendered` inputs, and read-set CAS.
- Extend the shared preparation path to enforce required Ink image parts, validate effective built-in model vision support, and preserve those image parts through ACP lowering without changing optional text-Chat attachment behavior.
- Add durable acceptance to the existing typed SSE contract at the actual turn-start persistence boundary, including canonical turn identity.
- Add shared/server tests for legacy text compatibility, Ink rendering, a fully stale stroke subset, replay stability, live material reads, CAS conflicts, and transcript source metadata.

### Commit 3 — `refactor(web): share question turn submission`

- Characterize current text Chat, then extract its component-independent Agent-turn controller while preserving node-less, anchored, and headless conversation behavior.
- Keep `useAgentStream` as the Chat adapter; retain existing source serialization, stream claims, event reduction, history attachment, settings, and lifecycle owners.
- Expose explicit captured sources, a success-reporting barrier over existing save queues, and the shared durable-acceptance callback.
- Replace text-only retry with a common typed-input retry path for both inputs. Keep reconnect distinct from a new submission.
- Add focused tests for first turn, follow-up, anchor exclusion, lifecycle transitions, cross-entry duplicate-send guards, error handling, and stopping a background-started turn from Chat.

### Commit 4 — `feat(canvas): submit lassoed ink as a question`

- Extend `StrokeSelectionToolbar` with source count, the adjacent Agent target hint, blocked states, and submit.
- Capture selected node/stroke IDs and classify zero/one/multiple Question targets through existing conversation ownership rules.
- Resolve Question targets only from the Lasso-selected node IDs, using visible takeover-mark geometry for collapsed Agent Nodes; never route from the active Chat/Preview tab.
- Create and persist a new built-in Question Node below the selection or continue one eligible existing internal/external thread without rebinding it.
- Keep Chat closed, clear selection only after acceptance, and retain the node/selection on failure.
- Keep the created target across local retries, guard creation before thread assignment, and prevent late acceptance from clearing a newer selection.
- Add component/store tests for pure and mixed selections, pointer isolation, accessibility, and all routing guards.

### Commit 5 — `test: cover ink lasso question workflow`

- Add the narrowest practical integration or Playwright coverage for new-task execution, internal/external existing-thread continuation, fully stale Ink rejection, ambiguous clarification visibility, and failure retry.
- Verify desktop and touch toolbar layouts without changing Lasso gesture ownership.
- Keep Voice, general-purpose/passive Sketch OCR, durable transcription, general/heuristic automatic naming, ACP vision-capability claims, and multi-target synthesis explicitly absent; the guarded structured placeholder replacement arrives only in Commit 6, and bounded submission-time OCR arrives only in Commit 7.

### Commit 6 — `feat(agent): ground and present inferred ink intent`

- Add the visible-Canvas grounding contract before declaring the proposal shipped: capture the mixed Ink/object relationship at current zoom/LOD, carry it as hidden canonical Agent input, and keep it absent from ChatPanel/source projections.
- Add a same-turn built-in `report_ink_intent` primitive with `inferred | clarify | unsupported` results; validate and persist it without parsing assistant prose or making another model call.
- Project a valid inferred intent as the primary Ink-row text while retaining Pen provenance and preserving empty user `content`; keep the generic fallback for missing, malformed, ambiguous, unsupported, failed, and external-Agent turns.
- Conditionally rename only the untouched auto-created Question placeholder, set Agent label provenance, and never rename an existing target or a user-renamed node.
- Add request/envelope/renderer tests, browser capture tests across zoom LODs, and integration coverage proving that object-internal pointing survives submission and replay.
- Add live/history parity, retry/reconnect, malformed-report, user-rename race, existing-target protection, external fallback, and conversation-search tests for inferred intent.

### Commit 7 — `feat(agent): enrich ink submissions with bounded OCR`

- Add a server-only Azure Vision adapter configurable through Settings > General, with `VISION_KEY` and `VISION_ENDPOINT` as environment fallbacks. Reuse secure credential storage and secret-entry UI; never return saved keys to the Web client or expose an OCR execution endpoint.
- Derive a white-background pure-Ink OCR raster from the same validated stroke subsets as the required Agent visual. Exclude selected images, ordinary objects, and the visible-Canvas grounding capture so printed reference text cannot become handwritten intent.
- Wait within one hard deadline, attach a validated non-empty structured recognition result to the envelope, and render it as escaped approximate evidence before canonical turn persistence.
- Preserve image-only behavior for disabled, empty, failed, malformed, and timed-out OCR. User Stop or parent preparation cancellation stops the entire submission without starting the Agent; discard all late results without follow-up messages or turn mutation.
- Add structured outcome and latency logging without image bytes, recognized text, credentials, or other sensitive payloads.
- Add server tests for raster purity, success, empty output, timeout, provider error, malformed output, abort/late completion, prompt conflict guidance, replay without another provider call, and unchanged behavior when configuration is absent.

### Commit 8 — `docs: document shipped ink question flow`

- After product behavior is accepted, fold the durable contracts into [`sketch-node.md`](../architecture/sketch-node.md), [`question-node.md`](../architecture/question-node.md), [`agent-context.md`](../architecture/agent-context.md), [`agent-architecture.md`](../architecture/agent-architecture.md), [`preview-workspace.md`](../architecture/preview-workspace.md), and [`canvas-input-interactions.md`](../architecture/canvas-input-interactions.md) as applicable. Document shared acceptance, persistence, retry, and controller lifetime where their owning subsystem is described.
- Set this proposal to `Status: Shipped`, record the PR/commit, update `Last updated`, and leave the proposal at this stable path.

If implementation shows that Commit 2 and Commit 3 cannot be reviewed independently because the request shape and controller must change atomically, combine them rather than leaving an intermediate commit that does not build or pass tests. Do not combine unrelated cleanup into this PR.

## 11. Validation Strategy

### 11.1 Shared and server contract tests

- Legacy text submissions still reject empty text and render exactly as before.
- `ink-intent` accepts empty text only with at least one non-empty partial Sketch selection.
- Whole-Sketch selection without `strokeIds` does not satisfy the V1 intent gate.
- The rendered input contains the host directive, revisioned selected-node metadata, and the materialized partial-stroke image.
- A KEEP-list with no surviving selected strokes never renders the whole Sketch, and the required-input failure propagates through envelope preparation rather than being swallowed.
- Required Ink image snapshot/inlining failures and non-vision effective models reject before execution; optional text-Chat visuals retain their existing fallback behavior.
- Mixed Ink/object requests reject before execution when the visible-Canvas grounding image is missing, invalid, or cannot be inlined; pure Ink retains its existing partial-stroke visual requirement without inventing an object relationship image.
- The grounding renderer preserves the submitted bitmap and metadata byte-for-byte through durable replay and never re-renders hidden text at a different zoom/LOD.
- Configured OCR receives a pure-Ink raster derived from exactly the validated submitted stroke subsets; selected images, ordinary objects, and grounding pixels are absent.
- OCR success renders escaped structured lines and confidence as approximate evidence in the same canonical input, while disabled, empty, provider-error, malformed, and hard-timeout cases render the existing image-only input. User Stop or parent preparation cancellation during OCR prevents Agent execution and durable acceptance for that attempt.
- A slow-call threshold does not resolve the OCR race; only the hard deadline or attempt cancellation does. A late provider result cannot mutate the envelope, persisted inputs, history, inferred intent, Question, or running turn.
- Durable replay and reconnect use the stored canonical inputs and never call the OCR provider again.
- Durable acceptance is emitted only after turn-start persistence, never for preparation/persistence failure; initial `meta` does not trigger acceptance.
- Stop racing with turn-start returns and applies the same durable acceptance exactly once before local stream cancellation.
- An ordinary selected material edited before the Agent's first full read is read at its latest revision.
- A material edited after the Agent reads it produces the existing `stale` CAS conflict on content write; an unread material produces `not-read`.
- Durable replay uses stored rendered inputs and does not snapshot the current Canvas again.
- Multiple Question targets and invalid threads are rejected. Existing internal `ask` targets retain read-only semantics; existing external targets retain ACP semantics; new targets use built-in `operate`.

### 11.2 Web unit and component tests

- Pure Ink shows style controls plus source count and submit.
- Mixed Ink/node selection shows source count and submit on desktop and touch; style controls stay hidden for mixed selection.
- The Agent target hint sits beside the source count: no selected Agent Node shows `New · Huabu`, one valid target shows its effective bound Agent display name, and the hint does not change the source count.
- Internal and external Agent names use the existing binding/Profile display-name projection rather than the Question title. Long names remain layout-stable and expose their full value through tooltip and accessible text.
- No Ink hides or disables Ink submission.
- One eligible Question Node routes to its thread and is excluded from source count/context.
- A collapsed Agent mark enclosed by the Lasso routes to its Question thread even when the hidden card footprint is outside the polygon; an open but unlassoed Chat never becomes the target.
- Multiple Question Nodes and invalid Question targets expose a clear disabled reason. A valid external Question remains enabled.
- A rapid double activation creates at most one Question and starts at most one turn; Chat and Lasso cannot independently dispatch to the same busy thread.
- Acceptance clears only the originating selection; validation rejection or ambiguous transport failure retains it without erasing later user input.
- Toolbar interactions do not move strokes, start Lasso, or trigger Canvas placement.
- The send button has an accessible name, keyboard activation, visible focus, and a stable disabled state.
- Grounding capture at multiple zoom thresholds contains exactly the semantic Canvas content visible at each threshold: zoomed-out captures do not reveal hidden body text, while zoomed-in captures preserve the visible paragraph/list-item layout and Ink landing position.
- ChatPanel, optimistic messages, history hydration, source count, source chips, hover highlighting, and attachment lists never expose the hidden grounding image or count it as a source.
- A valid built-in inferred-intent report replaces the generic Ink-row text without changing its empty user `content`; malformed, missing, clarify, unsupported, error, and external-Agent paths retain the fallback.
- Auto-naming updates only an untouched pending `New ink request` node, writes Agent label provenance, and loses deterministically to a concurrent user rename. Existing Question targets never change title.

### 11.3 Shared Pipeline Regression Tests

Start from existing `agentStreamCoordinator.test.ts`, `chatSessionIsolation.test.tsx`, `questionCompose.test.ts`, and Chat input/history tests; add focused controller tests rather than a parallel Ink test harness.

- Text and Ink use the same request preparation, claim, event reducer, terminal handling, stop, and history attachment paths. Text rejects empty input as before; all existing external Chat event handling survives extraction.
- An Ink send does not consume drafts, uploads, the selected-text excerpt, or Skills from any Chat composer. Its source metadata remains consistent after asynchronous validation even if active selection changes.
- Target-thread settings and persisted owner binding/mode win over an unrelated active tab. Node-less Chat and World/headless scope behavior remain unchanged.
- The save barrier waits for structure and sidecar writes, blocks on failure/conflict, and is not satisfied by action-log flushing. Navigation drain behavior remains unchanged.
- Create-only Question initialization neither opens Preview nor writes a placeholder into user content; later text follow-ups do not reinitialize the thread or trigger Ink title inference.
- Retry preserves typed input, sources, attachments, and explicit skills for both text and Ink, including after history hydration. Reconnect does not POST another turn.
- A stream started while Chat is closed updates common thread state; opening Chat does not double-attach, and Stop cancels that same server turn. Closing the tab does not stop it.
- Shared unread/terminal/change-review behavior survives, including the existing guard against a late error overriding an already-observed successful completion.

### 11.4 Integration checks

- New-task path creates one Question Node below the selection, keeps Chat closed, enters `running`, and later exposes the conversation from the Agent mark.
- Existing-task path appends one turn to the selected internal or external Question thread without creating a node or changing its binding.
- A failed first submission retries against the already-created Question rather than creating another one; uncertain acceptance reconciles before resubmission.
- A clear Ink request can execute existing Canvas tools under normal approval policy.
- In a mixed Ink/object example, an arrow or underline aimed at a visible internal object element is delivered as one relationship image with the same current LOD, allowing the Agent to distinguish element-level elaboration from whole-node resize/rewrite intent.
- The same example displays a concise structured interpretation such as `Expand the third comparison step in the left note` in its Ink history row and, for a newly created untouched Question only, as the Question label.
- With Azure Vision configured, a Chinese or mixed-language handwritten request can include a bounded approximate OCR block in the same Agent turn; provider unavailability or deadline expiry still starts the image-only turn without a second message.
- A mixed Ink/image request sends only the selected strokes to OCR, so printed text in the reference image or visible-Canvas grounding cannot be introduced as recognized handwriting.
- An ambiguous Ink request produces a focused clarification and no guessed Canvas mutation.
- Restart/reload preserves the Ink request row, source chips, selected stroke IDs, thread ownership, and terminal status.
- Undo/redo or authoritative Canvas replacement clears stale transient selection through the existing preview reset contract.

Before PR handoff, run the repository-required `pnpm typecheck`, `pnpm format`, and `pnpm lint:fix`, review formatter/linter changes, and rerun affected focused tests.

## 12. Acceptance Criteria

V1 is complete when all of the following are true:

1. A user can Lasso one or more Sketch strokes, optionally include ordinary Canvas nodes, and explicitly submit from the existing floating toolbar.
2. A submission with no Question target creates exactly one persisted built-in Question Node near the selection and starts one `operate` turn without opening Chat.
3. A submission with one eligible Question target continues exactly that thread and creates no new node.
4. Multiple or invalid Question targets cannot be submitted and explain why; one valid external Question target keeps its selected Agent.
5. The Agent receives the materialized partial-stroke visual and the existing revisioned refs for other selected sources, infers a clear intent and executes it, or asks for clarification without guessing.
6. The request, rendered input, selected stroke IDs, source metadata, and Question lifecycle survive reload and replay.
7. Visual replay remains point-in-time, ordinary material reads remain fresh, fully stale Ink is never widened to a whole Sketch, and Agent content writes retain existing read-before-write/CAS protection.
8. Existing text Chat, Lasso editing, stroke movement, deletion, undo, pointer routing, and Question interactions do not regress.
9. Voice, general-purpose/passive Sketch OCR, durable or editable Sketch transcription, OCR-backed search, intent confirmation, ACP capability negotiation, general/heuristic automatic naming, and multi-target synthesis are absent from the shipped UI and protocol behavior; the only naming exception is Commit 6's structured replacement of an untouched Ink placeholder.
10. Chat and Ink share one dispatch/retry/stream/recovery implementation, with thread-scoped settings and no dependency on an open Chat. Optimizing the common pipeline does not require a second Ink change.
11. A rejected submission cannot execute without its required Ink visual; a delayed acknowledgement cannot clear a newer selection; retry of a failed new task reuses its existing Question.
12. The toolbar gives immediate target feedback beside the source count: `New · Huabu` when no Agent Node is included, the effective Agent name when exactly one valid Agent Node is included, and a blocked indication for multiple or invalid targets.
13. Every mixed Ink/object submission gives the Agent a hidden visible-Canvas grounding image that preserves submission-time zoom/LOD and Ink/object placement, survives replay, and remains absent from ChatPanel and all user-visible source/attachment projections.
14. A valid same-turn built-in inferred intent replaces generic Ink placeholders without changing user-authored content; it survives replay, never renames existing or user-renamed Questions, and safely falls back when no trustworthy structured report exists.
15. When Azure Vision is configured, submission-time OCR waits only within its hard deadline and contributes escaped approximate evidence to the same durable turn; absent configuration, empty recognition, failure, malformed output, and timeout preserve deterministic image-only behavior. User Stop or parent preparation cancellation during OCR stops the entire submission before Agent execution. Late completion never produces a follow-up message or changes the settled attempt.
16. OCR uses a pure-Ink raster derived from the validated submitted stroke subsets, never a mixed image composite or Canvas grounding capture, and its result remains hidden from user-authored text, Chat attachments/sources, Question naming, Sketch persistence, and search.

## 13. Deferred Follow-Ups

Each follow-up requires its own proposal or an explicit lifecycle update to this one:

- Voice as an additional intent source, including recording, transcription, and privacy/error states.
- General-purpose Sketch OCR for search, passive question detection, durable transcription, and editable recognized text remains owned by [`sketch-region-redesign.md`](./sketch-region-redesign.md); §15 does not implement or replace it.
- A two-stage `infer -> confirm/execute` flow with a structured `ready | clarify | unsupported` result.
- Full inferred-intent parity for external ACP Agents, gated on an authoritative structured capability rather than session-title or reply-text heuristics.
- ACP vision capability declaration and capability-gated Ink affordances.
- Image-faithful fallback replay when an external Agent cannot resume its native ACP session.
- Multiple Question Nodes as a new synthesized task with explicit thread-reference semantics.
- Handwritten sigils for capability, resource, Agent, or Skill selection.

## 14. Post-V1 Interaction Polish

This amendment is planned after the V1 submission path and contains only local interaction changes. It does not own the optional submission-time OCR preparation defined separately in §15.

### 14.1 Sequence and ownership

| Phase | Scope                                                                                      | Dependency                                       | Review boundary                                       |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| P0    | Characterize retained-selection dismissal, submission pending state, and touch hit-testing | Existing Ink submission and pointer-router tests | Tests only; no product behavior change                |
| P1    | Empty-Canvas tap dismisses the complete retained Lasso result                              | P0                                               | Canvas interaction change                             |
| P2    | Stable spinner feedback during pre-acceptance submission                                   | P0                                               | Toolbar presentation change                           |
| P3    | Finger input does not select or drag Ink                                                   | P0                                               | Pointer-policy change; mouse and pen remain unchanged |
| P4    | Retained Lasso loop renders in the topmost Canvas HUD                                      | P1                                               | Canvas presentation and hit-target change             |
| P5    | Selected Ink strokes render an explicit semantic highlight                                 | P0                                               | Sketch paint-only change                              |
| P6    | Ink toolbar anchors to the retained Lasso range                                            | P1                                               | Floating-toolbar placement change                     |
| P7    | Frame-nested Ink and grounding metadata share one captured source tree                     | Existing source serializer and request schema    | Submission consistency fix                            |

P1-P7 belong on `fix/ink-query-polish` and are independently reviewable after P0 characterizes the current behavior.

### 14.2 Empty-Canvas dismissal

After a Lasso gesture commits a retained result, a completed primary-pointer tap on genuinely empty Canvas or on empty space inside the retained Lasso region clears that complete result: `sketchStrokeSelection`, `sketchSelectionPolygon`, stroke-move preview state, and whole-node selection produced by the same Lasso. A retained-region press that crosses the pointer-specific move threshold remains a move rather than a dismissal. This is a transient UI dismissal and creates no Canvas command, persistence write, or undo entry.

Canvas interaction also clears `sketchStrokeHighlight`, the separate transient channel used when a Chat history source chip points back to submitted Ink. Mouse leave remains the normal desktop cleanup, but empty Canvas taps, node taps, and new Lasso interaction are authoritative fallbacks for touch browsers whose synthetic hover may not emit a matching leave. This reference highlight is presentation-only and is never protected by the Ink submission reservation.

The dismissal occurs only after the shared pointer policy classifies the gesture as a tap below the pointer-specific activation distance. A pan, pinch, new locked Lasso, node/edge/handle interaction, floating-toolbar interaction, or application-panel interaction does not trigger it. While an Ink submission is preparing and has no cancellation contract, empty-Canvas taps do not discard the captured operands; known rejection restores normal dismissal, while durable acceptance retires the matching selection through the existing acceptance callback.

P1 should reuse the current pane/viewport-navigation selection-clear boundary and `gesturePreviewStore.clearSketchStrokeSelection()` rather than add a document-level click listener. Mouse, pen, and touch receive the same empty-Canvas dismissal once their gesture has resolved to an eligible tap.

### 14.3 Pre-acceptance submission feedback

The send control keeps its position and dimensions after activation, becomes disabled, and replaces the Send icon with the shared `Spinner` primitive at the icon-only button's `xs` indicator size. `Spinner` owns a fixed square layout box and rotates a centred Lucide indicator through the common loading animation, so business components do not hand-roll animation classes, the indicator shares the circular button's visual centre, and its intrinsic size cannot enlarge the button or toolbar. Its accessible name changes to `Sending ink request`, but the pending state exposes no tooltip or visible status text because the Spinner is sufficient feedback; source count and Agent target hint remain stable so the toolbar does not resize. Repeated activation is ignored by the same local preparation guard.

The spinner begins synchronously when activation reserves the local attempt and ends at one of three boundaries: durable acceptance always releases the local preparation state, then clears the matching selection and removes its toolbar; a known pre-acceptance rejection restores the Send icon for retry; an unresolved transport outcome retains its acceptance observer and remains non-actionable for the same Canvas/thread, preventing a duplicate POST. The controller retains that observer after an unknown result; a later acceptance replayed by Chat stream reconnect or returned by Stop reconciles it, while a confirmed Stop with no acceptance rejects the observer and restores retry without clearing the Lasso or Question. Switching tools does not clear a reserved Lasso; after a definitive rejection, the normal tool-scoped cleanup may run. If the user creates a newer Lasso, its polygon/stroke identity supersedes the old local presentation immediately, so the newer toolbar returns to its normal Send state and an older acceptance/finally callback cannot clear or disable it. The older observer is not discarded: until reconciliation resolves it, the shared turn controller rejects another dispatch to the same Canvas/thread instead of replacing the observer, while submissions targeting another thread remain independent. The toolbar does not show Chat's square Stop control because capture, save, snapshot, and pre-turn preparation do not yet identify a durable Agent run that Stop can authoritatively cancel. Once accepted, the Lasso surface is finished: the Question Node owns `running` feedback, and ChatPanel owns the shared Stop action for that accepted turn.

### 14.4 Finger input does not select Ink

The policy is based on `pointerType === 'touch'`, not an iPad user-agent check. A finger touching a painted Sketch stroke must not select that Sketch node, make it eligible for whole-node drag, or move an already selected Sketch. Mouse behavior is unchanged, and pen/Apple Pencil behavior is unchanged. Lasso stroke selection remains the touch-first way to select and edit Ink deliberately.

Touch hit-testing treats Sketch as transparent for direct selection and continues to the topmost eligible non-Sketch node underneath; if there is none, the gesture behaves as an empty-Canvas tap or navigation gesture. Note, PDF, Question, Image, and other ordinary nodes therefore remain touch-selectable even when Ink crosses them. Lasso and Sketch tools retain their existing pointer ownership: this rule applies to direct node selection/drag resolution, not to drawing, erasing, or Lasso capture.

P3 must update both selection and selected-node drag gates. Filtering only the final tap would still let an already selected Sketch capture a finger drag, while disabling pointer events on all Sketch DOM would regress mouse selection and stroke-level hover behavior.

### 14.5 Retained Lasso visibility

The committed Lasso polygon is interaction chrome and must remain visible above every Canvas node regardless of Layer order, nesting, or node type. It renders as a screen-space HUD portalled into the React Flow root above the viewport renderer, not as a `ViewportPortal` child whose z-index competes with Frame, Image, or other node stacking contexts. Viewport pan/zoom and the live stroke-move delta are applied when deriving its screen-space bounds; its polygon interior keeps pointer ownership for retained-selection movement.

The Lasso HUD uses the Canvas `z-999` interaction layer: it sits above selection outlines, nodes, edges, and node media, and its later mount order keeps it above same-layer multi-selection resize chrome. It is visual-only and does not become the DOM hit target; the pointer router resolves ordinary retained-region moves geometrically and yields when the real target is a native connection or resize control. It remains strictly below body-level `z-index: 1000` Canvas floating toolbars and below dialogs, tooltips, and toasts. Grounding capture continues to exclude it through `data-canvas-grounding-exclude`.

### 14.6 Selected Ink highlight

Every stroke named by `sketchStrokeSelection` renders with an explicit `--color-info` SVG outline beneath its original Ink path. The 2px centred outline leaves approximately a 1px visible edge after the original Ink covers its inner half, with the same subtle 2px `--color-info-light` glow used by selected edges. It uses `vector-effect="non-scaling-stroke"` so the restrained highlight remains stable at every Canvas zoom while preserving the authored stroke color and geometry. The core outline must not rely solely on CSS `filter` or `drop-shadow`, whose SVG behavior is inconsistent on iPad Safari. Chat-reference hover uses the same painter at lower opacity.

The highlight outline is interaction chrome, not Canvas content: it has no pointer events and carries `data-canvas-grounding-exclude`, so visible-relationship capture and Agent input retain only the original Ink. Selection changes update only the affected stroke painters; unselected strokes render no extra path.

### 14.7 Ink toolbar placement

The stroke-selection toolbar anchors above the retained Lasso polygon's bounding box, horizontally centred on the gesture range. It follows the polygon's live move delta and continues to use the shared `CanvasFloatingPopover` flip/shift behavior near viewport edges. A selected Frame, Image, or other large source never expands this presentation anchor or moves the toolbar away from the gesture the user just completed.

The Lasso polygon controls presentation only. Mixed-selection grounding, source capture, new Question placement, and Agent context continue to use the actual selected stroke and whole-node source bounds. If a legacy/transient state has selected strokes but no retained polygon, the toolbar falls back to the selected-stroke bounds rather than disappearing.

### 14.8 Grounding source parity

The final captured `AgentChatContext.selectedNodes` tree is the canonical operand set for both request submission and grounding metadata. When a selected Frame recursively contains a partial Sketch selection, that Sketch appears once inside `Frame.children` and is not appended again as a top-level source. The grounding `selectedNodeIds` and `strokeSubsets` are derived from this frozen tree using the same top-level ordinary-node and recursive partial-Ink semantics enforced by the shared request schema.

The client captures this tree before asynchronous screenshotting or Question creation and reuses it for dispatch. A selected Question anchor remains excluded even when nested in a selected Frame. This prevents Frame expansion, duplicate nested Ink, or later selection changes from producing `Visible Canvas grounding does not match the selection` while preserving strict server rejection of genuinely inconsistent metadata.

### 14.9 Validation and acceptance

The polish work is complete when all of the following hold:

- Mouse, pen, and touch empty-Canvas taps clear the retained Lasso polygon and its complete mixed selection, while drags, pinch, controls, nodes, and panels do not.
- Empty-Canvas dismissal cannot invalidate an attempt during pre-acceptance preparation, and acceptance still clears only the captured matching selection.
- Send changes to a stable disabled spinner immediately, cannot dispatch twice, restores retry feedback on known rejection, and never claims Stop semantics before durable acceptance.
- Finger taps and drags never select or move Sketch nodes, can still reach ordinary nodes under Ink, and otherwise navigate or clear as empty Canvas; mouse, pen, drawing, erasing, and Lasso behavior do not regress.
- The retained Lasso loop is portalled above the viewport renderer, remains aligned through pan/zoom and stroke movement, and cannot be obscured by Frames, Images, or manually reordered nodes.
- Every selected Ink stroke visibly retains its authored color with a screen-stable semantic outline; unselected strokes have no outline, and grounding capture excludes the highlight path.
- The Ink toolbar remains centred above the retained Lasso range even when the Lasso also selects a much larger Frame or Image; source and grounding bounds remain unchanged.
- Frame-nested partial Ink appears once in the final source tree, grounding metadata is derived from that tree, nested Question anchors remain excluded, and the resulting request passes the shared schema without weakening mismatch validation.
- Unit coverage exercises pointer type rather than device detection, and touch-emulated Playwright coverage verifies the iPad-shaped workflows.

### 14.10 Suggested commits

1. `fix(canvas): polish lasso interactions`
2. `fix(canvas): polish ink query submission`

The first commit owns empty-Canvas dismissal, finger-on-Ink routing, retained-Lasso stacking, selected-stroke paint, and their focused tests and architecture updates. The second owns submission preparation feedback and guards, Lasso-relative toolbar placement, Ink Query integration coverage, and this proposal update. Files that contain both concerns must be staged by hunk so each commit builds and its focused tests pass independently. Tailnet proxy, local development-server configuration, and environment-only changes remain uncommitted local workspace state.

## 15. Submission-Time Ink OCR Enrichment

This amendment adds optional server-side recognition only to an explicit `ink-intent` submission. It is reading assistance for the executing Agent, not a general Sketch transcription feature. The required partial-stroke image remains the authoritative visual representation of the request, and the existing image-only behavior remains fully supported when Azure Vision is not configured or recognition produces no usable result.

### 15.1 Preparation sequence and ownership

The Web client continues to send only the captured source tree, stroke IDs, input kind, and any required grounding visual. It never calls Azure or authors OCR text. After validating and materializing the required selected Ink, the server derives the OCR raster, performs bounded recognition, attaches any successful result to `ChatEnvelope.focus.selection`, and only then renders and persists the canonical `AgentInput[]`.

```text
frozen source tree -> required Ink visual -> pure-Ink OCR raster -> bounded OCR
                                                                  |
                                      complete ChatEnvelope -> canonical inputs
                                                                  |
                                                turn persistence -> acceptance
```

OCR and its source raster are downstream of the validated stroke snapshot and therefore do not run independently of it. Client save/Question preparation may overlap with server request preparation through the existing flow, but this amendment does not add a two-phase upload or a second submission protocol merely to hide the OCR latency.

### 15.2 Pure-Ink raster

The OCR raster is derived from the same validated `strokeSubsets` used by the required Ink visual, preserving stroke layout and reading order while excluding every selected image, ordinary object, Question, and visible-Canvas grounding pixel. It uses a white background, high-contrast dark strokes, bounded padding, and an OCR-appropriate scale without changing the semantic geometry. The implementation reuses the canonical stroke filtering and path rendering primitives rather than creating another selection interpreter.

A pure Ink Agent snapshot may be byte-reused only when it already satisfies this profile. A mixed Sketch/Image composite must never be sent to OCR because printed reference text could be misclassified as the user's handwritten request. The OCR raster is transient provider input, not a user attachment, source, Canvas artifact, or separately replayable record.

### 15.3 Deadline, fallback, and cancellation

Recognition has one initial hard deadline of 2,000 ms. A 1,500 ms slow-call threshold exists only for measurement and does not settle the attempt. Missing configuration disables OCR without error; an empty valid result also continues normally. Timeout, provider error, or malformed output is reported through structured diagnostics and falls back to the required image-only turn. User Stop or parent preparation cancellation is different: it aborts OCR and stops the entire submission before Agent execution and durable acceptance, rather than continuing image-only.

Where the request pipeline exposes a reliable preparation `AbortSignal`, the Azure request consumes it together with its own deadline. Correctness does not depend on physical network cancellation: attempt identity and deadline settlement make every later completion ineligible. Huabu never posts the result as a second user message, opens another Agent turn, updates an already running turn, or rewrites persisted history.

### 15.4 Envelope, prompt, and replay

The validated recognition keeps provider/API provenance, ordered lines, optional confidence, and contributing Ink node IDs as structured server-derived envelope data. The renderer bounds and escapes the content and places it in an `<ink_ocr>` block after the Ink-intent directive. The block states that the text is approximate machine transcription, must be verified against the accompanying Ink image, and is not authoritative when the two conflict.

OCR never enters `ChatEnvelope.user.text`, `QuestionNodeData.content`, `responseSummary`, `ChatHistoryItem.inferredIntent`, source metadata, attachment projection, or automatic Question naming. A material image/OCR conflict remains ambiguity and should produce `report_ink_intent(status='clarify')`; a plausible OCR line does not bypass the required structured report.

Canonical rendering happens only after OCR has succeeded, produced no text, failed, or reached its deadline. Any included OCR evidence is therefore persisted inside the same `AgentSubmission.rendered` input as the image and replays byte-for-byte. Replay, reconnect, and history hydration never call Azure again. An explicit retry is a new submission attempt and may perform OCR again through the same bounded path.

### 15.5 Privacy and observability

Configuring an Azure AI Vision endpoint and key in Settings > General or through `VISION_ENDPOINT` / `VISION_KEY` opts the server into sending the selected pure-Ink raster to that resource. Newly entered keys travel only to the owner-authorized settings endpoint for secure persistence; saved keys are never returned by read APIs or included in Agent requests, envelopes, logs, or Web bundles. Product documentation and deployment guidance disclose this external processing boundary.

Structured telemetry distinguishes `disabled`, `success`, `empty`, `timeout`, `remote_error`, `invalid_result`, and `aborted`, and records only operational metadata such as duration, HTTP status where applicable, raster dimensions, and node/stroke counts. Normal logs must not include credentials, image bytes, data URLs, or recognized text. The implementation should measure p50, p95, timeout rate, non-empty recognition rate, and downstream intent success before changing the initial deadline.

### 15.6 Validation and rollout

The initial rollout is configuration-gated: environments without both effective Vision values retain the current image-only behavior and no provider wait. Local evaluation should cover Chinese, mixed Chinese/English, digits and punctuation, multiple lines, arrows plus text, low-confidence handwriting, and mixed Ink/object selections. The product metric is correct intent interpretation and reduced unsafe guessing, not OCR character accuracy alone.

Focused tests cover exact stroke-subset rastering, background exclusion, XML escaping, response bounds, confidence preservation, every fallback outcome, deadline/abort races, image/OCR conflict guidance, canonical persistence, replay without provider access, and absence from all user-visible transcript and source projections. The existing required-visual tests remain authoritative: OCR success can never rescue a missing or invalid Ink image.

### 15.7 Settings configuration

General settings includes a compact optional handwriting-recognition row, reusing the common Settings primitives and matching the other capabilities' key icon and Set API Key / Update Key action. By default it shows the Azure AI Vision title and a brief selected-stroke processing description. One click opens Endpoint and API Key inputs with Save and Cancel; normal editing shows no configuration-source paragraphs or long instructions. Save sends only changed fields, and a blank key preserves the current credential; stored-key removal is an explicit separate action. The title identifies Azure AI Vision rather than claiming generic OCR compatibility. Both values must belong to the same Azure resource; arbitrary OCR providers are not supported merely by changing the URL. No model selector, provider selector, connectivity probe, or additional enable switch is introduced.

The owner-only settings API uses shared schemas, validates HTTPS endpoints without embedded credentials, query, or fragment, and returns no saved plaintext keys. SecretStore persists the key securely; a separate non-secret settings file holds the endpoint. UI-saved values independently override environment values and affect the next submission without a restart. The API read model distinguishes stored values from environment fallbacks and describes configuration completeness rather than verified connectivity. Removing an override restores its environment fallback, so deleting a saved key is not an off switch. The compact row discloses selected-stroke external processing, while settings errors remain explicit and key mutations are disabled when secure storage is unavailable. Image-only fallback remains unchanged. See [credential storage](../architecture/credential-storage.md) for runtime-specific persistence and partial-update behavior.

## 16. Code Entry Points

| Concern                                   | File                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stroke selection state                    | [`apps/web/src/store/gesturePreviewStore.ts`](../../apps/web/src/store/gesturePreviewStore.ts)                                                                                 |
| Retained Lasso HUD                        | [`apps/web/src/components/Panels/Canvas/StrokeSelectionRegion.tsx`](../../apps/web/src/components/Panels/Canvas/StrokeSelectionRegion.tsx)                                     |
| Selected Ink painter                      | [`apps/web/src/components/Nodes/sketch/SketchStrokePath.tsx`](../../apps/web/src/components/Nodes/sketch/SketchStrokePath.tsx)                                                 |
| Stroke selection toolbar                  | [`apps/web/src/components/Panels/Canvas/FloatingToolbars/StrokeSelectionToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/StrokeSelectionToolbar.tsx) |
| Lasso and pointer routing                 | [`apps/web/src/components/Panels/Canvas/Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx)                                                                   |
| Partial-stroke hit testing                | [`apps/web/src/components/Nodes/sketch/sketchHitTest.ts`](../../apps/web/src/components/Nodes/sketch/sketchHitTest.ts)                                                         |
| Question creation/entry                   | [`apps/web/src/components/Nodes/question/questionCompose.ts`](../../apps/web/src/components/Nodes/question/questionCompose.ts)                                                 |
| Current turn orchestration                | [`apps/web/src/hooks/useAgentStream.ts`](../../apps/web/src/hooks/useAgentStream.ts)                                                                                           |
| Chat submit and retry adapter             | [`apps/web/src/components/Panels/ChatPanel/index.tsx`](../../apps/web/src/components/Panels/ChatPanel/index.tsx)                                                               |
| Ink-row inferred-intent presentation      | [`apps/web/src/components/Messages/UserMessage.tsx`](../../apps/web/src/components/Messages/UserMessage.tsx)                                                                   |
| Stream ownership and deduplication        | [`apps/web/src/hooks/agentStreamCoordinator.ts`](../../apps/web/src/hooks/agentStreamCoordinator.ts)                                                                           |
| Conversation owner and lifecycle routing  | [`apps/web/src/store/conversationOwner.ts`](../../apps/web/src/store/conversationOwner.ts)                                                                                     |
| Shared source serializer and save queues  | [`apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                                                                                 |
| Visible Canvas grounding capture          | [`apps/web/src/handler/canvasCommand/utils/screenshot.ts`](../../apps/web/src/handler/canvasCommand/utils/screenshot.ts)                                                       |
| Thread history and live attachment        | [`apps/web/src/hooks/useChatHistory.ts`](../../apps/web/src/hooks/useChatHistory.ts)                                                                                           |
| Thread-scoped UI state and settings       | [`apps/web/src/store/chatStore.ts`](../../apps/web/src/store/chatStore.ts)                                                                                                     |
| Agent transport and SSE decoding          | [`apps/web/src/api/agent.ts`](../../apps/web/src/api/agent.ts)                                                                                                                 |
| Shared Agent request schema               | [`packages/shared/src/types/api/agent.ts`](../../packages/shared/src/types/api/agent.ts)                                                                                       |
| Shared envelope and OCR schema            | [`packages/shared/src/types/api/chat-envelope.ts`](../../packages/shared/src/types/api/chat-envelope.ts)                                                                       |
| Envelope and auto-snapshot                | [`apps/server/src/modules/agent/conversation/envelope.ts`](../../apps/server/src/modules/agent/conversation/envelope.ts)                                                       |
| Azure Vision OCR adapter                  | [`apps/server/src/modules/agent/conversation/ink-ocr.ts`](../../apps/server/src/modules/agent/conversation/ink-ocr.ts)                                                         |
| Canonical turn renderer                   | [`apps/server/src/modules/agent/conversation/prompt/build-prompt.ts`](../../apps/server/src/modules/agent/conversation/prompt/build-prompt.ts)                                 |
| Ink intent directive                      | [`apps/server/src/modules/agent/conversation/prompt/ink-intent.ts`](../../apps/server/src/modules/agent/conversation/prompt/ink-intent.ts)                                     |
| Ink OCR evidence renderer                 | [`apps/server/src/modules/agent/conversation/prompt/ink-ocr.ts`](../../apps/server/src/modules/agent/conversation/prompt/ink-ocr.ts)                                           |
| Inferred-intent tool contract             | [`apps/server/src/modules/agent/tools/definitions.ts`](../../apps/server/src/modules/agent/tools/definitions.ts)                                                               |
| Agent route                               | [`apps/server/src/modules/agent/agent.route.ts`](../../apps/server/src/modules/agent/agent.route.ts)                                                                           |
| Shared server lease and dispatch          | [`apps/server/src/modules/agent/agent-thread.service.ts`](../../apps/server/src/modules/agent/agent-thread.service.ts)                                                         |
| Canonical rendering and turn-start signal | [`apps/server/src/modules/agent/agent.service.ts`](../../apps/server/src/modules/agent/agent.service.ts)                                                                       |
| History source/input projection           | [`apps/server/src/modules/agent/conversation/transcript/history.ts`](../../apps/server/src/modules/agent/conversation/transcript/history.ts)                                   |
| Image inlining and fallback policy        | [`apps/server/src/modules/agent/conversation/prompt/image-inlining.ts`](../../apps/server/src/modules/agent/conversation/prompt/image-inlining.ts)                             |
| Partial snapshot implementation           | [`apps/server/src/modules/canvas/snapshot-nodes.ts`](../../apps/server/src/modules/canvas/snapshot-nodes.ts)                                                                   |
| Azure Vision local probe                  | [`scripts/test-azure-vision.mjs`](../../scripts/test-azure-vision.mjs)                                                                                                         |
