# Canvas Storage Architecture

> Last updated: 2026-07-28

## 1. Overview

Every canvas is fully self-contained on disk. All file I/O flows through a single `CanvasStore` facade in `apps/server/src/modules/storage/`.

Runtime Home-folder activation prepares and migrates the selected directory in a disposable child process before committing it as the active workspace. This isolation is required because synchronous filesystem calls against cloud, network, or virtual drives can block indefinitely; a stuck preparation is terminated after 70 seconds with `WORKSPACE_ACTIVATION_TIMEOUT`, while the Server event loop and previously active workspace remain available. Concurrent activation attempts return `WORKSPACE_ACTIVATION_IN_PROGRESS`. Managed-mode startup still prepares synchronously before the Server accepts requests.

## 2. Disk Layout

```
<workspace>/
  .world/                         # hidden workspace-owned World Canvas
    space.json                    # stable generated canvasId; normal Canvas topology
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
    .history/                     # hidden dir; also the Agenetes namespace storage.root
      chat_v2/                    # canonical chat log — owned by Agenetes L2, NOT CanvasStore
        <threadId>.events.jsonl   # Tier-1: append-only AgentStreamEvent delta log (live turn)
        <threadId>.turns.jsonl    # Tier-2: folded AgentTurn records — the tier history() reads
      threads.json                # Agenetes durable workload records (agenetes-v2 schema)
      chat/<threadId>.changes.json# change-review sidecar (CanvasStore; mutable, cleared on accept/revert)
      intent.json                 # IntentEpisode[]
      events.jsonl                # canvas action log: one { ts, payload: RecentAction } per line
      delta-log.jsonl             # persisted canvas-command delta log
      acp-sessions.json           # per-thread ACP sessionId map (optional)
```

Key points:

- An ordinary Space **directory name** is derived from its title via `toSafeFilename(title)`, not from `canvasId`. The stable `canvasId` only lives inside `space.json`; the World is the reserved `.world` exception.
- `listCanvases()` rescans the workspace on every call, skipping entries that start with `.` or lack `space.json`.
- The `canvasId -> directory name` index in `canvas-dirs.ts` is invalidated **lazily**, never by a live filesystem watcher. `listCanvases()` and the World resolvers re-scan unconditionally, server-owned create/rename register the new directory directly, and `CanvasStore.read()` re-scans and retries when `space.json` is missing — which is also how a Finder-side Space rename is adopted as the new title. A stale index therefore self-heals on the next read of the affected Space.
- External-note observation exists for one feature: surfacing user-authored `.md` files dropped into `<Space>/nodes/` from outside the app. There is **no workspace-level watcher**. One native `fs.watch` handle exists per **active Space session**, and a session exists only while at least one external-note SSE subscriber is attached — so watcher count equals the number of open streams. Opening a Space's stream arms its native watcher _before_ the one lazy scan begins (closing the scan-then-watch gap), limits that scan to eight concurrent file reads plus one asynchronous topology read for filtering known note ids, and returns a single merged snapshot; live events read the latest topology synchronously and always win over an older scan observation of the same path. Concurrent subscribers share one watcher and one scan; the final `close()` releases the watcher, clears pending timers, and drops the Space's discovery state. A failed scan is not cached, so a later subscription retries. Workspace and session generations reject scans and events that resolve after a workspace switch or a close/reopen. Inactive Spaces hold no watcher and no in-memory state; their eventual state is rebuilt by the first lazy scan when they are next opened.
- Because a live `fs.watch` handle inside a Space subtree makes `renameSync` / `rmSync` fail with EPERM on Windows, `space-dir-handles.ts` arbitrates between handle owners and directory mutations. Each active external-note session registers itself against its `canvasId`; server-owned Space rename and delete bracket the mutation with `withSpaceDirHandlesReleased(canvasId, fn)`, which releases that Space's handles and lets the owner re-acquire afterwards — re-resolving the directory, so a rename re-arms at the new path and a delete collapses the session to an empty snapshot. A Space with no open stream has no registered owner, so the bracket is a plain passthrough. Neither side knows about the other.
- Workspace preparation creates exactly one hidden `.world/space.json` after migrations. Its generated `canvasId` remains stable, resolves through the normal `CanvasStore`, and is exposed separately as `WorkspaceInfo.worldCanvasId`; ordinary Canvas lists continue to omit it.
- An established `.world` directory with a missing or malformed `space.json` is an integrity error. World identity is never silently regenerated, and the World cannot be deleted or directory-renamed through ordinary Space lifecycle operations.
- Reading the World reconciles one canonical `canvasRef` Portal for every live ordinary Space; a Portal Pin whose source Space has no Portal yet runs the same reconciliation first, so pinning never depends on the user having opened the World. Reconciliation creates only missing Portals in deterministic open grid slots, preserves every existing node and position, rejects duplicate or malformed Portal identities, and leaves a broken Portal when its source Space is deleted.
- Canonical Portal identity is server-owned: non-system commands cannot create or repoint a `canvasRef`, a live Portal cannot be deleted, and only a broken Portal may be removed. Portal geometry may move like ordinary World geometry, but its size is content-managed rather than manually resized.
- Persistent `frameRef` and `nodeRef` nodes have no markdown sidecars and store only their respective type plus `{ target: { canvasId, nodeId } }` and World-owned React Flow state. A `frameRef` is a Container snapshot of a source Frame, may recursively own matching `frameRef` / `nodeRef` descendants, and never reconciles later source hierarchy changes; direct references remain children of the matching `canvasRef`. `SET_PORTAL_NODE_PINS` is their sole create/remove path.
- `GET /api/canvas/:worldCanvasId/references` batch-resolves Portal titles and pinned source-node display data for both reference types without writing it into World topology. Results distinguish `ok`, `canvas-missing`, and `node-missing`; storage or parse failures remain request errors.
- Node filenames are `safe(label).md`; the node's stable id lives in the `id:` frontmatter field.
- Artifacts live in `.artifacts/` (hidden) named `<artifactId><ext>`. No manifest file — the filename is the URL key.
- Events are append-only JSONL (`events.jsonl`); each line is `{ ts: number, payload: RecentAction }`.
- **Chat history is Chat-V2, owned by Agenetes L2 — not `CanvasStore`.** The canonical per-thread conversation is a two-tier append-only log under `chat_v2/`: Tier-1 `<threadId>.events.jsonl` (`AgentStreamEvent` deltas a running turn appends, written by `FileEventLogStore`) and Tier-2 `<threadId>.turns.jsonl` (folded `AgentTurn`s, written by `FileTurnStore` — the only tier `history()` reads back). These files sit under the canvas `.history/` only because it is the Agenetes namespace `storage.root` (`canvasAcpNamespace(canvasId)`); `CanvasStore` never touches them. Do **not** confuse `chat_v2/<threadId>.events.jsonl` (agent stream events) with the sibling `events.jsonl` (canvas action log) — same suffix, unrelated content.
- Durable Agenetes workload records live in `.history/threads.json` (`agenetes-v2` schema, one record per thread; written by `FileThreadStore`). The host-local `namespace.storage.root` is never persisted: reads bind each record to the current Space namespace, so a Home synchronized across computers cannot redirect storage back to another machine's absolute path.
- Legacy chat files are one-way migrated into `chat_v2/` at workspace activation and retired to `.bak`: the oldest pi-ai `Context` `chat/<threadId>.json` via `migrate-chat-threads.ts` (hop 1), then the M5.6 `chat/<threadId>.turns.jsonl` / `.active.json` via `migrate-chat-turns.ts` (hop 2). `chatPath()` still names the legacy `.json`, but it is no longer the live chat store.

## 3. Storage Module

`apps/server/src/modules/storage/`

| File                      | Responsibility                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.ts`                | The only place that joins workspace paths. All path helpers live here.                                                                                                                                                                                                              |
| `io.ts`                   | Atomic writes, JSONL helpers, `sanitizeId`, `safeJoin`, `mkdirp`, `readJson`                                                                                                                                                                                                        |
| `frontmatter.ts`          | `toFrontmatter` / `parseFrontmatter`                                                                                                                                                                                                                                                |
| `naming.ts`               | `toSafeFilename`, `dedupeName`, `dedupeArtifactFilename`, `normalizeForCompare`                                                                                                                                                                                                     |
| `name-index.ts`           | In-memory `id ↔ filename` index — shared by canvas-dirs, node list, artifacts                                                                                                                                                                                                       |
| `canvas-dirs.ts`          | Workspace-level `canvasId → dirName` index; scan-on-demand; handles renames                                                                                                                                                                                                         |
| `canvas-store.ts`         | `CanvasStore` class (per-canvas facade)                                                                                                                                                                                                                                             |
| `write-coordinator.ts`    | Single durable-write chokepoint — `withCanvasMutex` / `updateNode` / `applyNodeUpdate` (see §4)                                                                                                                                                                                     |
| `index.ts`                | `getCanvasStore` / `listCanvases` / `createCanvas` / `deleteCanvas` / `resetStorageCache`                                                                                                                                                                                           |
| _(not in this module)_    | The `chat_v2/` two-tier log + `threads.json` are owned by Agenetes L2 (`FileEventLogStore` / `FileTurnStore` / `FileThreadStore`), wired in [agenetes/drivers.ts](../../apps/server/src/modules/agent/agenetes/drivers.ts); see [agent-architecture.md](./agent-architecture.md) §5 |
| `migrate-chat-threads.ts` | Chat migration **hop 1**: one-shot pi-ai `Context` `.json` → legacy `.history/chat/<threadId>.turns.jsonl`                                                                                                                                                                          |
| `migrate-chat-turns.ts`   | Chat migration **hop 2**: legacy `.history/chat/<threadId>.turns.jsonl` → Agenetes Tier-2 `chat_v2/<threadId>.turns.jsonl`; retires source to `.bak`                                                                                                                                |

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
