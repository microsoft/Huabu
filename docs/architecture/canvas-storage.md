# Canvas Storage Architecture

> Last updated: 2026-07-21

## 1. Overview

Every canvas is fully self-contained on disk. All file I/O flows through a single `CanvasStore` facade in `apps/server/src/modules/storage/`.

Runtime Home-folder activation prepares and migrates the selected directory in a disposable child process before committing it as the active workspace. This isolation is required because synchronous filesystem calls against cloud, network, or virtual drives can block indefinitely; a stuck preparation is terminated after 70 seconds with `WORKSPACE_ACTIVATION_TIMEOUT`, while the Server event loop and previously active workspace remain available. Concurrent activation attempts return `WORKSPACE_ACTIVATION_IN_PROGRESS`. Managed-mode startup still prepares synchronously before the Server accepts requests.

## 2. Disk Layout

```
<workspace>/
  setting/                        # user-owned, cross-canvas
    user.md                     # workspace memory (user preferences)
    skills/<id>/SKILL.md          # user / memory-agent authored skills
  <canvasDir>/                    # dir name = safe(title)
    space.json                   # { canvasId, title, version, state:{nodes,edges,...}, createdAt, updatedAt }
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

- The **directory name** is derived from the canvas title via `toSafeFilename(title)`, not from `canvasId`. The stable `canvasId` only lives inside `space.json`.
- `listCanvases()` rescans the workspace on every call, skipping entries that start with `.` or lack `space.json`.
- Node filenames are `safe(label).md`; the node's stable id lives in the `id:` frontmatter field.
- Artifacts live in `.artifacts/` (hidden) named `<artifactId><ext>`. No manifest file — the filename is the URL key.
- Events are append-only JSONL (`events.jsonl`); each line is `{ ts: number, payload: RecentAction }`.

## 3. Storage Module

`apps/server/src/modules/storage/`

| File                      | Responsibility                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `paths.ts`                | The only place that joins workspace paths. All path helpers live here.                          |
| `io.ts`                   | Atomic writes, JSONL helpers, `sanitizeId`, `safeJoin`, `mkdirp`, `readJson`                    |
| `frontmatter.ts`          | `toFrontmatter` / `parseFrontmatter`                                                            |
| `naming.ts`               | `toSafeFilename`, `dedupeName`, `dedupeArtifactFilename`, `normalizeForCompare`                 |
| `name-index.ts`           | In-memory `id ↔ filename` index — shared by canvas-dirs, node list, artifacts                   |
| `canvas-dirs.ts`          | Workspace-level `canvasId → dirName` index; scan-on-demand; handles renames                     |
| `canvas-store.ts`         | `CanvasStore` class (per-canvas facade)                                                         |
| `write-coordinator.ts`    | Single durable-write chokepoint — `withCanvasMutex` / `updateNode` / `applyNodeUpdate` (see §4) |
| `index.ts`                | `getCanvasStore` / `listCanvases` / `createCanvas` / `deleteCanvas` / `resetStorageCache`       |
| `migrate-chat-threads.ts` | One-shot pi-ai `Context` → structured `.turns.jsonl` chat-thread migration                      |

Workspace activation is coordinated by `apps/server/src/modules/workspace-activation.ts`; the isolated child entry is `workspace-prepare.worker.ts`, and the ordered migration sequence is centralized in `workspace-prepare.ts`.

## 4. Write coordinator — one chokepoint for durable node writes

`store.readNode` / `store.writeNode` are the raw sync primitives, but a node's
`nodes/<safe(label)>.md` has **three** would-be writers — the content PUT
(in-app editor), preprocess persist, and the agent executor. To stop them
interleaving or clobbering each other, every durable node write funnels through
[write-coordinator.ts](../../apps/server/src/modules/storage/write-coordinator.ts):

| Export                                                        | Concurrency                                                                       | Used by                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `withCanvasMutex(canvasId, fn)`                               | per-canvas promise-chain lock                                                     | the lock itself; executor holds it for its whole batch |
| `updateNode(store, id, { expectRev?, apply, strictRename? })` | **locking** `read → rev-CAS → apply(current) → writeNode`, atomic under the mutex | content PUT, preprocess persist                        |
| `applyNodeUpdate(store, id, opts)`                            | the same core **without** the lock (caller already holds it)                      | executor (its batch already owns `withCanvasMutex`)    |

- **rev-CAS** compares `expectRev` against `nodeRevisionOf({ content, src })` of
  the current on-disk record; a stale baseline returns `{ status: 'rev-conflict', currentRev }`
  (mapped to `NODE_CONTENT_CONFLICT` 409) and writes nothing.
- **Field-ownership policy stays in each caller's `apply(current)`** — the
  coordinator only guarantees serialization + CAS, not which fields win. (e.g.
  preprocess's authored-body guard and label protection live in its `apply`.)
- The mutex being per-canvas (coarser than per-node) is deliberate: it wraps only
  the microsecond sync `.md` write, so contention is negligible. Known trade-off:
  the executor holds it for its whole (LLM-free but image-normalizing) batch, so a
  user save can briefly wait behind an agent batch.
