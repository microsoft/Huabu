# Node Preprocessing

> How canvas nodes are preprocessed: a single 6-stage server pipeline that
> normalises content, optionally enriches it with one LLM stage, and persists
> knowledge sources. Every node type runs the same pipeline; a per-type profile
> decides which stages execute.

> Last updated: 2026-07-27

---

## 1. Two concepts kept separate

- **`CanvasNodeType`** ([shared](../../packages/shared/src/types/canvas/node.ts)) — the 11 node kinds (`note` / `text` / `web` / `pdf` / `office` / `image` / `video` / `audio` / `frame` / `sketch` / `question`).
- **`Capability`** — what a node participates in; each node's profile lists its capabilities and the dispatcher runs capabilities, not routes.

A node is processed by asking "which capabilities are dirty for this change", not "is this an ingest or a label request".

---

## 2. Pipeline (6 stages)

Every node passes the same stages; the dispatcher skips those whose capabilities aren't in the node's profile. **All LLM / paid-provider work lives only in Enrich.**

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

| Node           | Extract      | Enrich                                | Persist | watchFields                 |
| -------------- | ------------ | ------------------------------------- | ------- | --------------------------- |
| note / text    | text         | —                                     | ✅      | content, title, labelSource |
| web            | remote fetch | label + summary + keywords            | ✅      | src, title, labelSource     |
| pdf / office   | text         | label + summary + keywords            | ✅      | src, title, labelSource     |
| image          | —            | `generate_label` (vision)             | ✅      | src, labelSource            |
| video          | —            | —                                     | ✅      | src                         |
| frame          | —            | `generate_label` (summarise children) | —       | childLabels, labelSource    |
| **question**   | —            | `generate_label`                      | —       | content                     |
| sketch / audio | —            | —                                     | —       | —                           |

`question` runs `generate_label` to auto-name itself but has no `persist_source` (not a knowledge source). `sketch` / `audio` only do `resolve_input` + `build_patch`. The `contentKind?` field (`web` / `pdf` / `office` / `note` / `text` / `image` / `video`) is just the Persist gate — set it and Stage 5 writes the node as a knowledge source; question has none. Registry: [profiles.ts](../../apps/server/src/modules/preprocessing/profiles.ts).

Each profile also declares **`bodyOwnership`** (`types.ts`): `'authored'` for user-editable bodies (`note` / `text`) → the Persist write is rev-CAS-guarded so a concurrent edit can't clobber the user's body; `'derived'` for pipeline-extracted, in-app read-only bodies (`web` / `pdf` / `office`) → no CAS (last-extraction-wins). The Persist stage reads this flag rather than hardcoding node types.

---

## 4. Triggers & state

- Frontend `preprocessNodeIfNeeded` ([preprocess.ts](../../apps/web/src/handler/canvasCommand/preprocess.ts)) is the unified entry; one `triggerPreprocessing` callback, debounced per node via [preprocessQueue.ts](../../apps/web/src/store/canvasStore/save/preprocessQueue.ts).
- Scheduling immediately marks the node ingestion state as `pending`, including the debounce wait. Preview components use that state to avoid requesting server-persisted content before preprocessing has written the node sidecar.
- **`note` / `text` are settle-triggered, not mutation-triggered.** Their label auto-derives from the first heading/line, so firing preprocess on every typing pause churned the `.md` filename. Instead [postEffects.web.ts](../../apps/web/src/handler/canvasCommand/postEffects.web.ts) skips them on mutation, and `settleNodePreprocess` ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)) fires once at the edit-done boundary — `closeExpanded` / `openExpanded` for a `note`, `TextNode`'s blur for inline `text`. The body still saves on the fast `nodeContentQueue` cadence independently; other node types keep the per-mutation debounce.
- `contentMissing` is a write barrier, not only a rendering hint. GET hydration marks every Markdown-backed node type, including Frame and Sketch, when its `.md` is absent. Load-time empty-label backfill skips it; `preprocessQueue` rejects it both when scheduled and when a delayed/keepalive request fires; and `nodeContentQueue` refuses to build a content PUT for it. The preprocess route also rejects an absent sidecar before dispatch, while the Persist stage atomically requires an existing record so an already-running extraction cannot recreate the file after external deletion. Extraction-failure placeholders may update an existing sidecar but never create one. Opening, closing, switching an expanded editor, renaming, or preprocessing therefore cannot silently recreate a frontmatter-only `nodes/<nodeId>.md`. Every missing content/artifact node uses the shared `MissingFileBanner`; the component fills the node and selects its compact row or full-card layout from its own container height, while preserving the same border, copy, and Remove action. Missing `note` and `text` nodes replace their editor with this non-editable placeholder, while missing Frame and Sketch sidecars preserve structural geometry but disable their sidecar-writing controls. The Text placeholder is constrained to the same `useTextAutoSize` body box instead of sizing the React Flow node from its warning UI; Text height remains content-owned and is not persisted in `space.json`, so after the sidecar content is lost its prior content-derived height cannot be reconstructed.
- `node_inserted` / `node_updated` carry a snapshot; dispatcher diffs against the profile's `watchFields` to plan the minimum stages.
- Label policy: Enrich may propose a label, but Project includes it only when the request label is not a non-empty `user`/`agent` label. Because a request can already be in flight when the user renames a node, the web client re-reads the latest node before applying the response and drops its automatic label patch when that current label is user/agent-owned; other response fields still apply.
- Error recovery: failed extraction throws `EXTRACT_FAILED`; Persist is canvas-local (keyed by `nodeId`, written to `nodes/<nodeId>.md`) and may store placeholder metadata only when that sidecar still exists.

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

- Per-node debounce exists (`preprocessQueue`), but there is no general requestId-based stale-result guard for out-of-order POST responses. The latest user/agent label is protected at projection time, while summaries, keywords, and other derived fields remain last-response-wins.
- No per-canvas token budget; no batch enrichment (nodes processed one at a time).
