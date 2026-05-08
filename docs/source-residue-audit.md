# Source / Knowledge Subsystem — Cleanup Log

> Status: **complete**. This file documents the cleanup performed on the legacy `source` / `data source` / `sourceId` / `knowledge` subsystem after the per-canvas storage migration. Kept as a historical reference.

## Summary of changes

### A. Dead client code — removed

- Deleted `apps/web/src/api/knowledge.ts` and all 7 consumers (`useSourceMeta`, `AiSummaryBanner`'s old fetcher path, the drag-drop fallback in `Canvas.tsx`, the rename sync in `CanvasLayerTree.tsx`, and the `read_source` / `search_knowledge` UI branches in `ToolMessage.tsx`).
- `AiSummaryBanner` is now pure presentational; summary/keywords are hydrated from each node's frontmatter into `data.summary` / `data.keywords` server-side.

### B. Dead server code — removed

- Reworded `apps/server/src/prompt/agent.ts` docstring: `ingest_content` now reads "into the canvas store".
- Updated stale doc references in `docs/agent-context.md` and `docs/canvas-storage-refactor.md`.

### C. Shared types — trimmed and renamed

- `packages/shared/src/types/knowledge.ts` → renamed to `node-content.ts`.
- `SourceType` → `NodeContentKind`. `SourceMetadata` → `NodeContentMetadata`. `SourceKind` alias dropped. `Source`, `SourceOverview`, `CreateSourceInput` removed.
- `sourceKind` field renamed to `contentKind`.

### D. Node `sourceId` fields — removed

- Stripped `sourceId?` from `NoteNodeData`, `WebNodeData`, `PdfNodeData`, `VideoNodeData`, `ImageNodeData` and removed the `hasSourceId` guard.
- Dropped the `UpsertNode*` wrapper types.
- `WebPreview` / `WebNode` now gate on `data.content` (presence of ingested text) instead of `sourceId`.

### E. Comments — fixed

- Updated the stale comment in `ExpandedNodePanel.tsx` that referenced the deleted `SourceLibraryTree`.

### F. Folder rename

- `apps/web/src/components/Panels/DataSourcePanel/` → `CanvasLayerPanel/` (with internal `DataSourcePanel` symbol/type renamed to `CanvasLayerPanel`).

### I. Chat attachment field rename

- `ChatAttachment.originSourceId` → `originNodeId` across `packages/shared/src/types/chat.ts` and 4 read sites in web + server.

### J. Auto-layout origin field rename

- `NodeOrigin.user-excerpt.sourceId` → `excerptFromNodeId` (chosen over `parentNodeId` to avoid collision with React Flow's `parentId` containment field).

### K. Documentation sweep

- `docs/user-guide/05-sources-and-knowledge.md` rewritten to describe the per-canvas storage model.
- `docs/user-guide/03-canvas-basics.md` and `06-ai-collaboration.md` updated to remove references to the deleted Sources panel and `read_source` tool.
- `docs/user-guide/CHANGELOG.md` historical entries left intact as a record.

## Intentionally preserved

- **Preprocessing internals** (`apps/server/src/modules/preprocessing/`) still dispatch on a `sourceType` discriminator inside loaders. This is the loader plugin contract and is unrelated to the removed Source pool.
- **Canvas export/import API** (`packages/shared/src/types/canvas/canvas-api.ts`) keeps `ImportCanvasResponse` for the new zip-based `.sediment` bundle format. The legacy `ExportedSource[]` / `CanvasExportBundle` JSON types have been removed along with the Source pool; round-trip compatibility is now provided by the zip bundle, which packages canvas state together with each node's content files.
