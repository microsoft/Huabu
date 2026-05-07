# Source / Knowledge Subsystem — Residue Audit

> Generated for review only. No code was modified.
> Goal: list every remaining reference to the removed `source` / `data source` / `sourceId` / `knowledge` subsystem so they can be cleaned up incrementally.

Categories:

- **A. Dead client code** — files / imports that call deleted endpoints
- **B. Dead server code** — server-side stubs / docs pointing at removed modules
- **C. Shared types** — obsolete type definitions in `packages/shared`
- **D. Node `sourceId` fields & guards** — partly residue, partly still needed
- **E. Comments / prompts / docstrings**
- **F. Folder & component naming**
- **G. Canvas export/import bundle** — intentionally kept for back-compat, listed for awareness
- **H. Preprocessing internals still using `SourceType` etc.** — active, NOT residue (listed only so you know they're intentional)
- **I. Chat attachment `originSourceId`** — active, NOT residue
- **J. Auto-layout `origin.sourceId`** — active, NOT residue
- **K. Documentation files**

---

## A. Dead Client Code (API & Consumers)

### A1. `apps/web/src/api/knowledge.ts` — entire file is dead

All 6 exported functions hit `/api/knowledge/*` endpoints that no longer exist server-side.

| Lines | Symbol                                         | Endpoint                               |
| ----- | ---------------------------------------------- | -------------------------------------- |
| 5–12  | `getSources()`                                 | `GET /api/knowledge/sources`           |
| 15–22 | `getSource(id)`                                | `GET /api/knowledge/source/:id`        |
| 25–40 | `updateSource(id, updates)`                    | `PATCH /api/knowledge/source/:id`      |
| 44–67 | `checkSourceUsage(id)` + `SourceConflict` type | `GET /api/knowledge/source/:id/usage`  |
| 69–88 | `deleteSource(id, force?)`                     | `DELETE /api/knowledge/source/:id`     |
| 91–97 | `deleteUnusedSources()`                        | `DELETE /api/knowledge/sources/unused` |

**Action**: file can be deleted entirely once the consumers below are cleaned.

### A2. `apps/web/src/hooks/useSourceMeta.ts`

- Line 3 — `import { getSource } from '@/api/knowledge'`
- Line 5 — `import type { SourceMetadata } from '@sediment/shared'`
- Line ~74 — calls `getSource(sourceId)` to populate AI summary/keywords
- **Status**: only consumer is `AiSummaryBanner.tsx` (used by PDF/web nodes). Whole hook can be removed.

### A3. `apps/web/src/components/Nodes/AiSummaryBanner.tsx`

- Line 5 — `import { useSourceMeta } from '@/hooks/useSourceMeta'`
- Line ~13 — `useSourceMeta(sourceId)` to render summary + keywords banner
- **Status**: dead consumer of A2.

### A4. `apps/web/src/components/Nodes/pdf/PDFNode.tsx`

- Line ~88 — passes `sourceId` to `useSourceMeta()`
- **Status**: remove together with A2/A3.

### A5. `apps/web/src/components/Panels/Canvas/Canvas.tsx`

- Line 37 — `import { getSource } from '../../../api/knowledge.ts'`
- Lines ~587–602 — drag-drop fallback that loads a node's content via `getSource(sourceId)` for text/note placeholders
- **Status**: assumes a global source pool; safe to remove.

### A6. `apps/web/src/components/Panels/DataSourcePanel/CanvasLayerTree.tsx`

- Line 18 — `import { updateSource } from '@/api/knowledge.ts'`
- Line ~314 — on rename, calls `updateSource(sourceId, { title: newName })` to sync title to global pool
- **Status**: dead sync; remove the import and the call (rename should still update local node label).

### A7. `apps/web/src/components/Messages/ToolMessage.tsx`

- Lines ~40, 42 — tool icon map entries for `read_source` and `search_knowledge`
- Lines ~645, 667, 718–719, 847–848 — UI branches that render results for those two deleted tools
- **Status**: tools were deleted server-side; UI handlers are leftovers.

---

## B. Dead Server Code

### B1. Stale docstring in agent prompt

`apps/server/src/prompt/agent.ts`

- Line 31 — describes `ingest_content` as loading content "into the knowledge base"
- **Status**: knowledge base no longer exists as a separate concept; reword to "into the canvas store".

### B2. Stale doc references to deleted server module

- `docs/agent-context.md` line 482 — links to non-existent `apps/server/src/modules/knowledge/context-builder.ts`
- `docs/canvas-storage-refactor.md` line 246 — references extracting frontmatter from deleted `knowledge/file.repository.ts`

(No live server code under `apps/server/src/modules/knowledge/` — already deleted.)

---

## C. Shared Types Still Defining `Source*`

### C1. `packages/shared/src/types/knowledge.ts` — most types unused

| Type                | Lines | Status                                                                                          |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| `SourceType`        | ~6    | **KEEP** — re-exported as `SourceKind` from preprocessing types and used by loader interfaces   |
| `Source`            | 11–18 | **DEAD** — only imported by `apps/web/src/api/knowledge.ts` (A1)                                |
| `SourceOverview`    | ~24   | **DEAD** — only imported by deleted `SourceListPage`; also re-imported by A1                    |
| `SourceMetadata`    | 29–44 | **KEEP** — used by `apps/server/src/modules/preprocessing/types.ts` and by `useSourceMeta` (A2) |
| `CreateSourceInput` | 53–65 | **DEAD** — no consumers found                                                                   |

### C2. `packages/shared/src/index.ts`

- Line ~6 — re-exports the entire `knowledge.js` module. Can be narrowed once C1 is trimmed.

---

## D. Node `sourceId` Fields & `hasSourceId` Guard

### D1. `packages/shared/src/types/canvas/node.ts`

Optional `sourceId?: string` defined on:

- `NoteNodeData` (~239)
- `WebNodeData` (~252)
- `PdfNodeData` (~271)
- `VideoNodeData` (~291)
- `ImageNodeData` (~299)

`hasSourceId()` type guard at lines 368–375. Re-exported from `packages/shared/src/types/canvas/index.ts` (~line 58).

### D2. Active reads of `data.sourceId`

- `apps/web/src/components/Nodes/web/WebNode.tsx` line 34 — defensive existence check
- `apps/web/src/components/Nodes/pdf/PDFNode.tsx` line ~88 — fed into `useSourceMeta` (A4 — dead)
- `apps/web/src/handler/autoLayout/graphModel.ts` lines 140–157 — see J below (still active)

**Decision needed**: `sourceId` is still emitted by the preprocessing pipeline and by canvas import/export bundles, so the field itself can probably stay. But: nothing on the **read** side actually consumes it for product behavior anymore (other than auto-layout, J). Worth deciding whether to keep the field on node data or only on persistence/export bundles.

---

## E. Comments / Prompts / Docstrings

### E1. `apps/web/src/components/Panels/Canvas/ExpandedNodePanel.tsx`

- Line ~55 — comment "Probably better handled at the trigger site (in `SourceLibraryTree`)" — references deleted component.

### E2. Agent / system prompts

- `apps/server/src/prompt/agent.ts` line 31 — see B1.
- `docs/agent-context.md` lines 44, 117–118, 163, 359, 482 — table rows / examples for `read_source` and `search_knowledge` tools.

---

## F. Folder & Component Naming

### F1. `apps/web/src/components/Panels/DataSourcePanel/`

Current contents: `index.tsx`, `CanvasLayerTree.tsx`, `TreeRowItem.tsx`, `types.ts`.
After the recent cleanup the panel only renders the canvas layer tree — the "DataSource" name is misleading. Suggested rename: `CanvasLayerPanel/` (or similar). Cosmetic only.

---

## G. Canvas Export / Import Bundle (intentionally kept)

### G1. `packages/shared/src/types/canvas/canvas-api.ts`

- Lines ~46–52 — `ExportedSource` interface
- Line ~85 — `CanvasExportBundle.sources: ExportedSource[]`

### G2. `apps/server/src/modules/canvas/canvas.route.ts`

- Line ~328 — `sourceId: result.persistence?.sourceId ?? undefined` returned in `PreprocessNodeResponse`

These exist for round-trip compatibility with previously exported `.sediment.json` bundles. If you intend to drop sources from new exports, the `ExportedSource[]` slot can be made optional / empty; the type can stay for import-time fallback.

---

## H. Preprocessing — Active, NOT Residue (listed for awareness)

These look source-flavored but are part of the active per-canvas preprocessing pipeline. Listed so you don't accidentally delete them.

- `apps/server/src/modules/preprocessing/types.ts` — `NormalizeResult.sourceId`, `SourceMetadata` import
- `apps/server/src/modules/preprocessing/pipeline.ts` lines 189, 226 — `'persist_source'` capability flag
- `apps/server/src/modules/preprocessing/loaders/loader.interface.ts` line 11 — `supports(sourceType: string)`
- All loaders (`web.loader.ts`, `pdf.loader.ts`, `text.loader.ts`, `youtube.loader.ts`) dispatch on `sourceType`

---

## I. Chat Attachment `originSourceId` — Active, NOT Residue

`packages/shared/src/types/chat.ts` line 9 defines `originSourceId?: string` on `ChatAttachment`. Read by:

- `apps/web/src/components/Panels/ChatPanel/ChatInput.tsx` lines 253, 335
- `apps/server/src/modules/agent/agent.route.ts` lines 127–128, 794
- `apps/web/src/components/Common/NodeRef.tsx` lines 46–47

This actually means "which canvas node this attachment came from" — confusingly named but functional. Consider renaming to `originNodeId` for clarity.

---

## J. Auto-Layout `origin.sourceId` — Active, NOT Residue

- `docs/auto-layout.md` line ~33 — algorithm docs
- `apps/web/src/handler/autoLayout/graphModel.ts` lines 140–157 — builds `nodeByDataSourceId` reverse map and adds an implicit edge from each "user-excerpt" node to the node holding the same `sourceId`

This is real semantic logic for grouping excerpts with their source node. Keep — but it's the strongest reason to keep `data.sourceId` on nodes (see D).

---

## K. Documentation

### K1. User guide

- `docs/user-guide/05-sources-and-knowledge.md` — entire page describes the removed Sources pool, ingestion flow, and `SourceListPage`. Either delete or replace with per-canvas storage explanation.
- `docs/user-guide/03-canvas-basics.md` line ~87 — mentions dragging from the deleted Sources panel
- `docs/user-guide/06-ai-collaboration.md` line ~43 — `read_source` row in the agent tools table
- `docs/user-guide/CHANGELOG.md` lines ~175, ~504 — historical entries mentioning `<workspace>/sources/<Title>.md` and `sourceId` preservation. **Keep** as historical record.

### K2. Internal architecture docs

- `docs/canvas-storage-refactor.md` — refactor plan; mentions which types/endpoints were removed. Useful reference, keep.
- `docs/node_preprocessing_design.md` lines ~63, ~689, ~1022 — references old `IKnowledgeRepository` interface and `SourceType`→`SourceKind` alias.
- `docs/agent-context.md` — see B2 / E2.

---

## Suggested Cleanup Order (smallest first)

1. **Trivial**: B1, E1 (one-line comment/docstring tweaks).
2. **Small**: A6, A5, A7 (remove dead imports + the dead branches).
3. **Medium**: delete A1, A2, A3, A4 together; then trim C1 (remove `Source`, `SourceOverview`, `CreateSourceInput`); narrow C2 export.
4. **Optional / decision required**:
   - F1 — rename `DataSourcePanel/` → `CanvasLayerPanel/`.
   - D — decide whether `data.sourceId` stays on node data or moves to a serialization-only concern (tied to G + J).
   - I — rename `originSourceId` → `originNodeId` for clarity.
   - K1 — rewrite/delete the user-guide source page.
5. **Documentation sweeps**: K1, K2, B2 (run after code is settled so doc edits stick).
