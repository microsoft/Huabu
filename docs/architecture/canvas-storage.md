# Canvas Storage Architecture

> Last updated: 2026-08-11

## 1. Overview

Every Space remains self-contained on Disk by default, but storage no longer
presents one all-purpose `CanvasStore` as its backend contract.
`apps/server/src/modules/storage/` separates backend-neutral Blob and
Structured ports, Disk adapters, process-wide composition, and a shrinking
Disk compatibility facade. Opaque artifact bytes flow through `BlobStore`.
`StructuredStore` exposes catalogue and lifecycle repositories plus one
`SpaceHandle` whose Space-record, Canvas-log, Task, and node repositories are
asynchronous. Record, delta, and node repositories are read-only; the one
portable authority for title/state, zero or more whole-node mutations, and a
delta/publication row is `SpaceHandle.commit()`.

The Disk committer validates global-version and opaque whole-node revision
preconditions, advances every effective node/structure commit exactly once,
and returns a canonical `CanvasCommitEvent`. The same envelope is returned by
Phase-4 mutation HTTP responses and published over Canvas SSE only after
durability. A separate `structureRevision` hashes the slim title/topology
projection, so structural OCC can distinguish a true topology conflict from
an intervening node-only global version.

Space create/delete use `StructuredStore.lifecycle()`. Disk lifecycle and
aggregate commits use a restart-recovery journal, and node deletions use
durable expiring tombstones. Tasks and Runs remain a separate persistence
domain but participate in the same Space-deletion admission. Only the Disk
structured and blob adapters exist and are selectable; SQLite, Postgres, Azure
Blob, multi-process coordination, logical filesystem views, and backend
migration are not implemented.

Runtime Home-folder activation prepares and migrates the selected directory in a disposable child process before committing it as the active workspace. This isolation is required because synchronous filesystem calls against cloud, network, or virtual drives can block indefinitely; a stuck preparation is terminated after 70 seconds with `WORKSPACE_ACTIVATION_TIMEOUT`, while the Server event loop and previously active workspace remain available. Concurrent activation attempts return `WORKSPACE_ACTIVATION_IN_PROGRESS`. Managed-mode startup still prepares synchronously before the Server accepts requests.

## 2. Disk Layout

```
<workspace>/
  .huabu/                        # Disk adapter metadata, never a Space
    transactions/<txId>/         # restart-recovery manifests and payloads
    tombstones/<canvasHash>.json # expiring node anti-resurrection guards
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
- Node filenames are `safe(label).md`; the node's stable id lives in the `id:` frontmatter field. `NodeRepository` exposes only async reads and returns an opaque revision over the complete canonical record, logical name, and duplicate metadata. Node mutation is available only inside aggregate commit. A same-id transition from a Markdown-backed type to a non-Markdown type schedules sidecar deletion even though the id remains in topology. Conversely, structural PUT inserting topology over a pre-existing same-type orphan sidecar attaches the unchanged record under its exact revision; an incompatible orphan type, duplicate, or revision drift conflicts instead of being overwritten.
- A changed `SpaceHandle.commit()` writes the canonical title/state, zero or more node sidecars, one `space.json` version transition, and one `delta-log.jsonl` publication row as one durable decision. A default semantic no-op advances nothing and appends nothing. An absent delete may still persist a tombstone without becoming a visible commit.
- Every effective node-only or structural aggregate increments `space.json.version` exactly once. `structureRevision` is computed separately from the slim title/topology projection; node-only commits change the global version without changing that structural OCC token.
- The Disk `BlobStore` maps each Space scope to `.artifacts/`, with blobs named `<artifactId><ext>` and no manifest file — the filename is the URL key. Ordinary callers resolve the scope through `canvasBlobs(canvasId)`: `put()` requires an existing `SpaceRepository` record, while reads and `deleteAll()` remain available for recovery after a record goes missing. `CanvasStore` owns no artifact methods. Only the Disk blob and structured backends are implemented and selectable today.
- Events are append-only JSONL (`events.jsonl`); each line is `{ ts: number, payload: RecentAction }`. Delta publications are append-only JSONL (`delta-log.jsonl`), ordered by the same global Space version and written only by aggregate commit.
- Before a Disk aggregate or lifecycle operation mutates live paths, it publishes an immutable manifest and deterministic before/after payloads in `.huabu/transactions/`. Aggregate commits also declare the exact delta-log prefix and append bytes. Workspace preparation drives an uncommitted transaction to its before-state and a committed transaction to its declared after-state, then removes the journal. The journal covers process crashes, not un-fsynced power loss or concurrent Server processes.
- Node deletes persist five-minute, Workspace/Space-qualified tombstones in `.huabu/tombstones/`. They survive LRU eviction and restart, roll back with a failed commit, and prevent work that began before deletion from recreating a sidecar.
- `SpaceLifecycleRepository.create()` journal-publishes a catalogue directory and empty v0 record together. Delete refuses World, runs the blob cleanup hook while the record still exists, and journal-quarantines the directory. Create/delete are exclusive against blob puts and structured mutations through the process-local lifecycle gate.
- The memory analyzer reads Space existence, at most 100 recent action events, and intent episodes through one `SpaceHandle`. A missing Space skips the pass before reading memory state/chat files or calling the model; corrupt repository data still fails the pass. Chat digest and memory body/state files remain explicit Disk paths.
- **Chat history is Chat-V2, owned by Agenetes L2 — not `CanvasStore`.** The canonical per-thread conversation is a two-tier append-only log under `chat_v2/`: Tier-1 `<threadId>.events.jsonl` (`AgentStreamEvent` deltas a running turn appends, written by `FileEventLogStore`) and Tier-2 `<threadId>.turns.jsonl` (folded `AgentTurn`s, written by `FileTurnStore` — the only tier `history()` reads back). These files sit under the canvas `.history/` only because it is the Agenetes namespace `storage.root` (`canvasAcpNamespace(canvasId)`); `CanvasStore` never touches them. Do **not** confuse `chat_v2/<threadId>.events.jsonl` (agent stream events) with the sibling `events.jsonl` (canvas action log) — same suffix, unrelated content.
- Durable Agenetes workload records live in `.history/threads.json` (`agenetes-v2` schema, one record per thread; written by `FileThreadStore`). The host-local `namespace.storage.root` is never persisted: reads bind each record to the current Space namespace, so a Home synchronized across computers cannot redirect storage back to another machine's absolute path.
- Canonical Task and Run records live in `.history/tasks.json`, owned by Huabu Server through the async `CanvasTaskRepository`. The Disk adapter validates the versioned snapshot and referential integrity on every read, rejects duplicate identifiers and Runs whose Task is absent, serializes read-modify-write operations with an independent per-Canvas process-local mutex, and atomically replaces the file. Task metadata does not participate in `SpaceHandle.commit()` or `space.json` version CAS, but Task mutations share Space-lifecycle admission and reject once deletion is pending.
- Legacy chat files are one-way migrated into `chat_v2/` at workspace activation and retired to `.bak`: the oldest pi-ai `Context` `chat/<threadId>.json` via `migrate-chat-threads.ts` (hop 1), then the M5.6 `chat/<threadId>.turns.jsonl` / `.active.json` via `migrate-chat-turns.ts` (hop 2). The obsolete `CanvasStore` chat methods and `chatPath()` helper were removed in Phase 2; `chatDir()` remains because change-review and agent-owned files still use that directory.

## 3. Storage composition and ownership

`apps/server/src/modules/storage/` has three layers plus its composition root:

| Path                                            | Responsibility                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ports/blob.ts`                                 | Backend-neutral `BlobStore` connection/scope contract for opaque bytes and bounded materialization leases.                                               |
| `ports/structured.ts`                           | Catalogue/lifecycle, composite `SpaceHandle`, async read repositories, Task storage, opaque whole-node revisions, and the aggregate commit input/result. |
| `ports/contracts/`                              | Reusable Blob, catalogue, lifecycle, record, node, log, Task, structured-store, and aggregate-commit behavior suites.                                    |
| `backends/disk/space-commit.ts`                 | The one Disk record/node/delta mutation authority, OCC checks, title rename, commit event, and journal integration.                                      |
| `backends/disk/space-lifecycle.ts`              | Journal-backed catalogue + v0 create and explicit World-safe quarantine delete.                                                                          |
| `backends/disk/transaction-journal.ts`          | Manifest/payload preparation, commit markers, rollback/finalize, integrity checks, and startup recovery.                                                 |
| `backends/disk/node-repository.ts`              | Async read-only node snapshots and opaque whole-record revision derivation.                                                                              |
| `backends/disk/legacy/`                         | Disk codecs, bounded Workspace-qualified `CanvasStore` cache, durable tombstone integration, and process-local lifecycle admission beneath adapters.     |
| `compatibility/canvas.ts`                       | Transitional `getCanvasStore`/full-record-list reads and old create/delete signatures; lifecycle wrappers delegate to portable composition.              |
| `profile.ts` and `storage.ts`                   | Two-axis profile validation, adapter construction, lifecycle composition, blob scopes, Workspace leases, and cross-store admission.                      |
| `index.ts`                                      | Public exports only; application code imports here rather than reaching into an adapter.                                                                 |
| `canvas-store.ts`, `paths.ts`, `canvas-dirs.ts` | Deprecated forwarding shims with no logic, retained only for high-fanout Disk-capability imports.                                                        |

The Disk structured adapter and compatibility facade resolve the same cached
legacy object, but the object is now an adapter implementation detail rather
than a second portable write authority. `SpaceRepository`,
`CanvasDeltaRepository`, and `NodeRepository` are read-only. Application
record/node/delta writers call `SpaceHandle.commit()`; lifecycle callers use
`createSpace()` / `deleteSpace()` over `StructuredStore.lifecycle()`. The
obsolete public record CAS, delta append, `LegacyNodeStore`, and Canvas
single-node write coordinator are removed. Direct synchronous mutation remains
only inside the Disk adapter's validated transaction or explicit Disk-only
capabilities.

Canvas persistence DTOs, `structureRevision`, application-level Canvas mutex,
executor, and publication live under `modules/canvas/`. Physical Workspace
paths, name indexes, directory-handle arbitration, and boot migrations live
under `modules/workspace/`; generic filesystem and Markdown codecs live under
`utils/`. `module-boundaries.test.ts` enforces the storage dependency
direction and prevents new consumers of the forwarding shims.

Application mutation workflows also pin their Workspace identity. Every
`withCanvasMutex()` call acquires an active-Workspace operation lease before
joining its Workspace/Space-qualified queue and releases it only after the
queued task settles. The executor additionally holds one workflow lease over
artifact import and image normalization that happen before the mutex;
preprocessing holds one over route preflight, asynchronous extraction, Persist,
and its final observation. A runtime switch to another Workspace is rejected
while any such lease is live, so pre-mutex work and queued work cannot resume
against a different root.

Canvas realtime channels are qualified by the resolved Workspace path plus
`canvasId`. Subscription captures that key, publication resolves the
then-active Workspace, and unsubscribe removes from the originally captured
key. Reusing a Canvas id after a Workspace switch therefore cannot deliver the
new Workspace's commits to an older stream.

Space deletion is serialized against blob puts by a process-local, writer-preferring admission gate and holds an active-Workspace lease across blob cleanup and structured destruction. Blobs are swept before structure so a failed sweep can be retried while the Space record still names them. Puts already admitted may finish; a put queued behind a successful deletion rechecks existence and fails without recreating blobs, while a failed blob sweep leaves the record available for retry. Mutations through existing Space handles and repositories reject while deletion is active or queued; reads are not gated.

Retained Disk catalogue, lifecycle, Space-record, node, commit, blob-scope, and
legacy `CanvasStore` handles reject use after the active Workspace changes.
Each `catalog()` call returns a fresh Workspace-bound handle and each catalogue
read rescans current Disk state. The Workspace-qualified LRU is cleared and
rebuilt on the next lookup after a switch. Lifecycle admission, cache
invalidation, commit locks, and retained-handle checks are process-local Disk
guarantees, not a portable multi-process transaction contract.

The `chat_v2/` two-tier log and `threads.json` remain owned by Agenetes L2 (`FileEventLogStore`, `FileTurnStore`, and `FileThreadStore`), wired in [agenetes/drivers.ts](../../apps/server/src/modules/agent/agenetes/drivers.ts); see [agent-architecture.md](./agent-architecture.md) §5. Workspace activation is coordinated by `apps/server/src/modules/workspace-activation.ts`; the isolated child entry is `workspace-prepare.worker.ts`, and the ordered migration sequence is centralized in `workspace-prepare.ts` with migration implementations under `modules/workspace/migrations/`.

### 3.1 Task creation across persistence domains

`TaskService.create()` validates its shared request contract, target Canvas, and selectable default root Profile before mutation. It then creates a static ordinary Task Note through the authoritative Canvas executor and persists the canonical Task record through `CanvasTaskRepository`.

The Task Note and Task record deliberately remain separate persistence domains rather than introducing a cross-store transaction. If Note creation is rejected, no Task record is written; if Task persistence fails after the Note is committed, `TaskCreationError` reports the created anchor node id so the visible orphan is explicit and recoverable.

### 3.2 Task Run launch sequence

`RunLauncher.start()` validates the shared request, resolves the Canvas-scoped Task, and verifies the effective selectable root Profile before mutation. It persists a `pending` Run snapshot first, then derives a root-level Agent position to the right of the Task Note with a stable vertical offset for each Run of that Task.

The launcher creates the fixed root Agent Node through `AgentNodeService`, records its node and thread ids, and prepares the first turn through `AgentThreadService`. Because the invocation stream is lazy, the launcher persists `running` and `startedAt` before it begins background draining; a failure to persist that transition disposes the prepared invocation so Agent execution does not start.

Phase 1 deliberately has no compensation transaction or terminal Run state. A launch failure leaves the Run `pending`, while any root node or thread ids already created are retained in the Run record when available and returned on `RunLaunchError` for explicit recovery.

## 4. Aggregate Space commit

The application-level Canvas mutex serializes read/derive/commit workflows in
one Server process. It is not the durable write API. Its Workspace lease begins
before queue admission, so both time spent queued and the task itself retain
one active root. The executor and preprocess dispatcher also hold outer leases
for asynchronous work that precedes the mutex. After a route or executor
derives its canonical poststate, the persistence sequence is:

```text
read record + node snapshots
  -> derive poststate and mutations
  -> SpaceHandle.commit(expected version + whole-node revisions)
  -> durable record + nodes + delta/publication
  -> return/publish the same CanvasCommitEvent
```

The content PUT, structural PUT, node delete, preprocess persistence,
executor, and apply-delta workflows all use this boundary. Intent and
change-review mutation use their narrow async repositories; action-event and
Task writers use their own repository contracts. Task state intentionally does
not join the aggregate.

For a new Markdown-backed node, structural PUT carries the topology and first
sidecar record in one aggregate. The web content and preprocess queues hold
follow-up work until that acknowledgement supplies the effective label and
server revision. An edit made during the request is then flushed against that
revision; deleting the node before acknowledgement cancels the held work.

### 4.1 Commit unit and OCC

`SpaceCommitInput` contains the expected global version, canonical post-commit
title/state, zero or more node mutations, an exact opaque whole-record baseline
for every mutated node, and publication metadata. The committer rejects a
missing/mismatched baseline rather than allowing a partial node write. Every
put must also name a node in that post-commit topology with the same type;
stale type rewrites are rejected at the adapter boundary.

Topology membership and sidecar ownership are related but not identical. The
executor, apply-delta path, and structural PUT delete an old Markdown sidecar
when the final same-id node is non-Markdown, while their outward structural
deletion list still contains only ids absent from final topology. In the other
direction, newly inserted ids are read rather than assumed absent. Structural
PUT can attach an existing same-type orphan by submitting its unchanged record
with the exact observed revision; an incompatible type returns a content
conflict, and duplicate files or a concurrent sidecar change fail normal
whole-record OCC. Existing orphan bytes are never silently replaced merely
because topology was absent.

One changed commit advances `space.json.version` from `N` to `N + 1`, applies
all effective sidecar mutations, and appends the version-`N + 1` delta row. A
node-only commit still advances the global version; a default semantic no-op
does not. Deletes of already-absent sidecars can establish a Disk tombstone
without a version/publication change.

`structureRevision` is independent of that global cursor. It hashes the
canonical slim title, node topology/geometry, edges, and order; sidecar-owned
content/derived fields are excluded. Structural PUT sends both its observed
global version and optional structural baseline. If only node content advanced
the global version, the Server can rebase the structural write when the
revision still matches. A stale structural revision conflicts, and structural
PUT preserves opaque state keys and sidecar-owned node fields.

The Disk adapter checks record and node baselines before work and again inside
its validated synchronous mutation section. Title changes participate in the
same commit, including directory rename, title collision, and World-title
guards. Content PUT checks the current topology and canonical type before it
writes. Before asynchronous preprocessing starts, the route captures one
baseline under the Canvas mutex: the topology-owned type, global Space version,
and opaque whole-record node revision. That exact value is passed through the
dispatcher rather than recaptured after route preflight. Persist and the final
dispatcher observation reject the result if any component changed, including a
same-type delete/recreate or edit; the final check also covers cache hits and
`allowPersistence:false` runs that never enter Persist. A late content PUT
after deletion is a recoverable conflict, never a successful-looking
suppressed save.

### 4.2 Commit publication and client ordering

Every aggregate result mints one server-side `commitId` and returns a
`CanvasCommitEvent` containing:

- exact `fromVersion`, `toVersion`, and post-commit `structureRevision`;
- originator and whether its client applied the change optimistically;
- structural deltas plus optional canonical title/node/edge ordering;
- per-node `inline`, `invalidate`, or `delete` consequences.

An inline node projection is limited to 64 KiB of UTF-8 JSON. Larger node
records produce `invalidate`, which makes the client fetch the targeted
node-content endpoint rather than moving bulk extracted text over SSE.
Executor command echoes are projected to the same slim public field set.
Full change-review inverses remain in the change repository; realtime sends a
bounded `changesInvalidated` signal and the client refreshes that thread's
review list instead of embedding an ever-growing inverse history in SSE.

The durable commit completes before publication. Phase-4 mutation responses
carry the same event (and a compact acknowledgement for compatibility); for a
changed commit, the Server also sends that event through Canvas SSE. The web
client feeds both paths to one bounded `commitId`/version gate. The first
arrival wins; the other is a duplicate. The gate rejects invalid transitions,
detects gaps, suppresses an originating tab's optimistic echo, applies
non-optimistic preprocess results once, and does not overwrite unsaved local
structure with a remote structural view. A successful preprocess that made no
commit carries the exact `observedVersion` from its final authoritative check;
the web applies its legacy projection fields only while its local cursor still
equals that version. If another commit advanced the cursor, the projection is
dropped rather than patching a newer same-id node. Committing preprocess results
use their normal commit event instead.

SSE listener maps are qualified by Workspace path and Canvas id. The route
subscribes before emitting its snapshot and buffers publications during that
handshake. On disconnect the client reconnects with snapshot catch-up; adjacent
gaps are buffered, while a safe reload heals an unrecoverable gap without
replacing dirty local state.

### 4.3 Disk journal and recovery

`DiskSpaceCommitter` prepares an immutable deterministic undo/redo journal
before changing live bytes. It records exact before and after bytes for
`space.json` and every affected node path, the optional directory operation,
the exact existing delta-log length/prefix hash, and the exact bytes this
transaction appends. A malformed final JSONL crash fragment is repaired before
that prefix is fixed. Lifecycle create/delete use the same deterministic
journal format for their declared directory and file transitions.

Watcher handles are released before the aggregate's final synchronous
record/node OCC and sidecar filename plan. Only after those checks pass is the
journal prepared. Before the first live mutation, the committer re-proves the
directory source/destination, exact record baseline, every whole-node revision,
the filename plan, and the journal's raw before-state. Drift during preparation
discards the still-unapplied journal without replaying its captured bytes, so a
new external file is not mistaken for transaction output and deleted.

For a title change, directory rename is the first durable mutation. A rename
failure discards its unapplied journal and returns the corresponding typed
not-found or title conflict. After a successful rename, the declared delta
append and deterministic file apply run without a promise boundary. A failure
after live mutation but before the commit marker drives the transaction back to
its exact before-state; once the marker lands, cleanup cannot reverse the
decision. Tombstone settlement follows that same decision and rolls back with
an aborted aggregate.

On Workspace preparation, `recoverDiskTransactions()` drives an uncommitted
deterministic journal to its before-state and a committed journal to its
declared after-state, then removes transaction residue. A live file that
matches neither the recorded before nor after bytes, an unknown append tail,
an unsafe path, or corrupt manifest/payload blocks recovery rather than being
overwritten. The guarantee covers a process crash and restart. It does not
cover un-fsynced power loss or coordinate multiple Server processes.

### 4.4 Lifecycle and cross-store deletion

Create and delete do not masquerade as ordinary record commits.
`SpaceLifecycleRepository.create()` atomically publishes the Disk catalogue
directory with one empty version-0 `space.json`, returning the effective title
after directory-name de-duplication. A same-id race has one winner.

Deletion has explicit `deleted`, `not-found`, and `world-forbidden` outcomes.
Composition holds an active-Workspace lease, takes exclusive per-Space
admission, and releases native directory handles. The lifecycle repository
rejects World before invoking `beforeRemove`; that hook deletes blobs while
the structured record still exists. A blob failure leaves the Space retryable.
Disk then journal-moves the directory into transaction quarantine and removes
it after the commit marker. The cleanup hook also runs for a missing ordinary
record so a retry can remove orphaned blobs.

Blob puts, aggregate commits, Canvas-log mutation, and Task writes share the
writer-preferring lifecycle gate. Operations admitted before delete finish;
new structured mutations reject once deletion is active or queued. Reads are
not gated. Admission and Workspace leases are process-local Disk behavior.

### 4.5 Compatibility behavior

The Disk compatibility facade still exposes `getCanvasStore()`, full-record
listing used by legacy flows, and old create/delete result shapes. Its
create/delete wrappers delegate to the portable lifecycle composition; record,
node, and delta mutation are not exposed as a second portable authority.
RFS file access, export/import, external-note observation, built-in filesystem
tools, World reconciliation internals, and other physical capabilities still
depend on the Disk layout.

Two structural PUT behaviors remain temporary compatibility debt:

- a version-0 PUT for a missing id first creates an empty v0 Space through
  lifecycle, so a later commit failure leaves a visible empty member;
- accepted structural PUT uses `forceVersionBump`, preserving the historical
  behavior where an unchanged autosave advances once even though ordinary
  aggregate no-ops do not.

The repository's GitHub Issues feature was disabled when these follow-ups were
identified, so they are recorded in code comments and the storage proposal
without issue numbers.

## 5. Code entry points

| File/dir                                                                                                                     | Responsibility                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`storage/ports/structured.ts`](../../apps/server/src/modules/storage/ports/structured.ts)                                   | Normative structured catalogue, lifecycle, read repositories, Task repository, node revisions, and aggregate commit. |
| [`storage/backends/disk/space-commit.ts`](../../apps/server/src/modules/storage/backends/disk/space-commit.ts)               | Disk OCC, record/node/delta transaction, title rename, tombstones, and commit-event construction.                    |
| [`storage/backends/disk/transaction-journal.ts`](../../apps/server/src/modules/storage/backends/disk/transaction-journal.ts) | Restart-safe manifest preparation, rollback/redo, integrity validation, and recovery.                                |
| [`storage/backends/disk/space-lifecycle.ts`](../../apps/server/src/modules/storage/backends/disk/space-lifecycle.ts)         | Atomic catalogue + v0 create and journal-quarantine delete.                                                          |
| [`storage/backends/disk/node-repository.ts`](../../apps/server/src/modules/storage/backends/disk/node-repository.ts)         | Async node snapshots and opaque whole-record revision tokens.                                                        |
| [`storage/storage.ts`](../../apps/server/src/modules/storage/storage.ts)                                                     | Adapter composition, Workspace lease, blob guard, lifecycle admission, and cross-store deletion saga.                |
| [`workspace.ts`](../../apps/server/src/modules/workspace.ts)                                                                 | Active-Workspace operation leases and runtime-switch rejection while workflows remain in flight.                     |
| [`canvas/canvas-mutex.ts`](../../apps/server/src/modules/canvas/canvas-mutex.ts)                                             | Workspace/Space-qualified serialization and lease coverage for queued read/derive/commit workflows.                  |
| [`canvas/canvas-sync.ts`](../../apps/server/src/modules/canvas/canvas-sync.ts)                                               | Workspace/Space-qualified in-memory publication channels used by Canvas SSE.                                         |
| [`canvas/structure-revision.ts`](../../apps/server/src/modules/canvas/structure-revision.ts)                                 | Canonical slim structural projection and opaque structural revision.                                                 |
| [`canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                                       | Command acceptance and aggregate-commit adoption.                                                                    |
| [`preprocessing/dispatcher.ts`](../../apps/server/src/modules/preprocessing/dispatcher.ts)                                   | Exact preprocessing incarnation baselines, workflow lease, final supersession, and noncommit observed version.       |
| [`shared canvas-sync.ts`](../../packages/shared/src/types/api/canvas-sync.ts)                                                | `CanvasCommitEvent`, mutation acknowledgement, node-change policy, and SSE wire schema.                              |
| [`web canvasCommitSync.ts`](../../apps/web/src/store/canvasCommitSync.ts)                                                    | HTTP/SSE commit ordering, deduplication, version-gap, dirty-structure, and optimistic-echo policy.                   |
| [`workspace-prepare.ts`](../../apps/server/src/modules/workspace-prepare.ts)                                                 | Ordered Workspace migration/preparation and Disk transaction recovery before activation.                             |
