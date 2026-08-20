# Canvas Storage Architecture

> Last updated: 2026-08-20

## 1. Overview

Every Space remains fully self-contained on Disk by default, but storage no
longer presents one all-purpose `CanvasStore` as its application contract.
`apps/server/src/modules/storage/` separates backend-neutral blob and
structured ports, Disk adapters, process-wide composition, and a shrinking
compatibility facade.

**One handle per Space.** `space(canvasId)` vends every storage capability for
one Space: its record (`read`/`write`), the parts it holds (`nodes`, `changes`,
`tasks`, `events`), an isolated substrate for a namespace's own store
(`extension`), one blob scope per user-visible area (`blobs`, `guide`,
`memory`, `uploads`), and — where the backend has one — its directory
(`diskTree`, `null` elsewhere). It is a composition-layer facade, not a port
type: `StructuredStore` and `BlobStore` keep their interfaces and their
independence, and are joined only in the layer that already owns every
cross-store rule.

Production Canvas, agent, web, RFS, interactive-view, Task, and Workspace
reads and writes all go through those ports. `CanvasStore` remains an internal
Disk primitive and compatibility-test seam, not an application service, and
nothing in production imports it.

**A mount belongs to one Workspace.** Startup validates the profile without
opening anything when free mode has no Workspace yet. Activating one prepares
and migrates the directory in a disposable child process, then stages both
backend connections, bootstraps the Workspace's World through
`SpaceRepository.ensureWorld()`, and only then publishes the path and the
mount together — in one synchronous block, so no request sees one moved
without the other. Everything that can fail happens while the previous
Workspace is still serving, and a failure leaves it serving. Graceful shutdown
closes the mount. The child-process isolation is required because synchronous
filesystem calls against cloud, network, or virtual drives can block
indefinitely; a stuck preparation is terminated after 70 seconds with
`WORKSPACE_ACTIVATION_TIMEOUT`. Concurrent activation attempts return
`WORKSPACE_ACTIVATION_IN_PROGRESS`. Managed-mode startup prepares
synchronously before the Server accepts requests, then mounts.

The Disk-only capabilities a feature can still reach are named for the backend
that has them: `space(canvasId).diskTree` for the Space directory, the sidecar
name a record carries, the notes folder, and the duplicate-sidecar hint;
`stageSpaceImport(canvasId)` for where an imported bundle lands. Both are
`null` off Disk. `module-boundaries.test.ts` pins the exact production consumer
list of the first and rejects, repo-wide and at the import level, any
production module outside `storage/` naming a Disk layout symbol — migrations
excepted, since rewriting a frozen historical shape is the one legitimate
reason to know a layout that is no longer current.

**What is not portable is declared, not emulated.** Six features are about a
filesystem rather than about storage — bundle export and import,
reveal-in-file-manager, the built-in agent file tools, external-note
discovery, and Windows directory-handle coordination. `capabilities.ts` lists
them, `validateStorageProfile` sits beside it, and startup logs what the
selected profile does not offer, so an operator learns it when they choose a
profile rather than when a user clicks the button. Each also refuses at its own
call site, sharing the matrix's wording.

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
    skill.md                      # user-authored RFS access guide (space-guide blob scope)
    .memory/                      # hidden, AI-private (space-memory blob scope)
      space.md                    # Space memory body
    .upload/                      # hidden upload scratch (space-upload blob scope)
    .ext/<owner>.<name>/          # one directory per extension namespace
    .history/                     # hidden dir; also the Agenetes namespace storage.root
      chat_v2/                    # canonical chat log — owned by Agenetes L2, NOT CanvasStore
        <threadId>.events.jsonl   # Tier-1: append-only AgentStreamEvent delta log (live turn)
        <threadId>.turns.jsonl    # Tier-2: folded AgentTurn records — the tier history() reads
      threads.json                # Agenetes durable workload records (agenetes-v2 schema)
      chat/<threadId>.changes.json# Canvas-owned change-review sidecar; mutable, cleared on accept/revert
      events.jsonl                # canvas action log: one { ts, payload: RecentAction } per line
      delta-log.jsonl             # persisted canvas-command delta log
      tasks.json                  # versioned canonical Task and Run records
      acp-sessions.json           # per-thread ACP sessionId map (optional)
```

Key points:

- An ordinary Space **directory name** is derived from its title via `toSafeFilename(title)`, not from `canvasId`. The stable `canvasId` only lives inside `space.json`; the World is the reserved `.world` exception.
- `SpaceRepository.list()` rescans on every call, returns ordinary Spaces only, skips ordinary directories without `space.json`, rejects malformed records (including a corrupt established World), and leaves ordering to the caller. Two directories carrying the same `canvasId` are an integrity error raised by the scan, so a Finder-side duplication fails every catalogue read instead of resolving to an arbitrary copy. `worldId()` resolves the hidden World from the same rescan and rejects missing or malformed state; it is the single World resolution point the collection's own create/delete/rename refusals also go through.
- The `canvasId -> directory name` index in `canvas-dirs.ts` is invalidated **lazily**, never by a live filesystem watcher. Catalogue reads and the World resolvers re-scan unconditionally, server-owned create/rename register the new directory directly, and `CanvasStore.read()` re-scans and retries when `space.json` is missing — which is also how a Finder-side Space rename is adopted as the new title. A stale index therefore self-heals on the next read of the affected Space.
- External-note observation exists for one feature: surfacing user-authored `.md` files dropped into `<Space>/nodes/` from outside the app. There is **no workspace-level watcher**. In steady state there is at most one native `fs.watch` handle per **active Space session**; concurrent SSE subscribers to the same Space share that session, watcher, and scan, so watcher count follows distinct active Spaces rather than open streams. Opening a Space's stream arms its native watcher _before_ the one lazy scan begins (closing the scan-then-watch gap), limits that scan to eight concurrent file reads plus one asynchronous topology read for filtering known note ids, and returns a single merged snapshot; live events read the latest topology synchronously and always win over an older scan observation of the same path. When `nodes/` does not exist, non-Windows sessions watch the Space root and promote themselves to the child directory as soon as it appears. Windows sessions use one periodic existence probe instead, avoiding a root handle that would block external Space rename/delete. If an active `nodes/` directory is deleted or replaced, the session verifies its filesystem identity before emitting an empty snapshot, re-resolves a Finder-renamed Space by `canvasId`, then waits for the path and resumes child watching instead of remaining attached to the stale inode. The final `close()` releases the watcher, clears pending timers, and drops the Space's discovery state. A failed scan is not cached, so a later subscription retries. Workspace and session generations reject scans and events that resolve after a workspace switch or a close/reopen. Inactive Spaces hold no watcher and no in-memory state; their eventual state is rebuilt by the first lazy scan when they are next opened.
- Because a live `fs.watch` handle inside a Space subtree makes `renameSync` / `rmSync` fail with EPERM on Windows, `space-dir-handles.ts` arbitrates between handle owners and directory mutations. Each active external-note session registers itself against its `canvasId`; server-owned Space rename and delete bracket the mutation with `withSpaceDirHandlesReleased(canvasId, fn)`, which releases that Space's handles and lets the owner re-acquire afterwards — re-resolving the directory, so a rename re-arms at the new path and a delete collapses the session to an empty snapshot. A Space with no open stream has no registered owner, so the bracket is a plain passthrough. Neither side knows about the other.
- Workspace preparation and `SpaceRepository.ensureWorld()` share one idempotent Disk primitive, so `.world/space.json` has a single writer even though the legacy preparation path still runs before the mount. Exactly one is created after migrations; its generated `canvasId` remains stable, resolves through the normal `SpaceHandle`, and is exposed separately as `WorkspaceInfo.worldCanvasId`; ordinary Space lists continue to omit it.
- An established `.world` directory with a missing or malformed `space.json` is an integrity error. World identity is never silently regenerated, and the World cannot be deleted or directory-renamed through ordinary Space lifecycle operations.
- Reading the World reconciles one canonical `canvasRef` Portal for every live ordinary Space; a Portal Pin whose source Space has no Portal yet runs the same reconciliation first, so pinning never depends on the user having opened the World. Reconciliation creates only missing Portals in deterministic open grid slots, preserves every existing node and position, rejects duplicate or malformed Portal identities, and leaves a broken Portal when its source Space is deleted.
- Canonical Portal identity is server-owned: non-system commands cannot create or repoint a `canvasRef`, a live Portal cannot be deleted, and only a broken Portal may be removed. Portal geometry may move like ordinary World geometry, but its size is content-managed rather than manually resized.
- Persistent `frameRef` and `nodeRef` nodes have no markdown sidecars and store only their respective type plus `{ target: { canvasId, nodeId } }` and World-owned React Flow state. A `frameRef` is a Container snapshot of a source Frame, may recursively own matching `frameRef` / `nodeRef` descendants, and never reconciles later source hierarchy changes; direct references remain children of the matching `canvasRef`. `SET_PORTAL_NODE_PINS` is their sole create/remove path.
- `GET /api/canvas/:worldCanvasId/references` batch-resolves Portal titles and pinned source-node display data for both reference types without writing it into World topology. Results distinguish `ok`, `canvas-missing`, and `node-missing`; storage or parse failures remain request errors.
- Node filenames are `safe(label).md`; the node's stable id lives in the `id:` frontmatter field.
- The Disk `BlobStore` maps **one scope per user-visible area** of a Space: artifacts to `.artifacts/` (blobs named `<artifactId><ext>`, no manifest — the filename is the URL key), the memory body to `.memory/`, upload scratch to `.upload/`, and the user-authored guide to the Space root. Naming the areas is what keeps blob names flat; hierarchical names are excluded for every backend. Callers reach them as `space(canvasId).blobs` / `.memory` / `.uploads` / `.guide`: `put()` requires an existing Space record, while reads and `deleteAll()` remain available for recovery after a record goes missing. The guide scope is bounded by its **member names** rather than by a directory, because its area is the Space root — a scope that claimed the folder would list `space.json` and delete the Space on `deleteAll()`. Space deletion sweeps every area, since on a backend where dropping the record does not remove the area the bytes sit in, an unswept kind is an orphan. `CanvasStore` owns no artifact methods. Only the Disk blob and structured backends are implemented and selectable today.

- **Storage lends a place, not a data API.** `space(canvasId).extension(namespace)` returns an isolated substrate — a reserved directory on Disk, a table prefix or schema on a future backend — that a namespace builds its own store on. Storage validates the `<owner>.<name>` token, creates the namespace on demand, and destroys it with the Space; it never sees what is inside, and offers no read or write of its own. A port member per feature would oblige every future backend to model data it has no stake in, and a namespaced key/value member would fix one access shape for every owner forever. `extension()` returns `null` for a Space that does not exist, which is what stops an owner's bookkeeping write from resurrecting a Space that was just deleted. Memory-worker state (`huabu.memory`) and the debug prompt log (`huabu.prompt.log`) are the first two namespaces.
- Remote PDF preprocessing writes the already-fetched source bytes into the Space BlobStore as `artifact-<id>.pdf` before structured persistence and replaces the node's remote `src` with that key. As with other artifact imports, this blob write precedes the node write operation; a later structured persistence failure may therefore leave an unreferenced blob until Space deletion, while a blob-write failure degrades to retaining the remote URL.
- Events are append-only JSONL (`events.jsonl`); each line is `{ ts: number, payload: RecentAction }`.
- The memory analyzer reads Space existence and at most 100 recent action events through one `SpaceHandle`. A missing Space skips the pass before reading memory or calling the model; corrupt part data still fails the pass. The memory body is a blob and the worker's bookkeeping is an extension namespace, so neither is a path any more; Agenetes-owned chat history is not part of the curator bundle.
- **Chat history is Chat-V2, owned by Agenetes L2 — not `CanvasStore`.** The canonical per-thread conversation is a two-tier append-only log under `chat_v2/`: Tier-1 `<threadId>.events.jsonl` (`AgentStreamEvent` deltas a running turn appends, written by `FileEventLogStore`) and Tier-2 `<threadId>.turns.jsonl` (folded `AgentTurn`s, written by `FileTurnStore` — the only tier `history()` reads back). These files sit under the canvas `.history/` only because it is the Agenetes namespace `storage.root` (`canvasAcpNamespace(canvasId)`); `CanvasStore` never touches them. Do **not** confuse `chat_v2/<threadId>.events.jsonl` (agent stream events) with the sibling `events.jsonl` (canvas action log) — same suffix, unrelated content.
- Durable Agenetes workload records live in `.history/threads.json` (`agenetes-v2` schema, one record per thread; written by `FileThreadStore`). The host-local `namespace.storage.root` is never persisted: reads bind each record to the current Space namespace, so a Home synchronized across computers cannot redirect storage back to another machine's absolute path.
- Canonical Task and Run records live in `.history/tasks.json`, owned by Huabu Server through the async `SpaceTasks` ledger (`read`, `create`, and `runs.create`/`runs.update`). The Disk adapter validates the versioned snapshot and referential integrity on every read, rejects duplicate identifiers and Runs whose Task is absent, serializes read-modify-write operations with an independent per-Canvas process-local mutex, and atomically replaces the file. This mutex is intentionally separate from the Canvas topology write coordinator, so Task metadata does not participate in `space.json` version CAS.
- Legacy chat files are one-way migrated into `chat_v2/` at workspace activation and retired to `.bak`: the oldest pi-ai `Context` `chat/<threadId>.json` via `migrate-chat-threads.ts` (hop 1), then the M5.6 `chat/<threadId>.turns.jsonl` / `.active.json` via `migrate-chat-turns.ts` (hop 2). If hop 1 finds both formats after an interrupted launch, it completes a strict converted prefix atomically or preserves an existing tail when the full conversion is its prefix. Divergent logs are retained rather than guessed or overwritten; hop 2 skips the paired turn log while a valid same-thread legacy Context remains or its JSON cannot be read safely, so a later activation can retry both copies without blocking unrelated migrations. The obsolete `CanvasStore` chat methods and `chatPath()` helper were removed in Phase 2; `chatDir()` remains because change-review and agent-owned files still use that directory.

## 3. Storage composition and ownership

`apps/server/src/modules/storage/` has three layers plus its composition root:

| Path                           | Responsibility                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ports/blob.ts`                | Backend-neutral `BlobStore` connection/scope contract for opaque bytes and bounded materialization leases.                                                                                                                                            |
| `ports/structured.ts`          | Backend-neutral `StructuredStore`, the `SpaceRepository` collection, and the `SpaceHandle` composite: record read/ordered write, nodes, changes, Tasks, events, and the extension substrate.                                                          |
| `ports/namespace.ts`           | The `<owner>.<name>` grammar for an extension namespace — the only thing storage validates about an extension.                                                                                                                                        |
| `ports/contracts/`             | Reusable Space-collection, node, Space-write, log, blob, extension, and store suites; guarantees are the minimum every adapter implements.                                                                                                            |
| `backends/disk/`               | Disk implementations plus before-image restoration for rejected in-process ordered batches; no journal or startup recovery. `space-tree.ts` and `space-import.ts` hold the Disk-only Space directory and bundle-publication capabilities — not ports. |
| `backends/disk/legacy/`        | The legacy `CanvasStore` and its synchronous adapter primitives, bounded Workspace-qualified cache, and process-local node tombstones.                                                                                                                |
| `compatibility/canvas.ts`      | Residual Disk reads plus direct-module create/delete test fixtures; lifecycle writers are not exported from the public storage barrel.                                                                                                                |
| `space-lifecycle-admission.ts` | Backend-neutral, writer-preferring single-process coordinator shared by structured mutations and blob puts during a delete session.                                                                                                                   |
| `profile.ts` and `storage.ts`  | Backend selection, cross-axis validation, the Workspace-scoped staged mount, the `space(canvasId)` facade, blob scopes, and the blob-first deletion saga.                                                                                             |
| `capabilities.ts`              | Which product features a profile cannot serve, and why — consulted at startup and by each Disk-only feature's own refusal.                                                                                                                            |
| `testing.ts`                   | Mounts a real profile onto a temporary Workspace through the production lifecycle, so a product test is written once and run against every profile.                                                                                                   |
| `index.ts`                     | Public exports only; application code imports here rather than reaching into an adapter.                                                                                                                                                              |
| `paths.ts`, `canvas-dirs.ts`   | Deprecated forwarding shims with no logic, retained only for high-fanout compatibility imports. The third, `canvas-store.ts`, reached zero importers and is gone.                                                                                     |

The Disk structured adapter and compatibility facade resolve the same cached legacy object, so migration does not create two in-memory authorities. All portable repository methods are async. `SpaceRepository` owns membership reads, idempotent World bootstrap, structured create/rename, and an exclusive `beginDelete()` session; composition holds that session across the existing blob-first delete saga and then calls `finish()` or `abort()`. Every Space-record write goes through `SpaceHandle.write`, which is the version-checked replacement with the node and delta batch attached; `SpaceHandle.read` reads only. `SpaceNodes.read` / `readMany` / `list` / `stream` return complete records plus opaque revision tokens without exposing filenames. `readMany` is the shape most readers want — a selection, a neighbourhood, one View — and keeps their cost proportional to the request rather than to the Space; `list` / `stream` stay for work that genuinely spans it, and `stream` delivers each record as it lands. One deliberate divergence: a record a scan cannot retrieve is omitted, where reading that id directly surfaces the failure. `write` preserves the old node mutations → Space record → optional delta order. When a normal in-process node → record → delta batch rejects, the adapter must restore that batch's prestate before returning the rejection. An explicit title rename remains the preceding ordered, best-effort boundary and is not rolled back with the batch. The port does not promise process-crash or power-loss recovery, a determinate result after an unknown remote outcome, multi-process serialization, idempotent retry, or publication. Disk meets the in-process restoration requirement with its existing before-image rollback; a SQL adapter may use a native transaction.

Canvas persistence DTOs and the write coordinator live under `modules/canvas/`; Disk record paths, name indexes, and directory-handle arbitration live inside the Disk adapter; boot migrations remain under `modules/workspace/migrations/`; generic filesystem and Markdown codecs live under `utils/`. `canvasRoot()` validates the identifier and then verifies that the resolved Space directory remains a strict descendant of the active Workspace before any downstream Disk operation receives it. `module-boundaries.test.ts` enforces the storage dependency direction, keeps the deprecated forwarding-shim importer lists shrinking, pins the exact production consumer list of the Disk `diskTree` capability, and reads `product-boundary.test.ts` to reject Disk vocabulary in the suite that is supposed to prove portability.

Space deletion is serialized against composed blob puts by a writer-preferring admission coordinator and holds an active-Workspace lease across blob cleanup and structured destruction. `beginDelete()` acquires the exclusive session before blob I/O; `finish()` removes structured state, while `abort()` releases the fence without doing so. Blobs are swept before structure so a failed sweep can be retried while the Space record still names them. Puts already admitted may finish; a put queued behind a successful deletion rechecks existence and fails without recreating blobs, while a failed blob sweep leaves the record available for retry. Mutations through existing Space handles and repositories reject while deletion is active or queued; reads remain available for cleanup. Residual direct-filesystem features — bundle import/export, reveal, the built-in file tools, external-note claim, and Windows handle coordination — are outside this repository fence; they are declared Disk-only in the capability matrix rather than treated as blockers, and off Disk they are unavailable rather than emulated.

Retained Disk Space repository and handle instances, blob scopes, and legacy `CanvasStore` instances reject use after the active Workspace changes. Each `spaces()` call returns a fresh Workspace-bound handle and each read rescans current Disk state. The Workspace-qualified LRU is cleared and rebuilt on the next lookup after a switch. The delete-session contract covers overlapping operations through one configured backend instance. Disk realizes it with the shared process-local coordinator; it is not a multi-process transaction or distributed lock, and a SQL adapter must supply an equivalent backend-instance fence using its own mechanisms.

The `chat_v2/` two-tier log and `threads.json` remain owned by Agenetes L2 (`FileEventLogStore`, `FileTurnStore`, and `FileThreadStore`), wired in [agenetes/drivers.ts](../../apps/server/src/modules/agent/agenetes/drivers.ts); see [agent-architecture.md](./agent-architecture.md) §5. Workspace activation is coordinated by `apps/server/src/modules/workspace-activation.ts`; the isolated child entry is `workspace-prepare.worker.ts`, and the ordered migration sequence is centralized in `workspace-prepare.ts` with migration implementations under `modules/workspace/migrations/`.

### 3.1 Task creation across persistence domains

`TaskService.create()` validates its shared request contract, target Canvas, and selectable default root Profile before mutation. It then creates a static ordinary Task Note through the authoritative Canvas executor and persists the canonical Task record through `SpaceTasks.create`.

The Task Note and Task record deliberately remain separate persistence domains rather than introducing a cross-store transaction. If Note creation is rejected, no Task record is written; if Task persistence fails after the Note is committed, `TaskCreationError` reports the created anchor node id so the visible orphan is explicit and recoverable.

### 3.2 Task Run launch sequence

`RunLauncher.start()` validates the shared request, resolves the Canvas-scoped Task, and verifies the effective selectable root Profile before mutation. It persists a `pending` Run snapshot first, then derives a root-level Agent position to the right of the Task Note with a stable vertical offset for each Run of that Task.

The launcher creates the fixed root Agent Node through `AgentNodeService`, records its node and thread ids, and prepares the first turn through `AgentThreadService`. Because the invocation stream is lazy, the launcher persists `running` and `startedAt` before it begins background draining; a failure to persist that transition disposes the prepared invocation so Agent execution does not start.

The launch path deliberately has no compensation transaction. A launch failure leaves the Run `pending`, while any root node or thread ids already created are retained in the Run record when available and returned on `RunLaunchError` for explicit recovery.

### 3.3 Task Run completion

`RunCompletionService.complete()` validates the shared request and delegates the guarded transition to `SpaceTaskRuns.complete()`. The Disk adapter performs lookup, `running → completed`, and persistence under the existing per-Canvas Task mutation mutex, so HTTP and built-in-tool callers share one atomic transition rather than performing a read-then-update race.

A completed Run stores immutable `completion.completedAt` and an optional trimmed caller-owned `completion.message`. The platform treats the message as untrusted text and does not interpret issue, pull-request, or URL semantics. A retry with the same normalized message is idempotent and preserves the original timestamp; a different message conflicts. A `pending` Run cannot complete, and Agent turn termination never implies Run completion.

## 4. Portable write seam and application ordering

Standalone content PUT and preprocessing persist call
`updateNode(SpaceNodes, ...)`. The Canvas-domain promise-chain mutex remains
per Space and stays held across the repository's asynchronous read and CAS put.
The caller still owns field-merging policy; authored-content revisions remain
`nodeRevisionOf({ content, src })`, and a stale baseline still maps to the same
`NODE_CONTENT_CONFLICT` response.

Executor and revert batches already hold that mutex for their whole command
batch, so they make one `SpaceHandle.write(...)` call instead of
re-entering the standalone coordinator per node. That call receives complete
node puts/deletes, the next Space record, and its optional delta row. HTTP
response schemas/statuses, version increments, no-op handling, and SSE
publication remain in the Canvas application layer. Conflict responses now
report the existing logical title/label instead of a Disk filename or directory
locator.

Phase 4 changes no shared schema or web/client source. HTTP statuses and schemas
and the SSE shape remain stable, subject to the logical conflict-value correction
above. Publication remains an application action after persistence rather than
a storage-port responsibility.

The mutex is single-process application policy. It is not advertised as a
backend transaction or distributed lock; an adapter supplies its own CAS and
may be stronger than the common contract.

### 4.1 Executor persistence restoration

For a node/delta batch, Disk's ordered writer changes multiple files: affected node sidecars, `space.json`, and the append-only delta log. Its existing `runCanvasPersistenceTransaction()` helper now lives inside the Disk adapter. It captures raw bytes for `space.json` and affected sidecars, plus the delta log's existence and byte length. If a normal in-process write throws, rollback restores the sidecars and record bytes and truncates or removes the delta log back to its captured state before the rejection returns. A rejected node → record → delta batch therefore does not expose a completed prefix.

`CanvasStore.withValidatedNodeMutationTransaction()` validates `space.json` once, snapshots adapter-local tombstones for affected node ids, and grants the authoritative inserted-id set a tombstone bypass until the full commit succeeds. Rollback restores `space.json` through `writeNodeMutationRollback()` without inferring another tombstone transition, then restores the captured in-memory tombstones. The normal rejection path returns only after the persisted and in-memory prestate has been restored.

An explicit title rename is resolved before the protected node → record → delta batch and retains the old ordered, best-effort behavior; a later batch rejection does not promise to undo that rename. Artifact import happens before the Canvas mutex and is also outside this restoration boundary. Post-write change-review persistence happens afterwards. Process termination, power loss, an unknown remote outcome, and uncoordinated multi-process access can still leave an unknown or partial result: Phase 4 adds no filesystem WAL, commit marker, startup recovery, durable tombstone, idempotency record, or outbox. SQLite/Postgres may satisfy the in-process batch guarantee with a native transaction, but callers cannot infer any of those additional guarantees from it.
