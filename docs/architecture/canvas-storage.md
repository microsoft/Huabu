# Canvas Storage Architecture

> Last updated: 2026-06-29

## 1. Overview

Every canvas is fully self-contained on disk. All file I/O flows through a single `CanvasStore` facade in `apps/server/src/modules/storage/`.

## 2. Disk Layout

```
<workspace>/
  setting/                        # user-owned, cross-canvas
    .huabu.md                     # workspace memory (user preferences)
    skills/<id>/SKILL.md          # user / memory-agent authored skills
  <canvasDir>/                    # dir name = safe(title)
    canvas.json                   # { canvasId, title, version, state:{nodes,edges,...}, createdAt, updatedAt }
    nodes/
      <safe(label)>.md            # frontmatter: id/type/label/src/... + content(markdown body)
    .artifacts/                   # hidden dir
      <artifactId><ext>           # raw uploads (PDF / image / video / cover)
    .memory/                      # hidden, AI-private canvas memory
      canvas.md                   # canvas memory body
      state.json                  # memory worker bookkeeping
    .history/                     # hidden dir
      chat/<threadId>.turns.jsonl # finalized turns (append-only)
      chat/<threadId>.active.json # in-progress turn (partial)
      intent.json                 # IntentEpisode[]
      events.jsonl                # JSONL: one { ts, payload: RecentAction } per line
      delta-log.jsonl             # persisted canvas-command delta log
      acp-sessions.json           # per-thread ACP sessionId map (optional)
```

Key points:

- The **directory name** is derived from the canvas title via `toSafeFilename(title)`, not from `canvasId`. The stable `canvasId` only lives inside `canvas.json`.
- `listCanvases()` rescans the workspace on every call, skipping entries that start with `.` or lack `canvas.json`.
- Node filenames are `safe(label).md`; the node's stable id lives in the `id:` frontmatter field.
- Artifacts live in `.artifacts/` (hidden) named `<artifactId><ext>`. No manifest file — the filename is the URL key.
- Events are append-only JSONL (`events.jsonl`); each line is `{ ts: number, payload: RecentAction }`.

## 3. Storage Module

`apps/server/src/modules/storage/`

| File                                                                             | Responsibility                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `paths.ts`                                                                       | The only place that joins workspace paths. All path helpers live here.                    |
| `io.ts`                                                                          | Atomic writes, JSONL helpers, `sanitizeId`, `safeJoin`, `mkdirp`, `readJson`              |
| `frontmatter.ts`                                                                 | `toFrontmatter` / `parseFrontmatter`                                                      |
| `naming.ts`                                                                      | `toSafeFilename`, `dedupeName`, `dedupeArtifactFilename`, `normalizeForCompare`           |
| `name-index.ts`                                                                  | In-memory `id ↔ filename` index — shared by canvas-dirs, node list, artifacts             |
| `canvas-dirs.ts`                                                                 | Workspace-level `canvasId → dirName` index; scan-on-demand; handles renames               |
| `canvas-store.ts`                                                                | `CanvasStore` class (per-canvas facade)                                                   |
| `index.ts`                                                                       | `getCanvasStore` / `listCanvases` / `createCanvas` / `deleteCanvas` / `resetStorageCache` |
| `migrate.ts`                                                                     | Legacy V1→V2 migration (deprecated; runs once on workspace open)                          |
| `migrate-labels.ts`                                                              | V2→V3 (label-based dir/file renames) and V3→V4 (`.artifacts/` rename) migrations          |
| `migrate-memory.ts` · `migrate-artifact-keys.ts` · `migrate-question-content.ts` | Further one-shot migrations (memory dir, artifact keys, question sidecar body)            |
| `migration-logger.ts`                                                            | Shared logging for the one-shot migrations                                                |
