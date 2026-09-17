# Node Preprocessing

> How canvas nodes are preprocessed: a single 6-stage server pipeline that
> normalises content, optionally enriches it with one LLM stage, and persists
> knowledge sources. Participating node types run the same pipeline; a per-type profile
> decides which stages execute.

> Last updated: 2026-09-17

---

## 1. Two concepts kept separate

- **`CanvasNodeType`** ([shared](../../packages/shared/src/types/canvas/node.ts)) — the 11 node kinds (`note` / `text` / `web` / `pdf` / `office` / `image` / `video` / `audio` / `frame` / `sketch` / `question`).
- **`Capability`** — what a node participates in; each node's profile lists its capabilities and the dispatcher runs capabilities, not routes.

A node is processed by asking "which capabilities are dirty for this change", not "is this an ingest or a label request".

---

## 2. Pipeline (6 stages)

The dispatcher skips stages whose capabilities aren't in the node's profile. **For ordinary node preprocessing, all LLM / paid-provider work lives only in Enrich.** Questions retain the same preprocessing entry but delegate naming to `ConversationTitleService.initializeQuestion()` before the stage runner; they do not run a parallel Enrich naming path or return an automatic label patch.

| Stage           | Purpose                                                                                                                                             | LLM?    | Persist?           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------ |
| 1 Input Resolve | normalise raw node data into canonical input (resolve URL, artifact path, child labels)                                                             | no      | no                 |
| 2 Extract       | parse / fetch content — text / pdf (`pdf2md`) / web (Tavily) / office / youtube loaders                                                             | no      | no                 |
| 3 Normalize     | canonical content, title, metadata merge (web/pdf cache short-circuit on unchanged `src`)                                                           | no      | no                 |
| 4 Enrich        | `generate_label` / `generate_summary` / `generate_keywords` via `ProviderManager`                                                                   | **yes** | no                 |
| 5 Persist       | update an existing node `.md` via the storage `updateNode` coordinator (serialized + rev-CAS), content-equality dedup, placeholder for empty/failed | no      | yes (policy-gated) |
| 6 Project       | assemble authoritative `patch` + diagnostics for the client                                                                                         | no      | no                 |

Web / pdf skip Stages 2–5 when `src` is unchanged and content is cached on disk ([cache-check.ts](../../apps/server/src/modules/preprocessing/stages/cache-check.ts)); `force=true` overrides. `allowLLM=false` / interactive mode → Enrich skipped, result still valid.

Fresh remote PDFs are localized during preprocessing. Extract downloads the PDF once and returns both parsed text and the original bytes; before Normalize, the pipeline writes those bytes to the Space BlobStore as `artifact-<id>.pdf` and replaces the resolved source with that artifact key, so Persist and Project move the node from the remote URL to the canvas-local source used by thumbnails, expanded preview, and download. Existing remote-URL PDF nodes bypass the text cache once to perform the same migration; after `src` becomes an artifact key they resume normal cache short-circuiting. Blob snapshot failure is a warning rather than an extraction failure, leaving the remote URL usable online.

Before preprocessing, an agent-authored `web.src` is normalized at the server executor boundary: any canvas-local `.html` file is imported into `.artifacts/` and persisted as a bare artifact key (uploads staged under `.upload/` are reclaimed), while live `http(s)://` and self-contained `data:` URLs remain unchanged; other local extensions are not imported or reclaimed. Input Resolve then maps the artifact key to an absolute local path for extraction, while remote and `data:` sources continue through the URL path.

Enrich runs on the **utility model tier**, not the chat model: `ProviderManager` calls `llmComplete(ctx, { role })` with the `imageLabel` / `frameLabel` / `contentMeta` roles, so labeling / summaries / keywords resolve through the user's utility model (a faster/cheaper model, or — when no utility model is configured — the cheapest eligible model in the chat provider, ultimately falling back to the chat model). See [model-role-routing](../proposals/model-role-routing.md).

---

## 3. Node profiles

Each `CanvasNodeType` declares `{ contentKind?, capabilities, watchFields }`. Selected profiles:

| Node           | Extract      | Enrich                                      | Persist | watchFields                 |
| -------------- | ------------ | ------------------------------------------- | ------- | --------------------------- |
| note / text    | text         | —                                           | ✅      | content, title, labelSource |
| web            | remote fetch | label + summary + keywords                  | ✅      | src, title, labelSource     |
| pdf / office   | text         | label + summary + keywords                  | ✅      | src, title, labelSource     |
| image          | —            | `generate_label` (vision)                   | ✅      | src, labelSource            |
| video          | —            | —                                           | ✅      | src                         |
| frame          | —            | `generate_label` (summarise children)       | —       | childLabels, labelSource    |
| **question**   | —            | shared conversation naming (outside stages) | —       | content                     |
| sketch / audio | —            | —                                           | —       | —                           |

`question` declares only `resolve_input` + `build_patch`, watches `content`, and has no `persist_source` (not a knowledge source). Its pipeline entry calls `initializeQuestion(canvasId, nodeId, content, allowLLM)` and returns an empty patch and capability list: the shared service persists any accepted name through the canonical node writer and Canvas Sync, not through the preprocessing response. `allowPersistence=false` skips naming entirely; `allowLLM=false` or interactive mode permits fallback preparation without generation. Initialization checks the live Question content against the request before proceeding. `sketch` / `audio` only do `resolve_input` + `build_patch`. The `contentKind?` field (`web` / `pdf` / `office` / `note` / `text` / `image` / `video`) is just the Persist gate — set it and Stage 5 writes the node as a knowledge source; question has none. Registry: [profiles.ts](../../apps/server/src/modules/preprocessing/profiles.ts).

Each profile also declares **`bodyOwnership`** (`types.ts`): `'authored'` for user-editable bodies (`note` / `text`) → the Persist write is rev-CAS-guarded so a concurrent edit can't clobber the user's body; `'derived'` for pipeline-extracted, in-app read-only bodies (`web` / `pdf` / `office`) → no CAS (last-extraction-wins). The Persist stage reads this flag rather than hardcoding node types.

---

## 4. Triggers & state

- Frontend callers request work through [preprocessQueue.ts](../../apps/web/src/store/canvasStore/save/preprocessQueue.ts); `preprocessNodeIfNeeded` ([preprocess.ts](../../apps/web/src/handler/canvasCommand/preprocess.ts)) is its execution helper. The queue is the client task-lifecycle owner; see the responsibility contract below.
- The web queue excludes `sketch` (no preprocessable payload) and `spacePreview` (view-only) before scheduling or marking ingestion pending. The same guard checks the latest node before delayed and unload keepalive requests; edit-settle calls also use this queue. Neither excluded type sends a preprocessing request or acquires ingestion state from scheduling. The server request schema remains unchanged.
- Scheduling immediately marks the node ingestion state as `pending`, including debounce and restored-content persistence waits. A restore barrier postpones execution rather than discarding the request. Preview components use that state to avoid requesting server-persisted content before preprocessing has written the node sidecar.
- **`note` / `text` are settle-triggered, not mutation-triggered.** Their label auto-derives from the first heading/line, so firing preprocess on every typing pause churned the `.md` filename. Instead [postEffects.web.ts](../../apps/web/src/handler/canvasCommand/postEffects.web.ts) skips them on mutation, and `settleNodePreprocess` ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)) fires once at the edit-done boundary — `closeExpanded` / `openExpanded` for a `note`, `TextNode`'s blur for inline `text`. The body still saves on the fast `nodeContentQueue` cadence independently; other node types keep the per-mutation debounce.
- `contentMissing` is a write barrier, not only a rendering hint. GET hydration marks every Markdown-backed node type, including Frame and Sketch, when its `.md` is absent. Load-time empty-label backfill skips it; `preprocessQueue` rejects it both when scheduled and when a delayed/keepalive request fires; and `nodeContentQueue` refuses to build a content PUT for it. The preprocess route also rejects an absent sidecar before dispatch, while the Persist stage atomically requires an existing record so an already-running extraction cannot recreate the file after external deletion. Extraction-failure placeholders may update an existing sidecar but never create one. Opening, closing, switching an expanded editor, renaming, or preprocessing therefore cannot silently recreate a frontmatter-only `nodes/<nodeId>.md`. Every missing content/artifact node uses the shared `MissingFileBanner`; the component fills the node and selects its compact row or full-card layout from its own container height, while preserving the same border, copy, and Remove action. Missing `note` and `text` nodes replace their editor with this non-editable placeholder, while missing Frame and Sketch sidecars preserve structural geometry but disable their sidecar-writing controls. The Text placeholder is constrained to the same `useTextAutoSize` body box instead of sizing the React Flow node from its warning UI; Text height remains content-owned and is not persisted in `space.json`, so after the sidecar content is lost its prior content-derived height cannot be reconstructed.
- `node_inserted` / `node_updated` carry a snapshot; dispatcher diffs against the profile's `watchFields` to plan the minimum stages.
- Label policy: ordinary Enrich may propose a label, but Project includes it only when the request label is not a non-empty `user`/`agent` label. Because a request can already be in flight when the user renames a node, the web client re-reads the latest node before applying the response and drops its automatic label patch when that current label is user/agent-owned; other response fields still apply. The planner skips `generate_label` for protected labels. Questions bypass this path entirely, and Project explicitly excludes their automatic labels as a defensive boundary.
- The server enforces ordinary automatic-label protection again at commit: the Canvas executor removes only automatic `label`/`labelSource` fields over a currently protected label, and the content PUT resolves automatic labels against the latest sidecar under the shared Canvas mutex. Question naming instead uses the shared conversation-title policy and its node adapter: `label` is the only title value, `conversationTitleSource` is protected provenance, and accepted automatic names retain `labelSource: 'auto'`. The service rechecks current ownership, content, and label protection before an asynchronous result can write. Conversion transfers authority to the node, allowing eligible late generation and ACP updates to continue without maintaining two competing titles. Undefined generation or provider failure permits a later turn/initialize retry; see [shared conversation naming](./agent-architecture.md#panel-conversation-titles).
- Error recovery: failed extraction throws `EXTRACT_FAILED`; Persist is canvas-local (keyed by `nodeId`, written to `nodes/<nodeId>.md`) and may store placeholder metadata only when that sidecar still exists.
- Undo/redo reconciles unfinished preprocessing per node rather than cancelling the entire Canvas queue. Running tasks are compared against their actual issued inputs via `buildPreprocessSnapshot()` (including Frame child labels and node type), not merely adjacent history snapshots. Queued work reads the latest input when it fires. Unaffected work continues; changed history inputs replace the old task. Every result also checks input freshness independently of history. A stale result is discarded and its owned pending state ends without automatically preprocessing every keystroke; Note/Text still require explicit edit-settle. A protected user/agent rename is the narrow exception: the helper suppresses the automatic label while otherwise-current extraction fields remain usable. Accepted canonical src/content/label updates advance the task's comparison snapshot so its own terminal status callback remains valid.
- Deletion replaces unfinished work with a dormant deleted task, invalidating old callbacks without losing the need to finish processing after resurrection. Explicit requests received during restored-content persistence enter the same lifecycle as blocked tasks, even if no work was interrupted before deletion. Only the content queue's generation-checked successful restored-content PUT releases waiting work, including after Retry. Rapid redo cannot start work for an absent node or through an obsolete acknowledgement. Completed nodes are not blindly reprocessed. Canvas switches cancel active/blocked tasks and preserve dormant deleted records for retained history; issued requests remain tracked for DELETE ordering, not aborted. These records are session-local, not durable jobs or a missing-sidecar repair mechanism.

### Client responsibility boundary

This section is the authoritative client preprocessing ownership contract. Storage and history documentation reference it rather than defining independent scheduling rules.

| Owner                            | Responsibility                                                                                                                            | Does not own                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Editors and command post-effects | Decide when work is requested through `schedule()`; preserve edit-settle policy.                                                          | Timers, request identities, stale-response handling, or task status transitions.   |
| History/store integration        | Notify deletion with `forgetNode()`, history restoration with `reconcileHistory()`, and Canvas departure with `cancelAll()`.              | Deciding which individual tasks to cancel, resume, or mark complete.               |
| `preprocessQueue`                | Own demand, readiness, issued-input snapshots, client projection validity, and ingestion updates using one per-node task record.          | Body persistence, history snapshots, server freshness, or durable background jobs. |
| `nodeContentQueue`               | Persist bodies, retain restore barriers across failures, and call `resumeRestored()` after a generation-checked restored-content success. | Choosing whether preprocessing is needed.                                          |
| `preprocessNodeIfNeeded`         | Execute the request and build the response patch, retaining protected-label handling; callbacks pass through queue guards.                | Scheduling or task lifecycle state.                                                |
| Canvas store / UI                | Store and subscribe to ingestion display state; authoritative loads may reset it.                                                         | Independent asynchronous task decisions.                                           |
| Server pipeline                  | Extract, enrich and persist under server-side rules.                                                                                      | Browser task identity; Agent/API requests do not pass through the client queue.    |

The task phases are `queued` (debounce), `blocked` (restore persistence), `running` (issued input retained), and `deleted` (dormant history demand). Scheduling supersedes the previous task identity and coalesces work; persistence readiness only releases blocked/deleted demand and never creates demand for completed nodes. Success/error ends the running task; a stale callback cannot change a newer task's content or status. Issued promises are tracked separately solely to drain writes before DELETE, including superseded requests. Unload keepalive is best-effort and never promotes blocked work through the restore barrier.

---

## 5. Module layout

`apps/server/src/modules/preprocessing/`

| File / dir            | Responsibility                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- |
| `dispatcher.ts`       | dirty-field analysis → execution plan                                              |
| `pipeline.ts`         | ordered stage runner                                                               |
| `profiles.ts`         | per-node capability registry                                                       |
| `provider-manager.ts` | single LLM/provider entry (wraps `agent/llm.ts`)                                   |
| `types.ts`            | `Capability` / `NodeContentKind` / `NodePreprocessProfile` (incl. `bodyOwnership`) |
| `stages/`             | input-resolve · cache-check · extract · normalize · enrich · persist · project     |
| `loaders/`            | text · pdf · web · office · youtube                                                |

One route: `POST /api/canvas/:id/nodes/:nodeId/preprocess` → dispatcher.

---

## 6. Not yet done

- The web queue fences superseded task projections and status callbacks, but does not cancel or version-check server persistence. In particular, live-node history changes can still race an older derived-content server write; the DELETE-before-resurrection ordering does not apply to nodes that remain present. Request identity is client-local, not a cross-tab/server freshness contract. Completed preprocessing is not automatically recomputed for every history change; this reconciliation resumes unfinished work rather than introducing a general derived-data invalidation system.
- No per-canvas token budget; no batch enrichment (nodes processed one at a time).

## Code entry points

| File                                                                                                     | Responsibility                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [pipeline.ts](../../apps/server/src/modules/preprocessing/pipeline.ts)                                   | Ordinary stage runner and Question naming delegation  |
| [profiles.ts](../../apps/server/src/modules/preprocessing/profiles.ts)                                   | Capabilities and watched fields                       |
| [conversation-title.service.ts](../../apps/server/src/modules/agent/conversation-title.service.ts)       | Shared Chat/Question naming policy and initialization |
| [conversation-title-node-store.ts](../../apps/server/src/modules/agent/conversation-title-node-store.ts) | Canonical Question label persistence and sync         |
