# Canvas Storage Architecture

> Last updated: 2026-08-08

## 1. Overview

Every Space remains fully self-contained on Disk by default, but storage no longer presents one all-purpose `CanvasStore` as its backend contract. `apps/server/src/modules/storage/` now separates backend-neutral blob and structured ports, Disk adapters, process-wide composition, and a Disk compatibility facade. Opaque artifact bytes flow through `BlobStore`; `StructuredStore.catalog()` exposes read-only Space listing and World discovery, while `StructuredStore.space(canvasId)` exposes async Space-record, Canvas-log, and Task repositories plus a transitional node surface whose single-node read, write, and delete primitives remain synchronous for the write-coordinator invariant. The Canvas list, Workspace World lookup, Canvas events and thread-change reads, memory analyzer record/event/intent reads, Task services, and cross-store blob-put guard use repositories. Structured writers, node access, and lifecycle mutations still use the compatibility facade.

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
    .artifacts/                   # Disk BlobStore mapping for this Space
      <artifactId><ext>           # raw uploads (PDF / image / video / cover)
    .memory/                      # hidden, AI-private canvas memory
      space.md                    # canvas memory body
      state.json                  # memory worker bookkeeping
    .history/                     # hidden dir; also the Agenetes namespace storage.root
      chat_v2/                    # canonical chat log — owned by Agenetes L2, NOT CanvasStore
        <threadId>.events.jsonl   # Tier-1: append-only AgentStreamEvent delta log (live turn)
        <threadId>.turns.jsonl    # Tier-2: folded AgentTurn records — the tier history() reads
      threads.json                # Agenetes durable workload records (agenetes-v2 schema)
      chat/<threadId>.changes.json# Canvas-owned change-review sidecar; mutable, cleared on accept/revert
      intent.json                 # IntentEpisode[]
      events.jsonl                # canvas action log: one { ts, payload: RecentAction } per line
      delta-log.jsonl             # persisted canvas-command delta log
      tasks.json                  # versioned canonical Task and Run records
      acp-sessions.json           # per-thread ACP sessionId map (optional)
```

Key points:

- An ordinary Space **directory name** is derived from its title via `toSafeFilename(title)`, not from `canvasId`. The stable `canvasId` only lives inside `space.json`; the World is the reserved `.world` exception.
- `SpaceCatalogRepository.list()` rescans on every call, returns ordinary Spaces only, skips ordinary directories without `space.json`, rejects malformed records (including a corrupt established World), and leaves ordering to the caller. `worldId()` separately resolves the hidden World and rejects missing or malformed state.
- The `canvasId -> directory name` index in `canvas-dirs.ts` is invalidated **lazily**, never by a live filesystem watcher. Catalogue reads and the World resolvers re-scan unconditionally, server-owned create/rename register the new directory directly, and `CanvasStore.read()` re-scans and retries when `space.json` is missing — which is also how a Finder-side Space rename is adopted as the new title. A stale index therefore self-heals on the next read of the affected Space.
- External-note observation exists for one feature: surfacing user-authored `.md` files dropped into `<Space>/nodes/` from outside the app. There is **no workspace-level watcher**. One native `fs.watch` handle exists per **active Space session**, and a session exists only while at least one external-note SSE subscriber is attached — so watcher count equals the number of open streams. Opening a Space's stream arms its native watcher _before_ the one lazy scan begins (closing the scan-then-watch gap), limits that scan to eight concurrent file reads plus one asynchronous topology read for filtering known note ids, and returns a single merged snapshot; live events read the latest topology synchronously and always win over an older scan observation of the same path. Concurrent subscribers share one watcher and one scan; the final `close()` releases the watcher, clears pending timers, and drops the Space's discovery state. A failed scan is not cached, so a later subscription retries. Workspace and session generations reject scans and events that resolve after a workspace switch or a close/reopen. Inactive Spaces hold no watcher and no in-memory state; their eventual state is rebuilt by the first lazy scan when they are next opened.
- Because a live `fs.watch` handle inside a Space subtree makes `renameSync` / `rmSync` fail with EPERM on Windows, `space-dir-handles.ts` arbitrates between handle owners and directory mutations. Each active external-note session registers itself against its `canvasId`; server-owned Space rename and delete bracket the mutation with `withSpaceDirHandlesReleased(canvasId, fn)`, which releases that Space's handles and lets the owner re-acquire afterwards — re-resolving the directory, so a rename re-arms at the new path and a delete collapses the session to an empty snapshot. A Space with no open stream has no registered owner, so the bracket is a plain passthrough. Neither side knows about the other.
- Workspace preparation creates exactly one hidden `.world/space.json` after migrations. Its generated `canvasId` remains stable, resolves through the normal `CanvasStore`, and is exposed separately as `WorkspaceInfo.worldCanvasId`; ordinary Canvas lists continue to omit it.
- An established `.world` directory with a missing or malformed `space.json` is an integrity error. World identity is never silently regenerated, and the World cannot be deleted or directory-renamed through ordinary Space lifecycle operations.
- Reading the World reconciles one canonical `canvasRef` Portal for every live ordinary Space; a Portal Pin whose source Space has no Portal yet runs the same reconciliation first, so pinning never depends on the user having opened the World. Reconciliation creates only missing Portals in deterministic open grid slots, preserves every existing node and position, rejects duplicate or malformed Portal identities, and leaves a broken Portal when its source Space is deleted.
- Canonical Portal identity is server-owned: non-system commands cannot create or repoint a `canvasRef`, a live Portal cannot be deleted, and only a broken Portal may be removed. Portal geometry may move like ordinary World geometry, but its size is content-managed rather than manually resized.
- Persistent `frameRef` and `nodeRef` nodes have no markdown sidecars and store only their respective type plus `{ target: { canvasId, nodeId } }` and World-owned React Flow state. A `frameRef` is a Container snapshot of a source Frame, may recursively own matching `frameRef` / `nodeRef` descendants, and never reconciles later source hierarchy changes; direct references remain children of the matching `canvasRef`. `SET_PORTAL_NODE_PINS` is their sole create/remove path.
- `GET /api/canvas/:worldCanvasId/references` batch-resolves Portal titles and pinned source-node display data for both reference types without writing it into World topology. Results distinguish `ok`, `canvas-missing`, and `node-missing`; storage or parse failures remain request errors.
- Node filenames are `safe(label).md`; the node's stable id lives in the `id:` frontmatter field.
- The Disk `BlobStore` maps each Space scope to `.artifacts/`, with blobs named `<artifactId><ext>` and no manifest file — the filename is the URL key. Ordinary callers resolve the scope through `canvasBlobs(canvasId)`: `put()` requires an existing `SpaceRepository` record, while reads and `deleteAll()` remain available for recovery after a record goes missing. `CanvasStore` owns no artifact methods. Only the Disk blob and structured backends are implemented and selectable today.
- Events are append-only JSONL (`events.jsonl`); each line is `{ ts: number, payload: RecentAction }`.
- The memory analyzer reads Space existence, at most 100 recent action events, and intent episodes through one `SpaceHandle`. A missing Space skips the pass before reading memory state/chat files or calling the model; corrupt repository data still fails the pass. Chat digest and memory body/state files remain explicit Disk paths.
- **Chat history is Chat-V2, owned by Agenetes L2 — not `CanvasStore`.** The canonical per-thread conversation is a two-tier append-only log under `chat_v2/`: Tier-1 `<threadId>.events.jsonl` (`AgentStreamEvent` deltas a running turn appends, written by `FileEventLogStore`) and Tier-2 `<threadId>.turns.jsonl` (folded `AgentTurn`s, written by `FileTurnStore` — the only tier `history()` reads back). These files sit under the canvas `.history/` only because it is the Agenetes namespace `storage.root` (`canvasAcpNamespace(canvasId)`); `CanvasStore` never touches them. Do **not** confuse `chat_v2/<threadId>.events.jsonl` (agent stream events) with the sibling `events.jsonl` (canvas action log) — same suffix, unrelated content.
- Durable Agenetes workload records live in `.history/threads.json` (`agenetes-v2` schema, one record per thread; written by `FileThreadStore`). The host-local `namespace.storage.root` is never persisted: reads bind each record to the current Space namespace, so a Home synchronized across computers cannot redirect storage back to another machine's absolute path.
- Canonical Task and Run records live in `.history/tasks.json`, owned by Huabu Server through the async `CanvasTaskRepository`. The Disk adapter validates the versioned snapshot and referential integrity on every read, rejects duplicate identifiers and Runs whose Task is absent, serializes read-modify-write operations with an independent per-Canvas process-local mutex, and atomically replaces the file. This mutex is intentionally separate from the Canvas topology write coordinator, so Task metadata does not participate in `space.json` version CAS.
- Legacy chat files are one-way migrated into `chat_v2/` at workspace activation and retired to `.bak`: the oldest pi-ai `Context` `chat/<threadId>.json` via `migrate-chat-threads.ts` (hop 1), then the M5.6 `chat/<threadId>.turns.jsonl` / `.active.json` via `migrate-chat-turns.ts` (hop 2). The obsolete `CanvasStore` chat methods and `chatPath()` helper were removed in Phase 2; `chatDir()` remains because change-review and agent-owned files still use that directory.

## 3. Storage composition and ownership

`apps/server/src/modules/storage/` has three layers plus its composition root:

| Path                                            | Responsibility                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ports/blob.ts`                                 | Backend-neutral `BlobStore` connection/scope contract for opaque bytes and bounded materialization leases.                                                                    |
| `ports/structured.ts`                           | Backend-neutral `StructuredStore`, read-only catalogue, composite `SpaceHandle`, version-CAS record repository, four log-family repositories, Task repository, and transitional `LegacyNodeStore`. |
| `ports/contracts/`                              | Reusable catalogue, record, log, Task, blob, and store suites; their concurrency guarantees apply to repository calls, not legacy facade writes.                               |
| `backends/disk/`                                | Disk implementations for blobs, catalogue, structured handles, Space records, Canvas logs, Tasks, and recovery/validation rules.                                               |
| `backends/disk/legacy/`                         | The legacy `CanvasStore` and its synchronous mutation primitives, bounded Workspace-qualified cache, node tombstones, and process-local lifecycle admission.                  |
| `compatibility/canvas.ts`                       | Legacy API for create/delete, create-time full-record `listCanvases`, and `getCanvasStore()`; deletion may yield.                                                               |
| `profile.ts` and `storage.ts`                   | Two-axis backend selection, validation, adapter construction, process-wide lifecycle, blob scopes, and cross-store deletion admission.                                        |
| `index.ts`                                      | Public exports only; application code imports here rather than reaching into an adapter.                                                                                      |
| `canvas-store.ts`, `paths.ts`, `canvas-dirs.ts` | Deprecated forwarding shims with no logic, retained only for high-fanout compatibility imports.                                                                               |

The Disk structured adapter and compatibility facade resolve the same cached legacy object, so they do not create two in-memory authorities. Repository CAS, append, and Task mutation guarantees are adapter-local while the compatibility facade remains a second write entry point. `SpaceCatalogRepository`, `SpaceRepository`, the event/delta/change/intent repositories, and `CanvasTaskRepository` are async; `LegacyNodeStore.readAllNodes()` and `streamAllNodes()` are also async, while its single-node read/write/delete primitives stay synchronous until the write-coordinator invariant is redesigned for async node storage. Catalogue listing and World discovery use the repository path. Title, create, delete, and every other lifecycle mutation remain on the compatibility path; their future portable outcomes are specified in the multi-backend proposal, not exposed as write methods yet.

Canvas persistence DTOs and the write coordinator live under `modules/canvas/`; physical Workspace paths, name indexes, directory-handle arbitration, and boot migrations live under `modules/workspace/`; generic filesystem and Markdown codecs live under `utils/`. `module-boundaries.test.ts` enforces the storage dependency direction and prevents new consumers of the forwarding shims.

Space deletion is serialized against blob puts by a process-local, writer-preferring admission gate and holds an active-Workspace lease across blob cleanup and structured destruction. Blobs are swept before structure so a failed sweep can be retried while the Space record still names them. Puts already admitted may finish; a put queued behind a successful deletion rechecks existence and fails without recreating blobs, while a failed blob sweep leaves the record available for retry. Mutations through existing Space handles and repositories reject while deletion is active or queued; reads are not gated.

Retained Disk catalogue/Space repository handles, blob scopes, and legacy `CanvasStore` instances reject use after the active Workspace changes. Each `catalog()` call returns a fresh Workspace-bound handle and each read rescans current Disk state. The Workspace-qualified LRU is cleared and rebuilt on the next lookup after a switch. All lifecycle admission, cache invalidation, and retained-handle checks are process-local Disk guarantees, not a portable multi-process transaction contract.

The `chat_v2/` two-tier log and `threads.json` remain owned by Agenetes L2 (`FileEventLogStore`, `FileTurnStore`, and `FileThreadStore`), wired in [agenetes/drivers.ts](../../apps/server/src/modules/agent/agenetes/drivers.ts); see [agent-architecture.md](./agent-architecture.md) §5. Workspace activation is coordinated by `apps/server/src/modules/workspace-activation.ts`; the isolated child entry is `workspace-prepare.worker.ts`, and the ordered migration sequence is centralized in `workspace-prepare.ts` with migration implementations under `modules/workspace/migrations/`.

### 3.1 Task creation across persistence domains

`TaskService.create()` validates its shared request contract, target Canvas, and selectable default root Profile before mutation. It then creates a static ordinary Task Note through the authoritative Canvas executor and persists the canonical Task record through `CanvasTaskRepository`.

The Task Note and Task record deliberately remain separate persistence domains rather than introducing a cross-store transaction. If Note creation is rejected, no Task record is written; if Task persistence fails after the Note is committed, `TaskCreationError` reports the created anchor node id so the visible orphan is explicit and recoverable.

### 3.2 Task Run launch sequence

`RunLauncher.start()` validates the shared request, resolves the Canvas-scoped Task, and verifies the effective selectable root Profile before mutation. It persists a `pending` Run snapshot first, then derives a root-level Agent position to the right of the Task Note with a stable vertical offset for each Run of that Task.

The launcher creates the fixed root Agent Node through `AgentNodeService`, records its node and thread ids, and prepares the first turn through `AgentThreadService`. Because the invocation stream is lazy, the launcher persists `running` and `startedAt` before it begins background draining; a failure to persist that transition disposes the prepared invocation so Agent execution does not start.

Phase 1 deliberately has no compensation transaction or terminal Run state. A launch failure leaves the Run `pending`, while any root node or thread ids already created are retained in the Run record when available and returned on `RunLaunchError` for explicit recovery.

## 4. Write coordinator — one chokepoint for durable node writes

`store.readNode` / `store.writeNode` are the raw sync primitives, but a node's
`nodes/<safe(label)>.md` has **three** would-be writers — the content PUT
(in-app editor), preprocess persist, and the agent executor. To stop them
interleaving or clobbering each other, every durable node write funnels through
[write-coordinator.ts](../../apps/server/src/modules/canvas/write-coordinator.ts):

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
- The mutex being per-canvas (coarser than per-node) is deliberate. `updateNode`
  holds it only for its short synchronous single-node critical section, while the
  executor holds it across the entire batch, including awaited blob-backed image
  normalization. A user save can therefore wait behind an agent batch.

### 4.1 Executor persistence rollback

The executor's synchronous commit section writes multiple Disk files: affected node sidecars, `space.json`, and the append-only delta log. `runCanvasPersistenceTransaction()` captures raw bytes for `space.json` and affected sidecars, plus the delta log's existence and byte length. A malformed trailing JSONL crash fragment is repaired before that boundary is recorded. If any write fails, rollback restores the sidecars and record bytes and truncates or removes the delta log back to its captured state.

`CanvasStore.withValidatedNodeMutationTransaction()` validates `space.json` once, snapshots adapter-local tombstones for affected node ids, and grants the authoritative inserted-id set a tombstone bypass until the full commit succeeds. Rollback restores `space.json` through `writeNodeMutationRollback()` without inferring another tombstone transition, then restores the captured in-memory tombstones. If any restore step fails, `CanvasPersistenceRollbackError` preserves both the original failure and every rollback error.

Artifact import happens before the Canvas mutex and is not part of this rollback boundary. Post-commit change-review persistence also happens outside the transaction. This remains Disk-era application glue under the existing Canvas mutex, not a portable cross-backend `SpaceCommit` API.
