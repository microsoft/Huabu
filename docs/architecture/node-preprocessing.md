# Node Preprocessing

> How canvas nodes are preprocessed: a single 6-stage server pipeline that
> normalises content, optionally enriches it with one LLM stage, and persists
> knowledge sources. Every node type runs the same pipeline; a per-type profile
> decides which stages execute.

---

## 1. Two concepts kept separate

- **`CanvasNodeType`** ([shared](../../packages/shared/src/types/canvas/node.ts)) — the 11 node kinds (`note` / `text` / `web` / `pdf` / `office` / `image` / `video` / `audio` / `frame` / `sketch` / `question`).
- **`Capability`** — what a node participates in; each node's profile lists its capabilities and the dispatcher runs capabilities, not routes.

A node is processed by asking "which capabilities are dirty for this change", not "is this an ingest or a label request".

---

## 2. Pipeline (6 stages)

Every node passes the same stages; the dispatcher skips those whose capabilities aren't in the node's profile. **All LLM / paid-provider work lives only in Enrich.**

| Stage           | Purpose                                                                                             | LLM?    | Persist?           |
| --------------- | --------------------------------------------------------------------------------------------------- | ------- | ------------------ |
| 1 Input Resolve | normalise raw node data into canonical input (resolve URL, artifact path, child labels)             | no      | no                 |
| 2 Extract       | parse / fetch content — text / pdf (`pdf2md`) / web (Tavily) / office / youtube loaders             | no      | no                 |
| 3 Normalize     | content hash, title, metadata merge (web/pdf cache short-circuit on unchanged `src`)                | no      | no                 |
| 4 Enrich        | `generate_label` / `generate_summary` / `generate_keywords` via `ProviderManager`                   | **yes** | no                 |
| 5 Persist       | write/update node `.md` (canvas-local, keyed by `nodeId`), hash-dedup, placeholder for empty/failed | no      | yes (policy-gated) |
| 6 Project       | assemble authoritative `patch` + diagnostics for the client                                         | no      | no                 |

Web / pdf skip Stages 2–5 when `src` is unchanged and content is cached on disk ([cache-check.ts](../../apps/server/src/modules/preprocessing/stages/cache-check.ts)); `force=true` overrides. `allowLLM=false` / interactive mode → Enrich skipped, result still valid.

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

---

## 4. Triggers & state

- Frontend `preprocessNodeIfNeeded` ([preprocess.ts](../../apps/web/src/handler/canvasCommand/preprocess.ts)) is the unified entry; one `triggerPreprocessing` callback, debounced per node via [preprocessQueue.ts](../../apps/web/src/store/canvasStore/save/preprocessQueue.ts).
- `node_inserted` / `node_updated` carry a snapshot; dispatcher diffs against the profile's `watchFields` to plan the minimum stages.
- Label policy: Enrich may propose a label, but Project includes it only when `labelSource !== 'user'`.
- Error recovery: failed extraction throws `EXTRACT_FAILED`; Persist is canvas-local (keyed by `nodeId`, written to `nodes/<nodeId>.md`) and stores a placeholder for empty / failed nodes.

---

## 5. Module layout

`apps/server/src/modules/preprocessing/`

| File / dir            | Responsibility                                                                 |
| --------------------- | ------------------------------------------------------------------------------ |
| `dispatcher.ts`       | dirty-field analysis → execution plan                                          |
| `pipeline.ts`         | ordered stage runner                                                           |
| `profiles.ts`         | per-node capability registry                                                   |
| `provider-manager.ts` | single LLM/provider entry (wraps `agent/llm.ts`)                               |
| `types.ts`            | `Capability` / `NodeContentKind` / `NodePreprocessProfile`                     |
| `stages/`             | input-resolve · cache-check · extract · normalize · enrich · persist · project |
| `loaders/`            | text · pdf · web · office · youtube                                            |

One route: `POST /api/canvas/:id/nodes/:nodeId/preprocess` → dispatcher.

---

## 6. Not yet done

- Per-node debounce exists (`preprocessQueue`), but no requestId-based stale-result guard for out-of-order POST responses (preprocessing is idempotent, so a race only wastes a request).
- No per-canvas token budget; no batch enrichment (nodes processed one at a time).
