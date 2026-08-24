# Multi-Backend Storage

Status: Phases 1–4.5 implemented; §§12.6–12.8 in progress
Last updated: 2026-08-24

> **Scope and decision confidence.** This proposal records the two-port
> `StructuredStore` / `BlobStore` split and their target backend families as
> the settled direction. The Blob contract, the structured module/repository
> shape, the Space catalogue/lifecycle, async node repository, and minimal ordered
> writer are accepted. Exact schemas, stronger transactional APIs, migration
> mechanics, backend-selection scope, virtual filesystem behavior, agent
> workspace materialization, and write-back are still design space. Remaining
> candidate interfaces below are discussion aids, not implementation
> instructions.
>
> **Implementation state.** Phase 1 merged to `main` in PR #416. `BlobStore`
> is a real backend-neutral port with a Disk adapter and a reusable contract
> suite, and artifact bytes are gone from `CanvasStore`. A 2026-08-04
> adversarial review found five defects before merge; the corrections landed
> with the phase and are described in §12.1.1.
>
> Phase 2 is specified in §12.2 and is **implemented**. `storage/` now has the
> target ports/backends/compatibility hierarchy. Phase 3 is specified in
> §12.3 and is **implemented and merged**: `StructuredStore` gained
> backend-neutral membership reads, and the Canvas list, Workspace World
> lookup, thread-change read, and memory analyzer record and event reads use
> repositories. Cross-store composition also reads the Space record to guard
> blob puts.
>
> Phase 4 is specified in §12.4 and is **implemented**. `StructuredStore`
> now exposes structured lifecycle, async node, and ordered-writer ports. The
> Disk adapter delegates to the existing layout and failure rollback, and the
> structured lifecycle, node, executor, preprocessing, event, and change
> mutations enumerated in §12.4 use the new seam. A later review pass reverted
> four Disk behavior changes the seam did not require and removed the surface
> it had left uncalled (§12.4.3); merging `main` removed intent episodes from
> the product, which flattened `history` back to `handle.events` (§12.4.4).
> This phase deliberately adds no filesystem WAL,
> process-crash recovery, durable tombstones, storage publication envelope,
> shared API, or web-client protocol. The ordered writer preserves current
> operation order. A normal in-process node → record → delta batch must
> restore its prestate before rejecting, while explicit title rename retains
> its preceding best-effort boundary. This is not a crash-recovery or
> distributed transaction contract, and an unknown remote outcome need not be
> determinate; stronger SQL semantics may be added by an adapter without
> widening the minimum contract.
> Corrections made during implementation and adversarial
> review are recorded in place, including the CAS race ordering (§12.2.5),
> log-family interface segregation (§12.2.6), and retained-handle Workspace
> guards (§12.2.4). Remaining Disk-only read and physical capabilities still
> keep non-Disk profiles unselectable. No SQLite, Postgres, or Azure adapter
> exists.
>
> Phase 4.5 moved storage-owned Disk layout behind the storage boundary in
> PR #93. What remains between the portable contracts and a second structured
> adapter is specified in §6.4 and built by three change sets rather than one
> phase: §12.6 (one Space handle and the portable read surface,
> **implemented**), §12.7 (backend-agnostic application reads,
> **implemented**), and §12.8 (the dispositions and the product-level
> harness). §12 is the authoritative plan;
> the decision table in §2 marks what each step has actually settled.

---

## 1. Summary

Huabu currently persists a Space as one self-contained directory. Structured
records, Markdown documents, opaque artifact bytes, append-only logs, and
agent-facing file access all depend on that physical layout through
`CanvasStore` and direct `node:fs` calls.

The target storage architecture separates two independently configurable
authoritative ports:

```text
Application and domain services
        ├── StructuredStore ── Disk | SQLite | Postgres
        └── BlobStore       ── Disk | Azure Blob
```

The split permits local-first, single-file database, and hosted deployments
without forcing structured records and large byte objects into the same
technology. A future filesystem-shaped view for humans and agents may be
built above these ports, but its form is intentionally unresolved here.

## 2. Decision status

| Topic                                                  | Status                    | Current position                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Separate authoritative structured and blob ports       | **Accepted** (P1, merged) | Storage is composed from `StructuredStore` and `BlobStore`; there is no single backend interface that mixes both concerns.                                                                                                                                                                                                                                                                 |
| Structured backend family                              | **Settled direction**     | Support Disk, SQLite, and Postgres implementations. Only Disk exists.                                                                                                                                                                                                                                                                                                                      |
| Blob backend family                                    | **Settled direction**     | Support Disk and Azure Blob implementations. Only Disk exists.                                                                                                                                                                                                                                                                                                                             |
| Independent composition                                | **Accepted** (P1, merged) | `StorageProfile` has two env-parsed axes; `validateStorageProfile` fails fast on unimplemented kinds and is the extension point for combination rules. The lazy `getStorage()` path now rejects profiles whose adapters require awaited initialization (§12.1.1).                                                                                                                          |
| Blob port contract                                     | **Accepted** (P1, merged) | Connection → scope, stream-oriented, no permanent absolute path in the common contract; `materialize()` returns a bounded lease for the one consumer needing a file. Replacement atomicity and post-release lease semantics are contract terms, not adapter accidents (§6.2, §12.1.1).                                                                                                     |
| Concrete interface shape and async migration           | **Accepted** (P4)         | Blob and portable structured repositories are async. `StructuredStore` exposes catalogue/lifecycle and scoped Space handles; the structured mutations enumerated in §12.4 use those ports. Disk-only physical capabilities remain explicit blockers for selecting another profile.                                                                                                         |
| Exact structured repositories and aggregate boundaries | **Accepted minimum** (P4) | Catalogue, lifecycle, Space CAS, nodes, four Canvas-log families, Tasks, and the ordered writer have reusable contracts. A rejected in-process node → record → optional-delta batch restores prestate; explicit title rename remains an earlier best-effort boundary. Crash recovery, unknown remote outcomes, idempotency, publication, and multi-process serialization are not promised. |
| Node Markdown ownership                                | **Accepted** (P4)         | Authored node content remains with structured node records because it participates in revision CAS, search, and node mutation. Opaque and large bytes remain in BlobStore.                                                                                                                                                                                                                 |
| Blob key, staging, deletion, and GC semantics          | Proposed / open           | Names are the existing `<artifactId><ext>` keys; `deleteAll()` covers Space destruction. Staging, reference counting, and GC remain undesigned. Per-key deletion stays out of the public port, but the absence of any cleanup path is what makes atomic replace mandatory (§6.2).                                                                                                          |
| Space-handle identity and caching                      | **Corrected** (P1)        | `space(id)` returning a stable handle is bounded by the LRU behind it, not guaranteed. In-memory tombstones and the filename index are therefore adapter-local caches, never durable state (§12.1.1, §12.2.4).                                                                                                                                                                             |
| Reaching one Space                                     | **Accepted** (§12.6)      | One `space(canvasId)` facade on the composition root joins both ports; the two ports keep their independence and are joined only where the cross-store rules already live. A capability only one backend has hangs off the same handle, named for that backend and typed by its absence — `diskTree`, `null` elsewhere (§6.4.1).                                                           |
| Residual per-Space files                               | **Settled direction**     | Four dispositions, not one: Disk-only and declared, portable and re-implemented, structured record, or blob (§6.4.2). Every current consumer is assigned in §6.4.3; scheduling is what stays open, and nothing is built before a backend needs it.                                                                                                                                         |
| Backend selection scope                                | **Accepted**              | Backend selection and its connection/pool are process-global. Workspaces are namespaces inside the configured backend; activating another Workspace re-scopes repository/handle operations without dropping or reconnecting the backend. A SQL profile serves every Workspace through one live connection/pool.                                                                            |
| Logical filesystem view                                | Open                      | A possible `SpaceFileView` above both stores; name and contract are not accepted yet.                                                                                                                                                                                                                                                                                                      |
| Real agent workspace                                   | Open                      | Materialized directory, OS mount, protocol-only access, or a combination remain under evaluation.                                                                                                                                                                                                                                                                                          |
| Agent-authored filesystem write-back                   | Open                      | Read-only projection, explicit checkout/commit, and live bidirectional sync are alternatives, not decisions.                                                                                                                                                                                                                                                                               |

## 3. Current system

The current disk format is documented in
[Canvas Storage Architecture](../architecture/canvas-storage.md). One Space
directory contains:

```text
<Space>/
  space.json
  nodes/*.md
  .artifacts/*
  .upload/*
  .memory/*
  .history/*
```

The legacy [`CanvasStore`](../../apps/server/src/modules/storage/canvas-store.ts)
still implements several Disk compatibility responsibilities:

- Space topology, version, node records, and filenames;
- Markdown/frontmatter serialization and node revision behavior;
- intent, event, delta, and change-review persistence;
- directory creation, rename, deletion, scanning, and export assumptions.

Artifact byte paths and streams are no longer among them — phase 1 moved them
behind `BlobStore` (§12.1). Phases 2 and 3 placed repository boundaries in
front of Space records, Canvas logs, and catalogue reads; the catalogue adapter
uses the Workspace scanner rather than the legacy class. Phase 4 added
structured lifecycle, async node, and ordered-write adapters and migrated the
Server mutation paths named in §12.4. Compatibility reads and physical
capabilities such as import/export, RFS, external-note observation/claim, and
hydration still use the Disk facade or bypass it through direct filesystem
code.

Additional modules bypass or extend that facade with real filesystem
semantics. Built-in agent tools walk directories, RFS streams local files,
external-note discovery watches `nodes/`, and export archives the entire Space
directory. Therefore wrapping `CanvasStore` in a database adapter would not by
itself make the application backend-neutral.

Canvas/Space persistence is currently Disk-only. SQLite, Postgres, and Azure
Blob adapters for this data do not yet exist.

## 4. Goals

- Preserve one domain behavior across Disk, SQLite, and Postgres structured
  implementations.
- Preserve one byte-object behavior across Disk and Azure Blob
  implementations.
- Allow structured and blob backends to be configured independently when the
  resulting deployment is valid.
- Keep business logic independent of SQL dialects, local absolute paths, and
  Azure-specific URLs.
- Retain the human-readable and agent-friendly value of the current file
  format without requiring it to remain the authoritative persistence model.
- Make concurrency, CAS, conflict, partial-failure, and whether/how to provide
  idempotency explicit rather than inheriting accidental filesystem semantics.
- Leave room for desktop single-process deployments and hosted multi-instance
  deployments.

## 5. Non-goals

- Selecting an ORM, SQL query builder, Postgres driver, or SQLite driver.
- Defining the final relational schema or migration framework.
- Choosing a VFS, FUSE, materialization, cache, or write-back design.
- Replacing RFS or the canonical `SpaceQuery` / `CanvasCommand` contracts in
  this proposal.
- Making external file edits behave identically across every backend before
  their product semantics are defined.
- Implementing online backend migration, replication, backup, or disaster
  recovery.
- Shipping any non-Disk adapter. The phases in §12 remove reasons why SQLite,
  Postgres, and Azure _cannot_ be implemented; that is not the same as
  implementing them.

## 6. Settled backend split and implemented minimum contracts

The two storage families, their target implementations, and the Phase-4
minimum contracts below are accepted. Stronger aggregate transactions,
cross-store recovery, and the remaining filesystem-shaped capabilities are
still open.

### 6.1 StructuredStore

`StructuredStore` is a domain persistence boundary, not a generic relational
database abstraction. Disk must be able to implement the same semantics
without pretending to support arbitrary SQL, joins, or callbacks executed
inside a database transaction.

Expected Canvas-domain data includes, subject to the final repository split:

- Workspace and Space catalogue records;
- Space topology, nodes, edges, geometry, and versions;
- authored node documents and node metadata;
- revisions and mutation deltas;
- artifact metadata and references to BlobStore keys;
- Canvas-owned histories and events.

Durable tombstones, idempotency records, and an outbox are possible future
records, not Phase-4 contract members or persisted-format changes.

The top-level name does not require one monolithic class. Concrete persistence
ports remain owned by their domains. L1 may own repositories such as
`SpaceRepository`, `SpaceNodes`, and the Space log parts; Agenetes L2
remains the sole owner of its existing `ThreadStore`, `EventLogStore`, and
`TurnStore` contracts. The host composition root may select one structured
backend family and inject matching adapters into both domains, but it must not
move L2 persistence ownership back into `CanvasStore`.

Every current Canvas structured port is asynchronous so a synchronous Disk or
SQLite implementation does not constrain Postgres or another remote adapter.
The corresponding migration for Agenetes ports that are synchronous today
remains future work; a blocking compatibility facade over Postgres is not an
acceptable end state.

**As implemented**, Phase 1 landed `StructuredStore` as a backend-selection
boundary whose handle was still synchronous and filename-shaped. Phase 2
established the module shape and async Space-record and Canvas-log
repositories; Phase 3 added the catalogue and bounded read migrations. Phase
4 adds structured lifecycle, async nodes, and the weak `OrderedSpaceWriter`,
then moves the structured Server mutation paths enumerated in §12.4 onto those ports. Cross-store
composition continues to use `SpaceRepository` to guard blob puts and owns the
blob-first delete saga.

Lifecycle deletion uses a two-stage repository session rather than a callback
into `BlobStore`. `beginDelete()` acquires an exclusive fence for repository
mutations and composed blob puts; composition sweeps blobs while reads remain available, then calls
`finish()` to remove structured state or `abort()` after a cleanup failure.
Disk shares one writer-preferring process coordinator with blob puts. The
portable guarantee covers overlapping calls through one configured backend
instance, not uncoordinated processes; a SQL adapter must implement that fence
with its own transaction/state/locking mechanism.

The ordered writer expresses the current precondition and operation order:
observed Space version, nodes, complete record, and optional delta. If the
node → record → delta batch rejects during a normal
in-process call, it must restore its prestate before returning. An explicit
title rename is the preceding ordered, best-effort boundary and is not covered
by that restoration guarantee. The port does not expose a generic transaction
callback or promise process-crash or power-loss recovery, a determinate result
after an unknown remote outcome, idempotency, publication, or multi-process
serialization. Disk implements restoration with caught-error before images; a
SQL adapter may use a native transaction. A future aggregate transaction/
outbox may be added if a real SQL adapter and product requirement establish its
boundary; Phase 4 does not pre-design it.

### 6.2 BlobStore

`BlobStore` owns opaque bytes, not application records. Expected payloads
include durable uploaded artifacts, generated snapshots, and media. Artifact
identity, ownership, MIME type, size, checksum, and lifecycle metadata remain
structured records that refer to an opaque blob key. Scratch and staging
ownership is explicitly open.

The common contract is stream-oriented and does not expose a permanent local
absolute path. Azure delivery URLs, local paths, and provider SDK objects are
adapter capabilities, not domain values. This is implemented in phase 1 (§7.1).

Consumers that require a real filename use `BlobScope.materialize()`, which
returns a bounded lease released in a `try/finally`. Ownership resolved to the
blob adapter rather than an application-level cache: Disk returns its own
storage path with a no-op release, and a remote backend spools to a temp file
and unlinks on release. `preprocessing` is the only such consumer, because its
document loaders take a path; everything else only wanted bytes.

**Lease semantics are part of the contract, not adapter accidents.** The two
adapters diverge exactly where a contract suite is easiest to write and
weakest: after `release()`, Disk's path is still a readable file, while a
remote backend's temp file is gone. A consumer that reads after release, or
writes through `lease.path`, works on Disk and fails or silently corrupts on
Azure. So the port fixes both ends:

- the lease path is **read-only**; writing through it is a contract violation,
  because on Disk it mutates authoritative bytes and on a remote backend it
  mutates a copy that is about to be discarded;
- the path is **invalid after `release()` resolves**. Disk keeps a no-op
  release physically, but the contract suite asserts invalidity, so a Disk-only
  consumer cannot accidentally depend on the stronger behavior.

**Replacement is atomic.** `put()` on an existing name must be observable as
all-or-nothing: a concurrent reader sees either the previous blob or the new
one, never a prefix. This is not theoretical on Disk — snapshot filenames are
content-derived and therefore deliberately reused, so overwrite is a designed
path, and a truncating write hands a partial body plus a partial
`Content-Length` to any in-flight GET. It is also the direction where Disk is
_weaker_ than the eventual remote backend, whose single PUT is already atomic;
§8's warning about depending on stronger accidental Disk guarantees does not
cover this case, and the inverse is just as portable a hazard.

Atomicity also carries the failure path. Since the port deliberately has no
per-key deletion, a torn or abandoned write cannot be cleaned up through the
port at all — an aborted upload would otherwise leave a partial blob at a live
key until the whole Space is deleted. Writing to a temporary name and renaming
into place makes the failed write invisible instead of unremovable.

### 6.3 Composition

Configuration has two axes. The current shape carries only a backend kind per
axis, because no adapter yet needs more:

```ts
interface StorageProfile {
  structured: { kind: StructuredBackendKind };
  blobs: { kind: BlobBackendKind };
}
```

Parsed from `HUABU_STRUCTURED_BACKEND` and `HUABU_BLOB_BACKEND`, both
defaulting to `disk`. Backend selection is process-global and initialization
opens one connection or pool for each configured axis. Workspace activation
selects a namespace inside those existing connections; it does not rebuild
them, and a SQL structured adapter serves every Workspace through the same
connection/pool. Credential references, config storage, and deployment-level
backend migration remain open — a Postgres DSN or Azure container reference
will extend these members.

Some combinations require capability validation. For example, Postgres plus a
node-local DiskBlob implementation is unsafe in a multi-replica deployment
unless the path is a deliberately shared and supported filesystem. SQLite on a
network filesystem has different correctness and availability constraints from
local SQLite. `validateStorageProfile()` is where such rules live; today it
rejects kinds that are named but not implemented, so an unsupported profile
fails at startup with an actionable message rather than nondeterministically
while serving data.

### 6.4 One Space handle, four dispositions — revised direction

Phases 1–4.5 established the two ports and pulled storage-owned layout inside
the boundary. What no phase has settled is the residue: the per-Space state
that is still a file because it always was one, and the fact that reaching a
Space means calling two unrelated functions. This section settles both and
supersedes the single "Space materialization" framing of §12.5.4. §§12.6–12.8
build what it settles, one change set each.

Confidence: §6.4.1, the four-outcome test in §6.4.2, the assignments in
§6.4.3, and the opaque-state member in §6.4.4 are a **settled direction**.
What remains open is scheduling — which adapter pays for which move (§12.8,
§12.9) — and the concrete member names, which are still discussion aids.

#### 6.4.1 One handle per Space

A Space's durable state spans both ports — its record and nodes are
structured, its files are bytes — so the application should reach all of it
through one object, from one function, on the object that already holds both
ports:

```ts
interface Storage {
  readonly profile: StorageProfile;
  readonly structured: StructuredStore;
  readonly blobs: BlobStore;
  space(canvasId: string): Space;
}
```

`Storage` is the composition root's own type — it is what `getStorage()`
already returns, and it is the only object in the process that holds both
ports, so it is where the two are allowed to meet. The barrel exports a free
`space(canvasId)` that is exactly `getStorage().space(canvasId)`, matching how
`canvasBlobs()` used to be called; that is an ergonomic shorthand for the same
method, not a second design.

**Both ports are reached the same way.** `StructuredStore.space(id)` returns
the structured `SpaceHandle`; `BlobStore.space(id)` returns `SpaceBlobs`, one
member per user-visible area. A Space is the unit the application addresses on
either axis, so a port that made the caller assemble a descriptor first would
be the odd one out — and the asymmetry is visible in the facade, which builds
scope descriptors by hand beside one structured handle. §12.8 closes it.

`Space` is a **composition-layer facade, not a port type**. The two ports keep
their interfaces and their independence — neither imports the other (§6.3) —
and are joined in the layer that already owns every cross-store rule: the
blob-put precondition ("bytes only for a Space whose record exists") and the
blob-first delete saga. The facade flattens both handles, so every durable part
of a Space sits at one level and which axis stores it stays storage's business.

The join cannot move down into a port, for two separate reasons:

- the two axes are configured independently, so a `SpaceHandle` that vended
  blobs would oblige the Disk structured adapter to construct an Azure blob
  handle;
- deletion ordering deliberately keeps remote blob I/O outside any database
  transaction (§6.1); a handle owning both would move that ordering inside an
  adapter.

A blob area with no Space — workspace assets, agent scratch — is a different
entry point on the connection when something needs one, not a reason to make
every caller name a descriptor today.

What was wrong was therefore only the spelling.
`getStructuredStore().space(id)`, `canvasBlobs(id)`, and `spaceDirectory(id)`
were three entry points that never said they addressed one Space.

**Backend-specific members hang off the same handle.** A capability only some
backends implement is named for the backend that has it and typed by its
absence (`null`), not hidden behind a parallel free function and not present as
a stub that throws:

```ts
interface Space {
  readonly canvasId: string;
  read(): Promise<CanvasFile | null>;
  write(input: SpaceWriteInput): Promise<SpaceWriteResult>;
  readonly nodes: SpaceNodes;
  readonly changes: SpaceChanges;
  readonly tasks: SpaceTasks;
  readonly events: SpaceEvents;
  extension(namespace: string): SpaceSubstrate; // §6.4.4
  readonly blobs: BlobScope;
  /** Disk's directory for this Space. `null` on every other backend. */
  readonly diskTree: DiskSpaceTree | null;
}
```

A caller branching on `null` is told the truth once; a caller that must
remember a second import is being asked to know the storage module's internal
topology. An earlier unmerged attempt at this work exposed the Disk tree as a
standalone `diskSpaceTree()` free function to keep an unportable surface from
looking portable; the fence that actually does that work is the name and the
enumerated consumer list, and both survive the move onto the handle.

#### 6.4.2 The disposition test

§12.5.2 asked of a _symbol_: is it still useful, unchanged, when the structured
backend becomes SQLite? That question sorted `paths.ts`. Asked of a _consumer_
it sorts the residual filesystem population — and it returns four answers, not
one:

| Disposition                     | The question under SQLite                         | Consequence                                                             |
| ------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| **A. Disk-only**                | Meaningless — the feature is _about_ a filesystem | Not implemented off Disk. The feature is **unavailable**, not emulated. |
| **B. Portable, re-implemented** | Survives; only the mechanism dies                 | A declared capability every backend answers in its own way.             |
| **C. Structured record**        | It was a record wearing a file's clothes          | Moves to `StructuredStore`.                                             |
| **D. Blob**                     | It is genuinely a named file                      | Moves to `BlobStore`.                                                   |

An earlier unmerged attempt assigned **A** to all of them and offered one
route out: features stop needing a tree, and an agent reaches a Space over
Huabu's HTTP API. That is right for A and wrong for the other three. B, C, and
D do not need the HTTP API — they need a port, and routing them through an API
instead would leave the same state unportable behind a network hop.

An outcome of A is an acceptable, stated product limitation, not debt. It
belongs in a capability matrix that `validateStorageProfile()` can consult,
alongside the existing rule that an unimplemented kind fails at startup.

**A is the default answer, and the cheap one.** B, C, and D each cost a port
change, a contract suite, and a migration; A costs a row in the matrix. A
family earns B, C, or D by a product need that survives being told plainly
"this is not available on that backend" — not by being technically portable.
Where the two are close, take A and say so. A workaround that makes a feature
_nearly_ work on a backend is worse than its absence: it has to be built,
tested, and explained, and it hides the limitation instead of stating it.

**Nothing here is built before a backend needs it.** Assigning a disposition
fixes the direction; it does not schedule the work. B and the open parts of C
and D land with the adapter that first requires them, so the second backend
pays for its own portability rather than Disk paying in advance for a
requirement nobody has stated. The exception is a move that simplifies Disk on
its own merits — deleting an ad-hoc file format in favour of a record the Space
handle already writes — which is worth doing whenever it comes up.

#### 6.4.3 Inventory

Every consumer that reaches a Space as a filesystem tree today, with its
disposition. Every assignment is settled; what is deferred is _when_ each is
built, not _where_ it goes — §12.8 builds the ones that pay for themselves on
Disk alone (§6.4.2, §12.9).

| Consumer                                                   | What it does today                                             | Disposition                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /:id/export` — Space bundle                           | `archiver.glob('**/*', {cwd: spaceDir, dot: true})`            | **A**, accepted. A _portable_ export generated from records plus reachable blob references is a separate later design (§11); the current bundle is a Disk projection.                                                                       |
| `POST /import` — Space bundle                              | Unzip into a staging dir, rename into place                    | **A**, accepted. Same pairing as export.                                                                                                                                                                                                    |
| `POST /:id/reveal-nodes`                                   | `openInFileManager(nodesDir)`                                  | **A**, accepted. The feature _is_ "show me this in Finder".                                                                                                                                                                                 |
| Built-in `read`/`write`/`glob`/`grep` tools (`fs-sandbox`) | Space directory as the sandbox root                            | **A**, accepted. Off Disk the first-party agent uses RFS/HTTP, which is what external agents already use (§9).                                                                                                                              |
| Windows directory-handle coordination                      | `registerHandleOwner` around `fs.watch` handles                | **A**, accepted. Exists so a directory rename can succeed; no directory, no problem.                                                                                                                                                        |
| External-note observation and claim                        | `fs.watch` on `nodes/`, then read + unlink                     | **A** as a product feature; **B** for the notification underneath it. Nothing is built until a second backend exists — see below.                                                                                                           |
| RFS path → node resolution                                 | `nodeIdForPath('nodes/Foo.md')` inverts Disk's filename        | **B**, deferred. Every backend can mint `nodes/<label>.md` names from records; Disk keeps inverting the real filename because the file is really there. Until a second backend exists, RFS's file plane is Disk's.                          |
| Memory-worker state (`.memory/state.json`)                 | `atomicWriteJson` of `{counter, lastAnalyzedAt, cursor}`       | **C**, accepted. Per-Space bookkeeping with no reason to be a file; a small store on the §6.4.4 substrate.                                                                                                                                  |
| Space-existence guard (`existsSync(spaceDir)`)             | Resurrection guard in the memory trigger                       | **C**, accepted — and it disappears rather than moving. The guard exists because an ad-hoc file write can recreate a deleted Space's directory; a structured record write cannot, because the port refuses a write to a Space that is gone. |
| ACP session state (`.history/acp-sessions.json`)           | Handed to the ACP driver as `storage.root`                     | **C**, accepted. Storage supplies an isolated substrate under a namespace (§6.4.4); Agenetes keeps its own ports, its own store, and its own schema (§6.1).                                                                                 |
| Chat prompt log (`.history/chat/<thread>.prompt.log`)      | Written under `HUABU_DEBUG_PROMPT`, never read by the app      | **C**, accepted. One namespace on the §6.4.4 substrate, one entry per thread.                                                                                                                                                               |
| Memory body (`.memory/space.md`)                           | AI-private Markdown an agent reads and rewrites                | **D**, accepted. A document the agent edits as a file.                                                                                                                                                                                      |
| `skill.md` (per-Space RFS access guide)                    | User-authored override read at the Space root                  | **D**, accepted. A future `AGENTS.md` is the same case.                                                                                                                                                                                     |
| Upload scratch (`.upload/`)                                | RFS upload and interactive-view write here through the sandbox | **D**, accepted. Its own scope kind, so retention can differ from artifacts later without moving the bytes again.                                                                                                                           |

Three consequences worth stating separately.

**B is where "watch" belongs — later.** Change notification is not a
filesystem primitive a database lacks; it is a database primitive a filesystem
happens to also have (`fs.watch`, a SQLite update hook, Postgres
`LISTEN`/`NOTIFY`). That is why the disposition is B rather than A.

The product behaviour layered on it today does _not_ generalize: external-note
discovery watches for documents that arrived **without going through the
application**, and a database backend has no such arrival path unless someone
writes to the store out of band. Rather than invent one, external-note
discovery is simply unavailable off Disk, and the notification capability is
declared only when a second backend has a consumer for it. Building a portable
watch port now would buy nothing — the one caller is the Disk-only feature.

**D changes what `BlobStore` is for, minimally.** §6.2 says blobs are "opaque
bytes, not application records", with names that are the existing
`<artifactId><ext>` keys. Named user-authored documents — `skill.md`, a future
`AGENTS.md`, the memory body — are still opaque to storage, so the contract
holds unchanged. One detail needs a decision and it has a cheap answer: the
Disk adapter maps the single canvas scope onto `.artifacts/`, so a blob named
`skill.md` would land in a hidden directory rather than at the Space root where
a user authors it. Give `SpaceBlobs` one member per user-visible area. That is
a member and a placement rule per adapter; it keeps the Disk layout a user sees
unchanged, and it avoids hierarchical names, which §7.1 excluded for every
backend and which would be the expensive answer to the same problem.

Rename and per-key delete stay **unsupported**, as they are today. A human will
eventually want to remove a `skill.md`, and the honest answer until some
product operation actually requires it is that storage does not offer it —
overwriting is the supported edit. Adding per-key deletion drags in the
reference-counting and GC design §14 already parks, which is a large bill for a
small convenience.

#### 6.4.4 The extension point is a connection, not a data API

Disposition C must not grow `StructuredStore` one member per feature —
`memory`, `acpSessions`, `promptLogs` — obliging every future backend to model
data it has no stake in. §12.5.7 rejected exactly that when it declined a
`SpaceChats.list()` port.

A namespaced opaque key/value member on the port is the obvious repair and is
also wrong, for a reason worth recording: it fixes one access shape —
whole-value rewrite, no queries, no indexes — for every owner, forever. An
owner with real query needs then encodes its own index inside an opaque value,
which is the two-authorities hazard reappearing one level down. The sibling
`../octostaff` bubble runtime shows what the owners actually look like: each
extension ships its own `repository-contract.ts` with `repository-memory.ts`
and `repository-postgres.ts` beside it, and the Postgres one is constructed
with an injected `PostgresConnection` carrying `sql` and a `schema` name.

So the port exposes **the connection point and nothing else**. The owner brings
its own store implementations and its own SQL:

```ts
/** What a namespace gets to build on. Discriminated by the live backend. */
type SpaceSubstrate =
  | { kind: 'disk'; directory: string }
  | { kind: 'sqlite'; db: SqliteDatabase; tablePrefix: string }
  | { kind: 'postgres'; sql: Sql; schema: string };

interface Space {
  /** Isolated substrate for one namespace's own store. */
  extension(namespace: string): SpaceSubstrate;
}
```

The namespace is the isolation token and the only thing storage validates: a
reserved directory on Disk, a table prefix on SQLite, a schema on Postgres.
Storage guarantees the namespace is unique and unshared. It guarantees nothing
about what is inside, and cannot, because it never sees the data.

**Storage keeps lifecycle, because only it can.** A namespace is created on
demand and destroyed with the Space — `rm -rf` the directory, drop tables
matching the prefix, drop the schema. That keeps `beginDelete`/`finish` whole
without any owner registering a cleanup hook, and it is the one operation an
owner cannot perform without knowing a layout that is not its own.

**An extension supports the backends it chooses.** One that implements only
`disk` does not load under Postgres, and that is a stated limitation rather
than a defect — disposition A applied one level out (§6.4.2). Storage's
contract suites cover none of this: there is no portable behaviour to assert
about data the port cannot read.

**Ownership does not move.** Agenetes keeps `ThreadStore`, `EventLogStore`, and
`TurnStore` as its contracts (§6.1) and gains a substrate to implement them
over, in place of a bare directory path. What §12.5.7 forbade — Huabu's ports
learning the shape of agent-runtime data — is stronger here than under a
key/value member: the port does not store the data, it hands over a place to
put it.

Three consequences to accept openly rather than design against:

- **The backend kind is part of the extension API.** An owner written against
  `sqlite` breaks if a deployment moves to Postgres. That is inherent in
  letting owners write their own SQL, and the alternative is the lowest common
  denominator this section exists to avoid.
- **The substrate is unfenced.** A live `sql` handle can run arbitrary DDL
  outside its schema, and a directory path is the very thing §12.5.4 pulled
  back inside the boundary. The namespace bounds it by convention, not by
  enforcement. Extensions are in-process code, trusted at the same level as the
  Server; an untrusted or out-of-process extension model is not supported and is
  not being designed here.
- **First-party state pays the same price.** Memory-worker state is three
  fields, and under a substrate it needs a small store per backend kind rather
  than a `put()`. §12.8 writes the Disk one directly. If a second owner wants
  the same shape, extract a shared key/value helper **over** the substrate, in
  `utils/` — never as a port member, because that is the design this section
  rejected.

`Namespace.storage.root` follows from this. Under bubble's pattern the driver
is constructed with its substrate by the composition root, so the serializable
`Namespace` carries only the scope name and never a path or a live handle —
which is also what §14 asked for.

## 7. Contracts

### 7.1 BlobStore — normative

The blob sketch that appeared here has been superseded by the implemented
port in
[`ports/blob.ts`](../../apps/server/src/modules/storage/ports/blob.ts), whose
contract suite is
[`ports/contracts/blob-store.contract.ts`](../../apps/server/src/modules/storage/ports/contracts/blob-store.contract.ts).
This section is a transcription of that file and must be updated with it; the
code is authoritative when they disagree. The shape is connection → scope
rather than one flat key space:

```ts
interface BlobStore {
  readonly kind: BlobBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  scope(ref: BlobScopeRef): BlobScope;
}

interface BlobScope {
  put(name, body): Promise<BlobInfo>;
  head(name): Promise<BlobInfo | null>;
  open(name, range?): Promise<BlobRead | null>;
  read(name): Promise<Buffer | null>;
  hasMany(names): Promise<ReadonlySet<string>>;
  list(): Promise<BlobInfo[]>;
  materialize(name): Promise<BlobLease | null>;
  deleteAll(): Promise<void>;
}
```

Resolved by implementing it: range reads **are** required (`canvas-executor`
reads the first 64 KiB of an image for its aspect ratio); keys are **not**
content-addressed — `name` is the existing `<artifactId><ext>` string that is
already the URL key and node `src`; per-key deletion is **not** public,
because nothing deletes an individual artifact today and adding it without a
GC design would be speculative.

Two consequences of that key decision are worth stating explicitly, because
they bind every future adapter:

- **The keyspace is flat by contract.** Names normalize to their last path
  segment, so `nested/dir/k.png` and `k.png` are the same blob. Azure permits
  `/` in blob names, so this is a Disk-shaped constraint that remote adapters
  must emulate rather than a neutral one. It is accepted — callers pass
  `src`-shaped values and the basename rule is what makes that work — but it
  is the mirror image of the §13 risk about SQL backends emulating a directory
  tree, and it should be revisited before a scope kind needs hierarchy.
- **`put()` has no options.** Content type is not stored; it is inferred from
  the name at the HTTP boundary. That is sufficient while `sendBlob` is the
  only delivery path, and it is exactly what a signed-URL delivery capability
  would bypass — see §14.

`hasMany` exists so a remote adapter can answer a bounded set membership
question in one request. The Disk adapter currently answers it with a full
`readdir` plus a `stat` per candidate, which is the opposite of bounded; that
is an adapter inefficiency, not a contract change (§12.1.1).

### 7.2 StructuredStore — implemented minimum

The connection → scoped-handle shape and record/log members landed in phase
2, membership reads in phase 3, and the collection lifecycle, async node, and
weak ordered-write seams in phase 4. §§12.2–12.4 are authoritative for their
acceptance boundaries; §12.4.1 records the trim and §12.4.2 the member
vocabulary that together produced the surface below. Earlier phase sections
show member names as they stood in their own phase.

One verb means one thing throughout: `read` fetches one record or a part's
contents, `list` a whole collection; `create` adds where an existing record is
an error, `put` writes one complete record by id and replaces it if present,
`append` adds to an ordered sequence, `update` changes part of an existing
record, `delete` removes one record by id, and `write` is the Space's own
ordered multi-part mutation. `worldId()` and `beginDelete()` are the
exceptions: one names what it returns, the other opens a session.

```ts
interface StructuredStore {
  readonly kind: StructuredBackendKind; // 'disk' — implemented adapters only

  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;

  spaces(): SpaceRepository;
  space(canvasId: string): SpaceHandle;
}

/** The Space collection in one backend namespace. */
interface SpaceRepository {
  list(): Promise<CanvasSummary[]>;
  worldId(): Promise<string>;
  create(input: SpaceCreateInput): Promise<SpaceCreateResult>;
  beginDelete(input: SpaceDeleteInput): Promise<SpaceBeginDeleteResult>;
  rename(input: SpaceRenameInput): Promise<SpaceRenameResult>;
}

interface SpaceDeleteSession {
  finish(): Promise<SpaceDeleteFinishResult>;
  abort(): Promise<void>;
}

/**
 * The Space *is* its record, so `read`/`write` sit on the handle; the members
 * are the parts it holds.
 */
interface SpaceHandle {
  readonly canvasId: string;
  read(): Promise<CanvasFile | null>;
  write(input: SpaceWriteInput): Promise<SpaceWriteResult>;

  readonly nodes: SpaceNodes;
  readonly changes: SpaceChanges;
  readonly tasks: SpaceTasks;
  readonly events: SpaceEvents; // read(limit?), append(events)
}

interface SpaceNodes {
  readonly canvasId: string;
  read(nodeId: string): Promise<NodeSnapshot | null>;
  put(input: NodePutInput): Promise<NodePutResult>;
  delete(nodeId: string): Promise<'deleted' | 'absent'>;
}

interface SpaceChanges {
  read(threadId: string): Promise<CanvasChangeRecord[]>;
  append(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]>;
  delete(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null>;
}

/** One ledger: a Run is only meaningful beside the Task it executes. */
interface SpaceTasks {
  read(): Promise<TaskStoreSnapshot>; // Tasks and Runs in one snapshot
  create(task: TaskRecord): Promise<void>;
  readonly runs: SpaceTaskRuns; // create(run), update(runId, patch)
}
```

The minimum contract is intentionally narrower than a transaction.
`SpaceHandle.write` checks the observed Space version and applies node
mutations, the complete Space record, and an optional delta in that order. A
normal in-process rejection from the node → record → delta batch must
restore that batch's prestate; Disk uses caught-error before images and a SQL
adapter may use a native transaction. Explicit title rename remains the
preceding ordered, best-effort boundary. Process death, power loss, unknown
remote outcomes, multi-process access, idempotent retry, and publication are
outside the contract. Whether the product needs a future atomic aggregate/
outbox contract remains open and must be validated against a real second
adapter rather than inferred from Disk.

## 8. Cross-store consistency — proposed, not settled

Postgres and Azure Blob cannot share an ACID transaction. Portable behavior
must not depend on stronger accidental guarantees from Disk + Disk — nor on
Disk being the _weaker_ side, which is the case for write atomicity (§6.2).
Both directions produce code that is correct against one adapter only.

Phase 4 does not settle this problem. Create changes structured state only;
delete keeps the existing composition-owned blob-first saga. The structured
backend's `beginDelete()` session fences repository mutations while composition
sweeps blobs and then calls `finish()` or `abort()`; blob puts participate in
the same single-process coordinator. No outbox, garbage collector, or
distributed lifecycle fence is introduced. The flows below remain candidates
for a later multi-process or mixed-backend design.

A candidate create/replace flow is:

```text
write immutable blob
  -> verify size/checksum
  -> structured transaction records metadata + reference + outbox
  -> retry or garbage-collect an unreferenced blob on failure
```

A candidate deletion flow first removes or marks the structured reference,
then deletes the blob asynchronously after a grace period.

Replacement of a _referenced_ artifact would write a new key and atomically
swap the structured reference rather than overwrite bytes in place. This does
not contradict the port's in-place `put()` (§6.2, §7.1): today's overwrites are
content-derived snapshot regenerations where the new bytes equal the old, so
no reference changes hands. Once a replacement can change what a stable key
means, it needs the new-key-and-swap flow, and in-place overwrite becomes a
dedup optimization rather than the replacement mechanism.

`deleteCanvas` is the one place where this design already exists in code.
Phase 1 inverted its order: it now sweeps blobs while the structured record
that names them still exists, then destroys the structured records. This
avoids leaving unreachable remote blobs if deletion fails; retry/outbox
machinery remains open.

This is a likely saga/outbox design, but the staging state machine, retry
policy, reference counting, retention period, and garbage collector are open.

## 9. Agent-facing file access today

The codebase currently has several different mechanisms that are easy to
mislabel as one VFS:

| Mechanism                             | Current behavior                                                                                                                                                                    | Important limitation                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Built-in `read`, `grep`, `find`, `ls` | [`fs-sandbox.ts`](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) maps Space-relative paths to the real active Space directory and handlers call `node:fs`.       | Server-side tool emulation; not a filesystem mounted into an agent process.                                                                      |
| ACP `/space/...`                      | [`capabilities/fs.ts`](../../apps/server/src/modules/agent/acp/capabilities/fs.ts) defines a synthetic absolute ACP path and maps it back to Disk for read-only access.             | Not an OS path, and the production ACP driver currently does not inject the `fsReadTextFile` host port, so requests are rejected as unavailable. |
| RFS reachback                         | [`rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts) exposes download, upload, query, execute, and skill endpoints over canvas-scoped HTTP.                       | The API is active and backend-adaptable, but its file plane currently streams and writes real local files.                                       |
| External-note discovery               | [`external-watcher.ts`](../../apps/server/src/modules/canvas/external-watcher.ts) watches an active Space's `nodes/` directory and surfaces new Markdown files for explicit import. | Disk-specific product behavior, not general bidirectional synchronization.                                                                       |
| Reveal/export/import                  | Canvas routes reveal `nodes/`, glob a Space directory into an archive, or ingest an archive.                                                                                        | Assumes a local directory is the storage layout.                                                                                                 |

External Codex and Claude adapters currently receive the Agent Profile's
working directory as their process `cwd`, not the active Space directory. They
access Space data primarily through prompt references and RFS reachback. A path
such as `/space/nodes/Foo.md` is meaningful only to a protocol handler; native
`cat`, `rg`, and editor operations require a path visible to the process's
operating system and permitted by the agent sandbox.

The current design exists for valid reasons:

- built-in tools provide bounded, sandboxed filesystem-like reads without
  giving the first-party agent an unrestricted shell;
- the ACP synthetic path satisfies an absolute-path protocol shape without
  disclosing Huabu's real workspace layout;
- RFS works across a separate process or remote Agentlet, scopes access, and
  keeps graph mutations behind `SpaceQuery` / `CanvasCommand`, revision CAS,
  authorship, change review, and realtime broadcast;
- external-note discovery preserves the current local-folder workflow while
  requiring an explicit import rather than silently treating every file event
  as an authoritative mutation.

## 10. Filesystem-view design space — open

No option in this section is accepted by this proposal. Multiple options may
eventually coexist behind common domain contracts.

### 10.1 Logical file view

A candidate `SpaceFileView` could derive paths and bytes from both authoritative
stores:

```text
StructuredStore + BlobStore
          -> logical paths: space.json, nodes/*.md, artifacts/*
          -> stat / list / open / search
          -> built-in tools, ACP fs, and RFS adapters
```

This would centralize path mapping and visibility rules without promising an
OS mount. Its exact path vocabulary, search behavior, ACL model, generated
`space.json` semantics, and write surface are open.

### 10.2 Materialized agent workspace

A materializer could create a real directory on the machine where Codex,
Claude, or another CLI actually runs. The directory might be a read-only
snapshot, a cache plus writable scratch area, or an editable checkout. It could
be supplied as process `cwd`, an additional allowed workspace root, or an
environment-referenced path.

Open issues include lifetime, refresh timing for long-lived ACP sessions,
snapshot completeness, lazy artifact hydration, disk quotas, cleanup, remote
Agentlets, sandbox permissions, and whether a writable checkout is committed
at turn end or explicitly by the agent/user.

### 10.3 OS-mounted VFS

FUSE, macFUSE, WinFsp, or a platform-specific mount could expose database and
blob-backed content through ordinary syscalls. This gives native shell tools
the strongest illusion of a filesystem, but adds cross-platform drivers,
installation and signing, caching, locking, atomic rename, watcher behavior,
offline failure, and unmount recovery concerns. No mount technology is selected.

### 10.4 Protocol-only access

RFS, ACP host capabilities, or a future MCP adapter could remain the only
backend-independent agent access. This avoids projection consistency but does
not allow arbitrary native shell commands to treat Space content as local
files. The role of each protocol and whether ACP `/space` should be completed
or removed are open.

### 10.5 Write models

At least four models require separate evaluation:

1. protocol writes only; no writable filesystem surface;
2. read-only node/artifact projection plus a writable scratch/upload area;
3. editable checkout followed by manifest diff, validation, and CAS commit;
4. live bidirectional filesystem synchronization.

These have substantially different conflict, security, and multi-instance
semantics. This proposal does not choose among them.

## 11. Proposed constraints for evaluating file-access designs

These constraints are proposed review criteria, not decisions implied by the
two-backend split. Any accepted file-access design should address them
explicitly:

- **One authority.** A materialized directory or logical file view must not
  silently become a second source of truth beside StructuredStore/BlobStore.
- **Stable identity.** `nodeId` and `artifactId` are canonical; display labels
  and filenames may rename, collide, differ by Unicode normalization, or be
  case-insensitive on some platforms.
- **Revision safety.** Any imported edit needs an explicit baseline revision,
  compare-and-swap behavior, and a visible conflict result.
- **Complete cursors.** Projection freshness must cover every durable change
  represented in files, not only topology version changes.
- **Execution locality.** A Server-local directory is useless to an agent
  running on another Agentlet host unless it is transferred or materialized
  there.
- **Asynchronous and streaming I/O.** Postgres, Azure, remote execution, large
  media, and range reads must not be forced through synchronous filesystem
  assumptions.
- **Scoped visibility.** Built-in tools, external ACP agents, RFS clients,
  exports, memory workers, and humans do not necessarily see the same paths.
  ACLs cannot be inferred only from dot-prefixed directory names.
- **Path safety.** Traversal, symlinks, special files, archive extraction,
  maximum sizes, and cross-platform reserved names need one policy.
- **Multi-instance ownership.** A writable local projection for Postgres-backed
  deployments requires a single owner/lease or a defined distributed commit
  protocol.
- **Strong isolation where required.** `chmod` on a directory shared with an
  untrusted agent running as the same OS user prevents accidents but is not a
  security boundary; containers, different identities, or read-only mounts may
  be required.
- **Backend-independent export/import.** Long-term archive behavior must be
  generated from structured snapshots and their reachable blob references
  rather than globbing a backend's private directory or exporting every blob.
- **Domain ownership.** A file view may adapt Canvas and Blob ports, but it
  must not cause Agenetes to import `CanvasStore` or move L2 persistence into
  L1.

## 12. Migration plan

Phases 1–4 are implemented and specified below. Phase 5 onward keeps the
provisional character of the original outline: those entries record intended
order, not approved designs.

The current on-disk format remains readable throughout port extraction. A
database adapter must not require Disk consumers to simulate tables, and the
Disk adapter must not define semantics that Postgres cannot reproduce.

### 12.1 Phase 1 — the split — **merged**

Delivers the two-port composition with Disk adapters only. The work merged to
`main` in PR #416; §12.1.1 records the review corrections included before
merge.

- `BlobStore` as a genuine backend-neutral port (§7.1): connection → scope,
  stream-oriented, no permanent absolute path in the common contract, one
  reusable contract suite.
- Thirteen byte consumers migrated off filesystem paths, and the five
  artifact methods removed from `CanvasStore` — which is what actually makes
  good on "no single interface mixes both concerns".
- `StorageProfile`, `validateStorageProfile`, and the process-wide holder in
  `storage.ts`, so a bad profile fails at boot rather than on first upload.
- `preprocessing` was the only consumer genuinely needing a real filename;
  it uses `materialize()` with a `try/finally` lease release.

`StructuredStore` landed as a **lifecycle and backend-selection boundary
only**: its Phase-1 `SpaceHandle` was `CanvasStore`, so no SQLite or Postgres
adapter could be written against it. That limitation was stated rather than
papered over. Phase 2 establishes the narrow seam, Phase 3 migrates bounded
read consumers, and later write/node phases remove the legacy facade.

The agent filesystem surface (`fs-sandbox.ts`, ACP `/space`) and Space
export/import stay Disk-coupled. They are the open `SpaceFileView` question
of §10, not an oversight.

#### 12.1.1 Corrections from review — landed

A 2026-08-04 adversarial review of the branch found five defects. Each was a
property this proposal already claimed, contradicted by the code, so they were
phase-1 corrections rather than new scope, and they landed with Phase 1.

1. **`put()` is atomic.** It writes to a unique dot-prefixed sibling and
   renames into place, matching the invariant `io.ts` states for the rest of
   the module. Before, a replacement truncated the live key first, so a
   concurrent reader could be served a prefix — not theoretical, because
   content-derived snapshot names are deliberately reused — and a failed write
   left a partial blob at a live key that the port has no per-key delete to
   remove. In-flight temp files are excluded from `list()` and `hasMany()`.
2. **Lease semantics are pinned.** A shared `createBlobLease()` gives every
   adapter the same behavior: `path` throws a `BlobLeaseError` once
   `release()` has resolved, and release is idempotent. Disk keeps its no-op
   physical release, so nothing is copied, but a consumer can no longer come
   to depend on Disk keeping the file — which was the divergence that would
   have surfaced only on the first remote adapter. The port also documents the
   path as read-only.
3. **The handle-identity claim is bounded.** `space()` now promises that
   handles for one id denote the same Space, not that they are the same
   object, because the cache behind it is an LRU. Object identity moved out of
   the portable contract and into the Disk adapter's own test, which asserts
   both the caching and its limit.
4. **`deleteCanvas` sweeps blobs first**, so the structured record that names
   them still exists while they are removed (§8). The World-canvas refusal
   moved ahead of both stores: with blobs going first, a guard that lived only
   in `destroy()` would have cost the World its artifacts before it threw.
5. **The on-demand storage path no longer pretends to initialize.**
   `requiresExplicitInit()` records which backends may be built without an
   awaited `init()` — only ones with nothing to open — and the lazy accessor
   throws an actionable error for any other profile instead of handing out an
   unopened connection.

Two smaller items are recorded rather than fixed, because neither is a
correctness defect:

- `hasMany` is specified as a bounded batch existence check and implemented on
  Disk as a full directory enumeration plus a `stat` per candidate (§7.1).
- Name normalization is inconsistently strict: `dir/..` throws, while
  `../../x` is silently coerced to `x`. Both are "not a usable single path
  segment"; they should behave the same way.

Each correction carries a test that fails against the previous behavior. The
blob contract suite gained the atomicity, failed-write, and lease-lifetime
cases — deliberately at the points where two adapters could disagree, since a
suite that only asserts where they agree is what let the lease divergence
through in the first place.

The Phase 2 branch also exposed one failing test it did not cause,
`rfs.route.test.ts` → "returns an actionable error when World reconciliation
is required" (expected 409, received 200), which had been red on `main` since
2026-07-27. It turned out to be a stale expectation rather than a defect: the
test was written when a missing canonical Portal was answered with a 409, and
`ensureCanonicalPortals` subsequently made the router reconcile the Portal
first, so the asserted failure could no longer occur. A separate prerequisite
PR owns that correction and splits the scenario into the two contracts that
hold — reconcile-and-succeed for a live Space, 409 for a source that is not
one — leaving the route's error branch covered without folding the unrelated
test change into Phase 2.

### 12.2 Phase 2 — storage module shape and scoped repositories — **implemented**

Implemented on `feat/structured-space-repositories` as commits 2–7 of
§12.2.9, each leaving `typecheck` / `test` / `lint` green. At initial landing,
the suite went from 602 to 657 passing tests. Corrections are recorded in
place rather than left as historical mistakes: the CAS race ordering in
§12.2.5 and a later adversarial review's interface-segregation and retained-
Workspace-handle fixes in §§12.2.4–12.2.6.

Phase 2 is a containment and ownership refactor. Its primary acceptance
criterion is that `apps/server/src/modules/storage/` has the target
ports/backends/compatibility hierarchy and dependency direction. It exposes
the first narrow structured repositories through `StructuredStore`, and it
migrates exactly one application route onto them; later hardening also uses
`SpaceRepository` internally to reject blob puts for missing Spaces. Other
structured-storage application consumers stay on the existing Disk facade.

That boundary is practical rather than cosmetic: the legacy `getCanvasStore()`
surface has many consumers, and moving them is an async rewrite that has
nothing to do with module shape. Phase 2 can make the new side correct and
testable without forcing that rewrite.

The post-implementation adversarial pass hardened the existing Disk behavior
without widening the portable contract. Disk reads now distinguish ENOENT
from corrupt or unreadable durable state; JSONL readers tolerate only a final
unterminated crash fragment and validate event/delta row shapes; cache entries
and retained handles are Workspace-qualified; and Space deletion has a
process-local admission gate plus an active-Workspace lease spanning blob and
structured cleanup. The executor's multi-file rollback remains a
Disk/application implementation detail, not a new generic transaction API.
External-note watcher recovery is owned by a separate watcher-recovery PR and
is not part of Phase 2. Coordination across multiple server processes and a
portable cross-backend `SpaceCommit` are still later-phase work.

The one exception exists because a repository contract with no callers is a
guess. Phase 2 freezes `SpaceRepository` and the four log-family repositories
and writes reusable contract suites against them; if the first real adoption
happens two phases later, that is when the shapes get tested against reality,
and that is when they will need to change — invalidating the suites written
now. One bounded slice through a real route costs little and converts the
accepted shape from a proposal into something a caller has exercised. §12.2.8
names the slice.

| Axis                                        | Phase 2                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Canonical module layout                     | `ports/`, `backends/disk/`, and `compatibility/`                       |
| Space record (`space.json`)                 | Async, version-CAS `SpaceRepository` behind the facade                 |
| Canvas logs (4 families)                    | Four narrow async repositories with family-specific concurrency terms  |
| Node sidecars (`nodes/*.md`)                | Transitional `LegacyNodeStore` with synchronous single-node primitives |
| Existing application storage API            | Preserved by the compatibility facade                                  |
| Catalogue, World, create/delete, and title  | Existing Disk behavior retained; portable lifecycle remains open       |
| Non-storage helpers currently in the folder | Moved to their actual owners                                           |
| Application consumer migration              | One read-only route (§12.2.8); no other `await` or signature cascade   |

After this phase a SQLite application profile is still blocked by three
separate facts: node mutation primitives are synchronous and Disk-shaped,
structured-storage application consumers other than the one migrated route
still use the compatibility facade, and several product capabilities require
a physical Space directory. Phase 2 claims the target module seam, not backend
neutrality for the running application.

#### 12.2.1 Target hierarchy and dependency direction

The canonical Phase-2 tree is:

```text
storage/
├── index.ts                         # public barrel; no implementation logic
├── profile.ts                       # backend selection and validation
├── storage.ts                       # composition root and process holder
├── canvas-store.ts                  # temporary forwarding shim only
├── canvas-dirs.ts                   # temporary forwarding shim only
├── paths.ts                         # temporary forwarding shim only
├── ports/
│   ├── common.ts
│   ├── blob.ts
│   ├── structured.ts
│   └── contracts/
│       ├── blob-store.contract.ts
│       ├── structured-store.contract.ts
│       ├── space-repository.contract.ts
│       └── canvas-log-repository.contract.ts
├── backends/
│   └── disk/
│       ├── blob-store.ts
│       ├── structured-store.ts
│       ├── space-repository.ts
│       ├── canvas-log-repository.ts
│       ├── legacy-node-store.ts
│       └── legacy/
│           ├── canvas-store.ts
│           └── canvas-store-cache.ts
└── compatibility/
    └── canvas.ts                    # current list/create/delete/get facade
```

Tests live with the layer they exercise: reusable suites under
`ports/contracts/`, adapter tests beside `backends/disk/`, and
facade-parity tests beside `compatibility/`.

The dependency rules are part of the deliverable:

1. `ports/` imports backend-neutral Canvas persistence DTOs and shared
   schemas, never a backend or `CanvasStore`.
2. `backends/disk/` implements the ports and may depend on generic
   utilities plus the physical Workspace layout; the dependency never points
   back from a port.
3. `compatibility/` may delegate to the Disk legacy implementation.
   Neither ports nor adapters import the compatibility layer.
4. `storage.ts` is the only backend-selection composition root, and
   `index.ts` is exports only.
5. Application code does not add imports from `backends/`. Existing
   Disk-coupled imports use the stable public facade or the fixed forwarding
   shims described below.

#### 12.2.2 Move non-storage ownership out

The target folder should contain storage ports, composition, adapters, and the
temporary storage compatibility facade—not every helper that happens to touch
a file. Phase 2 makes these mechanical ownership moves:

| Current storage-owned file(s)                                                                                | Canonical owner after Phase 2         | Reason                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Persistence DTOs declared in `canvas-store.ts` (`CanvasFile`, `NodeContent`, `CanvasEvent`, `DeltaLogEntry`) | `modules/canvas/persistence-types.ts` | Ports must not import types from a Disk implementation.                                     |
| `write-coordinator.ts` and its tests                                                                         | `modules/canvas/write-coordinator.ts` | It coordinates Canvas mutations and revision policy; it is not a backend adapter.           |
| `frontmatter.ts` and its tests                                                                               | `utils/markdown-frontmatter.ts`       | It is a generic Markdown codec used by storage, prompts, watchers, and file tools.          |
| `io.ts`                                                                                                      | `utils/fs.ts`                         | Atomic file IO and identifier/path validation are host utilities shared by several domains. |
| `paths.ts`, `canvas-dirs.ts`, `naming.ts`, `name-index.ts`, `space-dir-handles.ts`, and `world-canvas.ts`    | `modules/workspace/disk/`             | They describe and arbitrate the physical Workspace layout, including non-storage domains.   |
| `migrate-*.ts`, migration tests, and `legacy/`                                                               | `modules/workspace/migrations/`       | They are ordered boot-time Workspace upgrades, not live storage contracts.                  |

The moves preserve symbol names and runtime logic. Tests move with their
subjects. Public type exports continue through `storage/index.ts` while
callers transition to the Canvas-owned DTO module naturally.

Only three high-fanout root files remain temporarily as one-line deprecated
forwarders: `storage/canvas-store.ts`,
`storage/canvas-dirs.ts`, and `storage/paths.ts`. The first preserves
the legacy class import; the other two preserve physical-Disk capability
imports. Lower-fanout imports are updated directly. No forwarding file may
contain logic, and no new call site may import one.

> **Superseded in part by §12.5.** The row moving `paths.ts` and
> `canvas-dirs.ts` to `modules/workspace/disk/` is justified above by those
> files serving "non-storage domains". That reason is inverted: a storage
> detail with consumers outside `storage/` is describing a leak, not earning a
> home outside the boundary. The move was right for the files that describe
> the Workspace _as a place_ and wrong for the files that describe _how the
> Disk backend stores Spaces_. Phase 4.5 separates the two.

#### 12.2.3 Compatibility boundary and blast-radius budget

In Phase 2, `storage/compatibility/canvas.ts` owns the legacy
application-facing surface: the synchronous `getCanvasStore`, cache reset,
and Space list/summary/create operations; async Space deletion; the legacy
`CanvasStore` class; and their existing result types. Phase 3 later removes
`listCanvasSummaries` after its caller moves to the catalogue, while retaining
`listCanvases` for create-time default-title generation (§12.3.3).
`storage/index.ts` re-exports that surface alongside the new ports and
composition API, so existing imports and behavior remain valid.

Phase 2 explicitly does **not**:

- add `await` to sync, the executor, spatial queries, search, neighbourhood,
  World resolution, memory, RFS, or preprocessing — or to any Canvas route
  other than the single read-only handler in §12.2.8;
- replace direct physical-file access in Disk-only product capabilities;
- move Space catalogue, World bootstrap, create/delete, or title mutation
  onto a new portable contract;
- add title-rename recovery markers or change the on-disk Workspace format;
- make `getCanvasStore` private or remove it from application code.

The new and old paths do not create two in-memory authorities.
`DiskStructuredStore.space(id)` and the compatibility facade resolve the
same cached legacy Disk object. A parity integration test proves that a write
through either view is immediately observed through the other. That identity
holds for as long as the underlying cache entry lives, which is a bounded LRU
(§12.1.1 item 3) — so it is a statement about consistency between the two
views, not a promise that a Space has one long-lived instance.

The compatibility facade does remain a second **mutation entry point**. Until
its writers migrate, repository CAS/log guarantees apply to calls made through
the repository; they are not yet a global single-write-authority guarantee for
the application. That is another explicit reason no non-Disk profile is
selectable after Phase 2.

This gap has to survive contact with a green test run. The contract suites
assert linearizable appends and single-winner CAS, and those assertions are
true of the adapter and false of the running system, because a facade writer
can interleave without passing through either. The suites are therefore named
and documented as **adapter-local** guarantees. A future phase may promote
them to system guarantees once the last legacy mutation entry point is gone;
until then, a passing suite must not be read as evidence that the application
has one write authority.

Outside the canonical storage tree and the ownership destinations in
§12.2.2, production-source changes are import-only. There are no shared
package, web-client, protocol, HTTP, or persisted-format changes. If an
implementation step requires a consumer signature or behavior change, it is
deferred to a later phase rather than silently expanding Phase 2.

#### 12.2.4 `StructuredStore` and `SpaceHandle` become composites

> **Renamed in Phase 4.** The composite structure below is what landed and
> still holds; the member names are Phase-2 spelling. `record` became the
> handle's own `read()`, `deltas` and `intents` are gone, and the per-part
> interfaces dropped their `Canvas`/`Repository` affixes. §12.4.2 records the
> reasoning, §12.4.3–4 the later corrections, and §7.2 the current shape.

```ts
export interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  space(canvasId: string): SpaceHandle;
}

export interface SpaceHandle {
  readonly canvasId: string;
  readonly record: SpaceRepository;
  readonly events: CanvasEventRepository;
  readonly deltas: CanvasDeltaRepository;
  readonly changes: CanvasChangeRepository;
  readonly intents: CanvasIntentRepository;
  /** Synchronous transitional surface; replaced in a later phase. */
  readonly nodes: LegacyNodeStore;
}
```

`LegacyNodeStore` contains only node-sidecar operations still used after the
dead-surface deletion: single/batch/stream reads, write/delete, filename
lookup, duplicate detection, read revalidation, and write-suppression checks.
It cannot be widened with Space-record, log, title, or lifecycle methods. A
dedicated Disk wrapper delegates those calls to the legacy object, so
`handle.nodes` cannot be cast accidentally into the old all-purpose facade.

`DiskStructuredStore.space(id)` builds the composite handle on demand over
`getCanvasStore(id)`; it does **not** add a cache of its own. The record,
log-family, and node adapters therefore share whatever legacy Disk object the
existing cache currently holds for that id, which is the same object the
compatibility facade resolves.

Keeping one cache in the module is deliberate. A second cache would have to be
invalidated in lockstep with the first, and `resetStorageCache()` — called on
workspace switch — clears only the legacy map, so a separately cached
composite would survive a workspace change still wrapping the previous
workspace's object. The composite is a few field assignments over an object
the existing cache already returns, so there is nothing to gain by caching it
twice.

Each log-family member is a frozen runtime facade containing only that
family's methods. A closure-private Disk coordinator holds the legacy object;
there is no public `logs` bag and no castable `store` property. The Disk record
adapter and log coordinator capture the resolved Workspace path when the
handle is built and check it before every operation, before resolving a record
or log path. A retained handle therefore rejects after Workspace activation
instead of inspecting, reading, or writing a same-id Space in the newly active
Workspace.

This also means `space(id)` inherits the cache's real identity behavior rather
than a stronger claimed one: two calls return handles that agree, because they
delegate to the same lookup, but the underlying instance can be evicted and
rebuilt (§12.1.1 item 3). Anything that must survive eviction is durable state
and belongs in a repository, not in a field on the legacy object.

Backend-neutral persistence DTOs come from
`modules/canvas/persistence-types.ts`. In particular,
`ports/structured.ts` no longer imports `CanvasStore` or any file under
`backends/`.

#### 12.2.5 `SpaceRepository` — versioned record with atomic CAS

> **Superseded in Phase 4.** `compareAndSwap` never acquired a production
> caller: `OrderedSpaceWriter.apply` with an empty node batch is the same
> version-checked replacement, so the two were one operation spelled twice.
> Phase 4 removed the method and this suite, kept `read()` as
> `SpaceRecordRepository`, and moved the single-winner and record-validation
> assertions to the ordered-writer contract. §12.4.1 records the reasoning.
> The shape below is retained because the guarantee it describes is now the
> writer's.

```ts
export interface SpaceRepository {
  read(): Promise<CanvasFile | null>;
  compareAndSwap(
    expectedVersion: number,
    next: CanvasFile,
  ): Promise<SpaceWriteResult>;
}

export type SpaceWriteResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'version-conflict'; actualVersion: number };
```

The repository rejects a mismatched `canvasId` and a `next.version` other than
`expectedVersion + 1`. Phase 2 deliberately scopes this repository to the
versioned structural record: `canvasId`, `title`, and `createdAt` must
match the current record. Create/delete, World rules, and title/directory
rename are aggregate lifecycle concerns and remain on the compatibility path
until a portable lifecycle write surface is designed and implemented.

The version comparison and record replacement are one adapter operation. Two
concurrent repository calls with the same expected version cannot both
succeed. The Disk adapter performs its version check and synchronous legacy
write in one uninterrupted JavaScript turn; this guarantee is for the
supported single-Server Disk topology. A future SQLite/Postgres adapter must
use a transaction or conditional update across all of its connections.

That guarantee currently rests on the _absence of an `await`_ inside an
`async` method, which is not a mechanism. Someone swapping a sync call for
`fs/promises` breaks it silently. Phase 2 therefore makes the invariant
enforceable rather than aspirational:

- the concurrency case in the contract suite issues its two writers **from one
  tick against a shared baseline**, with no `await` between them, because that
  is the ordering that actually discriminates. Separating them with a yield —
  which an earlier draft of this plan called for — makes the second writer read
  the already-updated record, so it degenerates into a sequential
  stale-baseline test and passes even for an adapter whose critical section
  spans an `await`. This was verified by injecting that `await` into the Disk
  adapter: the same-tick case reports two winners and a lost update, the
  yielded case stays green. Both orderings are in the suite, but only the
  same-tick one is the race; the yielded one is asserted separately as the
  ordinary conflict path;
- the Disk adapter's critical section is a named private method with a comment
  stating that it must not `await`, so the requirement is visible at the point
  where it would be violated.

If a later adapter cannot honor the invariant structurally, the answer is an
explicit lock, not a comment.

Environmental IO failures reject rather than masquerade as `not-found` or a
business result. A Disk `read()` may retain the existing Finder-rename
self-heal, but that is adapter behavior—not a promise other backends reproduce.

No existing application writer is switched to `compareAndSwap` in Phase 2.
The contract is correct for later adoption without changing the current PUT,
executor, or title flow as collateral work. That deferral is exactly what
§12.4.1 later had to undo: the adoption that arrived in Phase 4 wanted the
batch writer, not this narrower spelling of it.

#### 12.2.6 Canvas log-family repositories — scoped contracts

```ts
export interface CanvasEventRepository {
  append(events: readonly NewCanvasEvent[]): Promise<void>;
  read(limit?: number): Promise<CanvasEvent[]>;
}

export interface CanvasDeltaRepository {
  append(entry: DeltaLogEntry): Promise<void>;
  readSince(fromVersion: number): Promise<DeltaLogEntry[]>;
}

export interface CanvasChangeRepository {
  read(threadId: string): Promise<CanvasChangeRecord[]>;
  append(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]>;
  remove(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null>;
}

export interface CanvasIntentRepository {
  read(): Promise<IntentEpisode[]>;
  upsert(episode: IntentEpisode): Promise<void>;
}
```

`NewCanvasEvent` is the current `{ payload: RecentAction; ts?: number }`
input. Each interface covers one Canvas-owned log family and is exposed
directly on `SpaceHandle`; there is no ten-method `CanvasLogRepository` or
public `logs` aggregation bag. This keeps consumers from depending on
unrelated persistence capabilities and makes the boundary true at runtime as
well as in TypeScript.

The contract includes their synchronization semantics rather than preserving
Disk's accidental await-free behavior:

- one `events.append` batch is appended contiguously and reads preserve order;
- delta versions are unique and strictly increasing per Space; a duplicate or
  older `deltas.append` rejects, and `deltas.readSince` returns version order;
- `changes.append` and `changes.remove` are linearizable for each Space/thread
  pair, so concurrent agents cannot lose one another's records;
- `changes.read` and the value returned by `changes.append` are coalesced by
  canvas entity;

The Disk adapter enforces these guarantees with uninterrupted synchronous
legacy operations before returning each promise, under the same
non-`await` constraint and the same enforcement as §12.2.5. This is
sufficient for the supported single-Server Disk topology; a future Postgres
adapter must uphold the same behavior across connections and replicas. The
port does not expose a generic transaction callback.

Phase 2 does not redirect any log **writer**, or the memory analyzer. It
redirects one reader — the events route of §12.2.8 — so `events.read` has a
real caller and the other methods do not. The write-side contracts become
available and testable without changing behavior, and become authoritative
only after the legacy mutation entry points are migrated.

#### 12.2.7 Legacy cleanup and the node invariant

Before the legacy class moves under `backends/disk/legacy/`, Phase 2
deletes the eight methods with no real call sites across `apps/`,
`packages/`, or `external/`: `readChat`, `writeChat`,
`loadLatestChat`, `listChatThreads`, `listNodes`, `readVersion`,
`checkNodeRename`, and `appendEvent`.

`invalidateNodeIndex` and `writeChanges` become private because only the
class uses them. `readIntents` stays available to the Disk log adapter.
Deleting the obsolete chat methods also deletes the now-unused `chatPath()`;
`chatDir()` remains because other domains own live files there. This cleanup
has no consumer behavior change.

The write coordinator, moved to `modules/canvas/` by §12.2.2, retains
its existing atomicity argument: `readNode` / `writeNode` are
synchronous, so the read → revision check → apply → write section is
`await`-free inside the lock. `LegacyNodeStore` preserves that property,
and Phase 2 does not change the mutex's non-reentrant contract.

Disk keeps node tombstones in a Workspace/Space-qualified process registry so
they survive LRU eviction. Structural writes clear a tombstone only for a
real absent-to-present transition or an executor-authoritative insert; failed
multi-file commits restore the exact prior tombstone state. That is a
cross-surface Disk invariant, not a portable `SpaceRepository` contract, and
phase 2 covers it in Disk integration tests. A later mutation phase decides
how a durable Node tombstone and a versioned Space commit interact across
repositories and processes.

The rare tombstone suppression path also consults current structural presence
inside the concrete Disk store. That direct read remains adapter-private in
phase 2 and is another reason a mixed SQLite-record/Disk-node profile is not
selectable. It must not leak onto `LegacyNodeStore` as a general record API;
the async node phase replaces it only after re-establishing the write
invariant.

#### 12.2.8 The one consumer slice

The slice is `GET /api/canvas/:canvasId/events` in `canvas.route.ts`. Its
single `store.readEvents(limit)` call becomes
`await getStructuredStore().space(canvasId).events.read(limit)`.

It is chosen for being the cheapest migration that still exercises the seam
end to end:

- the handler is already `async`, so there is no signature cascade and no new
  `await` anywhere else;
- it is a pure read with no write coordination, no CAS interaction, and no
  realtime broadcast;
- there is exactly one call site in production code;
- the response shape is unchanged, so no shared package, protocol, or web
  change follows.

Before Phase 2, this handler had no route test. The migration commit added one
that asserts the payload before and after the data-source swap, so the slice
exercises the repository seam rather than merely changing an untested
handler.

The handler resolves one `SpaceHandle` and checks existence with
`handle.record.read()` before using `handle.events.read(limit)`. The strict
record read is deliberate: malformed or unreadable durable state must surface
as an error rather than being collapsed into the compatibility reader's
missing-Space fallback. This is still one bounded read-only route and does not
add catalogue or lifecycle operations to the port.

What the slice proves: that a repository read returns what the legacy path
returned for a real request, that the composite handle resolves for a real
`canvasId`, and that `events.read`' limit and ordering semantics survive
contact with a caller before they are frozen. What it does not prove: anything
about writes, CAS, or single write authority — those stay adapter-local
(§12.2.3).

Two nearby routes were deliberately excluded from Phase 2. `GET
/:canvasId/threads/:threadId/changes` was deferred and is now migrated in
Phase 3 (§12.3.3). The `changes/:changeId/revert` route reads and then mutates,
so it remains on the compatibility path until a write phase.

#### 12.2.9 Testing and sequence

The existing Blob suite moves unchanged under `ports/contracts/`. Three
structured suites define the Phase-2 seam. They are named and documented as
adapter-local guarantees, for the reason given in §12.2.3:

- `structured-store.contract.ts`: lifecycle/health behavior, agreement
  between two handles for the same id, different-id isolation, and validated
  ids;
- `space-repository.contract.ts`: missing read, successful CAS, mismatched
  id, invalid next version, immutable identity/title fields, not-found and
  version-conflict results, and two concurrent writers with one winner — with
  the two writers issued from one tick against a shared baseline, which is the
  ordering that detects a critical section spanning an `await` (§12.2.5). This
  suite was retired in §12.4.1 and these cases now live in
  `ordered-space-writer.contract.ts`;
- `canvas-log-repository.contract.ts`: the four narrow repository contracts —
  event order/tail/empty append, delta filtering and duplicate rejection,
  change coalescing and concurrent append/remove behavior, and intent
  read/insert/update/concurrent upsert.

Disk integration tests additionally prove:

- compatibility and composite views observe each other's writes;
- a structural CAS still lifts the legacy in-memory node tombstone;
- `handle.nodes` exposes no record, log, title, or lifecycle operation;
- the events route returns the same payload through the repository as it did
  through the facade, via a route test written for the slice (§12.2.8);
- existing Disk facade tests pass without expectation changes.

A lightweight architecture test enforces the canonical tree and dependency
rules from §12.2.1. It rejects port imports from adapters/compatibility, adapter
imports from compatibility, imports from `storage/backends/` outside the
storage module, logic in the three root forwarding shims, and any new importer
of those shims. This is a shape guard, not a false claim that existing
consumers are backend-neutral.

Commits, each leaving all three commands green:

```sh
pnpm --filter @huabu/server typecheck
pnpm --filter @huabu/server test
pnpm --filter @huabu/server lint
```

Implementation starts from a green baseline, and does so literally: at the
time this phase was made ready, `typecheck`, `test` (602 passing), and `lint`
(no errors) all pass on the branch. The inherited RFS failure is resolved by
the separate prerequisite PR described in §12.1.1, so Phase 2 starts from a
green baseline without owning that unrelated test change. A red baseline must
not be normalized as Phase 2 debt — if one appears, it is fixed or explicitly
rebaselined before the next commit.

1. `docs:` this plan.
2. `refactor(server):` move Canvas DTOs, the write coordinator, generic
   codecs/IO, Workspace layout, and boot migrations to their owners; change
   imports only and install the two high-fanout Workspace shims.
3. `refactor(server):` move Disk adapters and the legacy store/cache into
   `backends/disk/`; move current list/create/delete/get behavior into
   `compatibility/`; leave the legacy class shim.
4. `refactor(server):` delete 8 dead legacy methods, privatize 2, and
   delete `chatPath()`.
5. `feat(server):` add the composite handle, narrow node wrapper,
   record/log adapters, and reusable contract suites.
6. `test(server):` add compatibility-parity and module-boundary guards.
7. `refactor(server):` add a route test for `GET /:canvasId/events`, then
   migrate it to `events.read` (§12.2.8).

Commit 7 is the only consumer change in Phase 2, and it is last so that
reverting it leaves the module shape intact.

### 12.3 Phase 3 — catalogue and bounded read adoption — **implemented**

Phase 3 adds the Workspace-scoped read seam needed by consumers that do not
start with a known Space id, documents and accepts future lifecycle outcomes,
and moves four bounded read slices. It does not add a lifecycle writer,
migrate nodes or log writers, change a schema, or add a backend/profile.

#### 12.3.1 Read-only catalogue contract

> **Merged in Phase 4.** These two reads now sit on the one `SpaceRepository`
> returned by `StructuredStore.spaces()`, alongside create/delete/rename. The
> read/write split described here tracked the migration phases rather than a
> domain boundary, and it cost a duplicated World rule. §12.4.1 records the
> reasoning; the semantics below are unchanged.

`StructuredStore.catalog()` returned a fresh read-only catalogue:

```ts
interface SpaceCatalogRepository {
  list(): Promise<CanvasSummary[]>;
  worldId(): Promise<string>;
}
```

The handle records the active Workspace path at creation and rejects while a
different Workspace is active. Each method observes a fresh scan rather than
a cached snapshot. `list()` returns ordinary Spaces only, promises no order, and keeps
the Disk scanner's existing summary coercion and Finder-side rename behavior
without writing a title back. Missing or corrupt entries are handled exactly
as the Disk scan handles them; a corrupt World may therefore make the scan
reject. `worldId()` returns the one hidden World's stable generated id and
rejects a missing or malformed established World. Duplicate ids are invalid
Workspace state; portable winner/error semantics remain intentionally
unspecified until repair/import behavior is designed.

The Disk adapter implements this contract through the existing Workspace
scanner and World resolver. The reusable catalogue contract covers unordered
ordinary listing, the empty catalogue, stable World identity, and World
exclusion. Disk-focused tests additionally cover refresh behavior,
missing/corrupt state, coercion, Finder rename display, and stale Workspace
handles. Callers own presentation ordering; the HTTP list route sorts a copy
by descending `updatedAt`.

#### 12.3.2 Accepted lifecycle semantics, deferred write API

Phase 3 documents and accepts these portable outcomes without exposing
premature write methods:

- A Workspace has one stable hidden World. Boot preparation creates it once;
  ordinary create, rename, title mutation, and delete cannot target it. A
  missing or malformed established World is an integrity error, not a request
  to generate a replacement identity.
- A future ordinary-Space create atomically publishes catalogue membership and
  an empty version-0 Space record. An id collision has one winner. Disk title
  collisions remain adapter-specific, and create must return the effective
  stored title rather than pretending the requested filesystem name won.
- A future delete returns an explicit `deleted`, `not-found`, or
  `world-forbidden` outcome; storage/I/O failures reject. The existing
  blob-first deletion saga remains until the cross-store outbox design is
  accepted.
- A title change is not a catalogue-only rename. The future `SpaceCommit`
  applies topology and title under `expectedVersion` and advances the Space
  version once. World title changes are forbidden.

These are design constraints for phase 4, not claims that compatibility
create/delete/rename are backend-neutral today.

Phase 4 subsequently implemented these lifecycle outcomes and chose the
minimal `OrderedSpaceWriter` instead of the provisional `SpaceCommit` name and
atomicity sketch; §12.4 records the accepted boundary.

#### 12.3.3 Migrated read slices

The implementation moves these consumers without changing their wire shapes:

- `GET /api/canvas` calls `catalog().list()` and sorts the returned copy by
  descending `updatedAt`.
- Workspace state calls `catalog().worldId()` only when a Workspace is
  configured. Integrity errors continue through the route's existing error
  mapping.
- `GET /api/canvas/:canvasId/threads/:threadId/changes` resolves one
  `SpaceHandle`, strictly reads the Space record first, then reads change
  records. Delete/revert remains on the compatibility mutation path.
- The memory analyzer resolves one `SpaceHandle`, reads the Space record
  first, and then reads at most 100 action events and all intent episodes from
  repositories. After the missing record read, a missing Space is a successful
  skipped pass: memory state, chat, action-event, and intent sources are not
  read, no model is called, and `markAnalyzed` is not advanced. Corruption and
  repository failures still reject, leave the pass unmarked, and are eligible
  again on the next natural trigger.

The memory event formatter intentionally preserves its pre-existing output in
this storage-only phase. Persisted `RecentAction` payloads currently render a
blank event label because the formatter reads legacy fields; follow-up issue
[#432](https://github.com/hai-team/Sediment/issues/432) owns that behavioral
fix and its regression tests.

Phase 3 leaves compatibility writers, `LegacyNodeStore`, create/delete/rename,
import/export, RFS, external watchers, storage profiles, schemas, and all
non-Disk adapters unchanged. Physical chat digest, memory body/state, and
user-Skill access also remain explicit Disk capabilities; only the analyzer's
authoritative Space/event/intent inputs move here.

The stage sequence is independently committed as catalogue contract/adapter,
route consumers, memory consumers, and documentation. The full Server suite,
typecheck, lint, formatting, catalogue contracts, route regressions, and
memory skip/failure tests form its verification boundary.

### 12.4 Phase 4 — portable write seam — **implemented**

Phase 4 fixes the minimum backend-neutral write interfaces while preserving
Phase-3 product behavior. It does not use SQL's possible transaction strength
as a reason to build a filesystem transaction manager.

The accepted additions are:

- `SpaceLifecycleRepository.create/beginDelete/rename`, with an authoritative
  version-0 create record, explicit lifecycle outcomes, and an exclusive
  deletion session. Composition holds that session across blob cleanup before
  calling `finish()` or `abort()`; the structured repository never calls
  arbitrary blob I/O from inside a backend transaction.
- `NodeRepository.read/readMany/put/delete`, fully async and expressed in
  complete domain records plus opaque revision tokens. Filenames and paths do
  not identify records in the portable API. Logical label allocation and
  strict label-conflict are portable domain behavior. Only
  `duplicate-node`—an integrity outcome for conflicting physical
  representations—is optional for adapters such as SQL that cannot produce it.
- The existing version-CAS `SpaceRepository`, unchanged.
- `OrderedSpaceWriter.apply`, the narrow batch required by the existing Canvas
  executor and legacy structural PUT. It preserves node puts/deletes → Space
  record → optional delta order and accepts the observed Space version. It is
  deliberately not named commit or transaction; explicit title rename is a
  separate lifecycle operation that precedes this batch.

For the node → record → delta batch, a normal in-process rejection must
restore prestate before returning. Disk continues to use its pre-existing
before-image rollback for caught executor failures; a SQL adapter may use a
native transaction. Explicit title rename remains the preceding ordered,
best-effort boundary and is not part of that restoration guarantee. The port
does **not** guarantee process-crash or power-loss recovery, a determinate
result after an unknown remote outcome, multi-process serialization,
idempotent retry, a durable outbox, or SSE publication. Phase 4 adds no
journal, commit marker, startup recovery, durable tombstone, or new persisted
format.

The Canvas create/delete and structural PUT routes, standalone node writes,
executor and revert batches, preprocessing persistence, and event/change/
intent mutations now enter these repositories. The application promise-chain
mutex remains held across async node read/CAS/put; executor batches retain the
same version increments, delta row, no-op behavior, and publish-after-persist
timing. Shared API schemas, HTTP statuses/SSE shapes, and the web client are
unchanged; conflict responses now carry the existing logical label/title
rather than a Disk filename/directory locator.

The delete route obtains a lifecycle deletion session before the blob sweep.
That session fences record, node, ordered-writer, log, Task, create/rename, and
composed blob-put mutations until structured deletion finishes or cleanup
aborts; reads remain available. This is a backend-instance concurrency
requirement, not a distributed transaction or a promise that two server
processes coordinate. Direct-filesystem ZIP, RFS, external-note claim,
bootstrap, and migration paths remain outside it.

Reusable lifecycle, node, and ordered-writer suites assert only this minimum.
The ordered-writer failure fixture requires the node, record, and delta
prestate after a rejected in-process batch; title rename is covered separately
as an ordered best-effort boundary. Remaining import/export, RFS,
external-note observation/claim, hydration, bootstrap/migration, and other
physical capabilities still read or mutate Disk directly, so SQLite and
Postgres profiles remain rejected.

#### 12.4.1 Post-review trim — landed

A 2026-08-12 review of the branch asked what the structured contract looks
like at a glance and whether it shows signs of overdesign. It did, in ways
that were cheap to correct before the surface acquired more callers. These
changes landed with Phase 4 rather than as follow-up work, because every one
of them removes something Phase 4 would otherwise have been the phase to
justify.

1. **`SpaceRepository.compareAndSwap` removed.** It had no production caller,
   and a record-only `OrderedSpaceWriter.apply` is the identical operation —
   same version precondition, same identity-field refusal, same result type,
   which the `SpaceMutationResult = SpaceWriteResult` alias had been quietly
   admitting. The per-Space record port is now read-only and named
   `SpaceRecordRepository`, matching its `record` field. Its 230-line contract
   suite is gone; the single-winner race and the next-record validation cases
   it owned moved into the ordered-writer suite, which is where the
   application actually depends on them. §12.2's own rule — "a repository
   contract with no callers is a guess" — is what this applies.
2. **`NodeRepository.readMany` removed.** Also uncalled, and its only
   implementation read and parsed _every_ node in the Space regardless of how
   many ids were requested, so the first real caller would have inherited a
   full-Space scan per batch. A future batch read should be designed against a
   caller that wants one.
3. **`catalog()` and `lifecycle()` merged into `spaces()`.** They were the
   same kind of object — namespace-scoped, stateless, one fresh
   Workspace-bound instance per call — split along a read/write line that
   tracked Phase 3 and Phase 4 rather than the domain. The split forced the
   World rule to be resolved in two places, left `create` reading membership
   it could not name through the port, and made composition stitch two calls
   for one logical create. Per-Space `space(id)` is untouched: that boundary
   is real, since `create` cannot be scoped to a Space that does not exist.
4. **`SpaceDeleteResult` removed from the port.** No repository returned it —
   it was the composition-level result of `deleteSpace()`, hand-written as the
   union of the two port results it is assembled from. It now lives in
   `storage.ts` as `SpaceDeleteOutcome`, derived rather than restated.
5. **`StructuredBackendKind` narrowed to `'disk'`.** An adapter's self-reported
   kind now names only kinds that exist. The wider vocabulary a profile may
   _request_ moved to `profile.ts` as `RequestedStructuredKind`, which is what
   preserves the actionable "not implemented yet" error for a configured
   `sqlite` or `postgres`. `BlobBackendKind` still carries `azure` on the same
   footing and was left alone as Phase-1 surface.

Not changed, deliberately: `authoritativeInsert` and the `write-suppressed`
put outcome remain in the portable shapes. Both exist for Disk's in-memory
deletion fence, and neither has a portable meaning a SQL adapter would
produce. They are now documented as adapter-shaped, the way `duplicate-node`
already was, rather than renamed or pushed behind the adapter — the honest
resolution needs a second adapter to say what the shared abstraction is, and
inventing one now would be the same speculative move this trim is undoing.

The review also asked composition to move default-title allocation
("Untitled", "Untitled (1)", …) into `create`, which would have removed the
serialization point in `createSpace`. That was declined: the suffix rule is
product naming, not storage, and pushing it into the port would make every
adapter reimplement it. The two-call sequence stays, now against one
repository instance so a Workspace switch between the read and the create is
rejected rather than silently retargeted.

#### 12.4.2 Member vocabulary and shape — landed

The same review continued into what the handle's members _are_. The trim in
§12.4.1 removed surface; this settles how what remains is named and grouped,
before more callers make either expensive to change. Behavior is unchanged:
every edit is a rename, a regrouping, or a member becoming a method.

1. **The record flattened into the handle.** `handle.record.read()` and
   `handle.write(...)` put reading and writing the same record at two
   different levels — the defect §12.4.1 removed between `record` and a
   `writer` member, relocated. A Space _is_ its versioned record, so the pair
   belongs on the Space: `handle.read()` / `handle.write(...)`.
   `SpaceRecordRepository` is gone. The Disk reader keeps the captured
   Workspace path it had as a class, so a handle retained across a Workspace
   switch still rejects.
2. **`history` groups the past, and only the past.** `events` and `intents`
   are what happened and what was concluded from it, so they nest.
   Change-review records and Tasks stay flat although Disk files all four
   under `.history/`: pending changes drain as the user accepts or rejects,
   and a Run carries live `pending`/`running` status the launcher mutates in
   flight. `.history/` is a catch-all directory — `chat_v2/` sits there only
   because it is the Agenetes `storage.root` — so grouping port members by it
   would import a Disk layout into the backend-neutral contract.
3. **One verb, one meaning** (§7.2). `changes.remove` → `delete`,
   `intents.upsert` → `put`, `tasks.insertTask` → `tasks.create`. `create` and
   `put` stay distinct because they differ on a duplicate: `create` rejects,
   `put` replaces.
4. **Runs nest inside the Task ledger.** `insertTask`/`insertRun` stuttered
   because two record kinds shared one member. A Run executes a Task, so
   `tasks.runs.create/update` reads as the domain does. `read()` stays at the
   ledger — one file, and both `run-launcher` and the interactive-view binding
   need Tasks and Runs from one snapshot. `runs` deliberately has no `read`: a
   second read path would be a second representation of records the snapshot
   already carries, and could hand a caller a Run whose Task it never
   observed.
5. **Per-part interfaces named for the part.** `SpaceNodes`, `SpaceChanges`,
   `SpaceEvents`, `SpaceIntents`, `SpaceTasks`, `SpaceTaskRuns`,
   `SpaceHistory`. The `Canvas` prefix contradicted the port's own noun, and
   `Repository` claimed a CRUD store for what are append-only logs and a
   ledger. `SpaceRepository` keeps its name: it is the collection, a different
   subject at a different level. Disk files follow the types they implement
   (`space-nodes.ts`, `space-logs.ts`, `space-record.ts`, `space-tasks.ts`),
   as do their contract suites.

`SpaceNodes.canvasId` survives the flattening although the handle carries the
same id: `preprocessing` resolves that part per request and works with it
detached from any handle.

#### 12.4.3 Disk-behavior corrections — landed

A third review pass asked the question §12.4 answers for the _port_ about the
_backend_: what did routing the writers through it change underneath, and does
each change pay for itself. Four did not. The port shape is untouched by all
of them; every correction is inside the Disk adapter or the coordinator above
it.

1. **The forced per-batch node rescan is gone.** Phase 4 had
   `withValidatedNodeMutationTransaction` invalidate and rebuild the node
   index at the top of every executor batch, to freeze physical ownership for
   the synchronous run. Rebuilding that index reads and YAML-parses _every_
   sidecar in the Space, so the cost was O(nodes) synchronous I/O inside the
   canvas mutex, on the hottest write path in the product: a one-node mutation
   measured 0.63 ms → 5.34 ms at 200 nodes and 1.55 ms → 19.70 ms at 1000.
   `writeNode`'s own staleness probes already run per mutation inside the
   batch and cost a names-only `readdir`; the rescan bought a narrower
   ownership guarantee than they give at roughly thirteen times the price.
2. **A hand-broken sidecar is readable again.** `readNodeStrict` parsed
   frontmatter with `strict: true`, which made unparseable YAML a read
   failure. `SpaceNodes.read/put/delete` are the only callers, so a node whose
   frontmatter a user broke in an external editor answered 500 on the content
   PUT _and_ on DELETE, while the lenient GET kept rendering it — visible,
   unrepairable, undeletable, in a product whose premise is hand-editable
   markdown. The method stays strict about _reachability_, which is the part
   the port needs: only ENOENT is absence, and an unreadable path still
   raises. Malformed content is recovered exactly as `readNode` recovers it.
3. **Deleting a duplicated node id works again.** Phase 4 made `deleteNode`
   throw when two sidecars claim one id. `put` must refuse that state — it
   cannot know which representation the caller meant to update — but delete
   has no such ambiguity, and refusing stranded the node in precisely the
   state a user resolves by deleting. It also failed the enclosing executor
   batch wholesale, taking every unrelated node and edge in the same command
   with it. The indexed representative is deleted; the orphan stays and is
   still reported by the duplicate-node surfaces.
4. **The lifecycle World guard no longer requires a World to exist.**
   `beginDelete` and `rename` resolved World identity through
   `requireWorldCanvasId()`, which raises on a missing or malformed World, so
   unrelated damage to `World/` turned every ordinary delete and rename into a 500. Those two only ask whether _this_ Space is the protected one, which a
   namespace without a World answers with a plain no — what `isWorldCanvasId`
   answered before Phase 4. `worldId()` still raises: reporting the identity
   is an integrity question, and there is no honest answer.

Three pieces of surface went with them, on the same rule §12.4.1 applied:

- **`ownershipValidated`** on `writeNode`/`deleteNode`. Both production
  callers bypassed the branch it guarded — the ordered write is always inside
  a transaction, the node adapter always passed `true` — so the option existed
  only to switch off a path nothing took.
- **`updateNode`'s retry loop.** Its `continue` was unreachable: the mutex is
  held across the operation and the only adapter resolves both halves
  synchronously, so nothing can move the record mid-pass. Worse, exhausting
  the attempts fabricated a `rev-conflict`, which the preprocessing persist
  stage turns into a thrown `PERSIST_FAILED` — for a caller that deliberately
  passes no `expectRev`. One pass now, with the repository's opaque conflict
  translated into a public content revision.
- **`DiskDeltaLog` / `createDiskDeltaLog`.** No production caller: the
  executor journal row is appended inside the ordered Space write, which is
  where the port says it belongs, so the repository's ordering guard and
  schema validation never ran on the only path that writes the file. Wiring
  the guard in instead would have put a full log read and tail repair on every
  batch — trading correction 1's regression for a slower one. The adapter and
  the tests that were its only consumer are deleted.

One finding did not survive checking. `space-title.ts`'s `isDedupeVariant`
looked like it guarded an unreachable state, on the reasoning that a
null-titled Space is filed under its unique canvasId. Directory allocation
de-duplicates case-insensitively across the whole namespace, so a canvasId
that collides with another Space's _title_ is allocated `<canvasId> (2)` — the
contract suite pins exactly that. It stays, now with the reachability argument
written down.

#### 12.4.4 `history` flattened after the intent removal — landed

Merging `main` brought in `feat!: remove intent and sketch gesture
recognition`, which deletes intent episodes from the product. `SpaceIntents`
and the Disk intent file go with them.

That leaves §12.4.2's `history` group holding one member. The group was
justified by there being two kinds of past record — what happened, and what
was concluded from it — and one noun that covered both. With intents gone,
`handle.history.events` is a member whose only job is to hold one other
member: a level the reader pays for and learns nothing from. Events move back
to the handle as `handle.events`.

The reasoning §12.4.2 gave for what stays flat is unchanged and still load
bearing: change-review records and Tasks are not history, whatever Disk's
`.history/` directory happens to contain. If a second kind of past record
arrives, the group comes back — and `events` is where it was before, so
nothing else has to move.

### 12.5 Phase 4.5 — storage-owned layout moves inside the boundary — **implemented**

Phase 5 adds a second structured backend. Before it does, the layout knowledge
that belongs to the _Disk_ backend has to stop living outside `storage/`.
Otherwise every later backend inherits a module named `disk` as the ambient
description of where Spaces are, and each one pays to migrate the same callers
again.

The rule this phase restores: **outside `storage/`, nothing knows how Spaces
are stored.** A domain may know a Space is _materialized_ somewhere — that is a
declared capability with real consumers — but not that its record is
`space.json`, nor that its events are a JSONL file.

#### 12.5.1 What the census shows

Measured on `6b43798a`. Non-storage **production** files importing
`modules/workspace/disk/`:

| File                              | Symbols                                   | Kind              |
| --------------------------------- | ----------------------------------------- | ----------------- |
| `agent/acp/service.ts`            | `canvasAcpNamespace`                      | materialization   |
| `agent/agent-thread.service.ts`   | `canvasAcpNamespace`                      | materialization   |
| `agent/memory/analyzer.ts`        | `canvasMemoryPath`, `workspaceMemoryPath` | materialization   |
| `agent/memory/analyzer.ts`        | `chatDir`                                 | **storage-owned** |
| `agent/node-ref.ts`               | `toSafeFilename`                          | pure naming       |
| `canvas/canvas.route.ts`          | `toSafeFilename`                          | pure naming       |
| `canvas/external-watcher.ts`      | `registerSpaceDirHandleOwner`             | materialization   |
| `preprocessing/stages/project.ts` | `normalizeForCompare`                     | pure naming       |
| `workspace-prepare.ts`            | `ensureWorldCanvasOnDisk`                 | materialization   |

Six test files add `nodesDir`, `changesPath`, `canvasRoot`, and
`withSpaceDirHandlesReleased`.

**Corrected.** The table above was built by searching for `workspace/disk/`,
which misses every consumer that reaches the same symbols through the
deprecated `storage/paths.js` shim. Counting both paths, the production files
outside `storage/` that read a **storage-owned** symbol are six, not one:

| File                                        | Symbol                            | Resolution                                 |
| ------------------------------------------- | --------------------------------- | ------------------------------------------ |
| `canvas/canvas.route.ts`                    | `nodesDir`, `SPACE_JSON_FILENAME` | import/export bundle format; own constant  |
| `canvas/external-watcher.ts`                | `SPACE_JSON_FILENAME`             | Disk-only feature; declare materialization |
| `canvas/world-target-access.ts`             | `SPACE_JSON_FILENAME`             | catalogue read; `SpaceRepository.list()`   |
| `canvas/import-node-src.ts`                 | `artifactsDir`                    | ref-level `isArtifactsRel` (§12.5.7)       |
| `agent/conversation/prompt/debug-prompt.ts` | `chatDir`                         | writes its own debug log; own path         |
| `agent/memory/analyzer.ts`                  | `chatDir`                         | dead code; removed (§12.5.7)               |

Even at six this is a smaller leak than the raw import count suggests: most
`workspace/disk/` imports come from `storage/` itself, which is the permitted
direction. The problem is not mass violation by consumers — it is that the
module they import is _mixed_, and its name and location assert an answer the
port layer exists to keep open. Note also that only one of the six wants a new
port capability; the rest are dead, misfiled, or already served.

#### 12.5.2 The test that decides ownership

A symbol belongs outside `storage/` only if it is **still useful, unchanged,
when the structured backend becomes SQLite**. Applied one symbol at a time,
that question sorts `paths.ts` into four groups — not the three an eyeball
reading suggests.

| Outcome under a SQLite structured profile      | Members                                                                                                                                                              | Belongs to                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Meaningless — the state became a table         | `SPACE_JSON_FILENAME`, `canvasJsonPath`, `nodesDir`, `nodeFilePath`, `historyDir`, `changesPath`, `tasksPath`, `eventsPath`, `deltaLogPath`, `WORLD_CANVAS_DIR_NAME` | `storage/backends/disk/`                     |
| Still useful — belongs to the _other_ axis     | `ARTIFACTS_DIR_NAME`, `artifactsDir`, `artifactPath`                                                                                                                 | `storage/backends/disk/` (blob)              |
| Still useful — concept survives, body does not | `canvasRoot`, `chatDir`                                                                                                                                              | re-founded on the materialization capability |
| Still useful, untouched                        | `settingDir`, `userSkillsDir`, `workspaceMemoryPath`                                                                                                                 | `modules/workspace/`                         |

Two corrections the test forces against a looser reading:

- `WORLD_CANVAS_DIR_NAME` is a _directory name_. SQLite encodes World as
  `is_world = 1` with its own reserved collision key, and the portable concept
  already exists as `SpaceRepository.worldId()`. The constant is Disk's.
- `canvasRoot` cannot simply move. Its body resolves through `canvasDirName()`,
  which reads an index built from `space.json`, so under SQLite it silently
  falls back to id-named directories. It is the materialization anchor and has
  to be re-founded on something that does not consult the structured backend —
  which is also the fix for the blob-scope hazard in §13.

`canvas-dirs.ts` is not ambiguous at all: it builds its index by reading
`space.json` from every directory. It is Disk structured-backend state that
currently lives outside the storage boundary. `space-dir-handles.ts` looks
substrate-specific but fails the test for the same reason — it exists so
Windows can rename a Space _directory_ safely, and under SQLite there is no
such rename.

`naming.ts` is misfiled in a different way: pure string logic with no I/O,
already re-exported rather than owned. It passes the test trivially (a second
backend needs the identical rules) but has no business behind a `disk`
segment. Phase 5 extracts it to `utils/naming.ts` as a side effect of needing
it twice; that extraction belongs here, where it is the point.

Because the residue that survives the test is three setting helpers and
`getWorkspacePath()` itself — none of it filesystem-specific — the target is a
**flat `modules/workspace/`** with no substrate segment.

#### 12.5.3 `.history/` conflates two populations

The directory holds the Disk structured backend's files — `events.jsonl`,
`tasks.json`, `delta-log.jsonl`, `<thread>.changes.json` — and, sharing the
same parent for no stated reason beyond travelling together in export bundles,
per-Space state owned by other domains:

| Family                                                   | Owner under the test                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acpSessionsPath`, `canvasAcpNamespace`                  | Agent domain. It is Agenetes' own store — the namespace hands the ACP driver `storage.root` and the driver persists there. Survives the switch; its address inside `.history/` is the accident. |
| `chatPromptLogPath`                                      | Debug artifact. Written only under `HUABU_DEBUG_PROMPT` and, per its own comment, never read by the app. Needs a location, not an owner.                                                        |
| `canvasMemoryDir`, `canvasMemoryPath`, `memoryStatePath` | Agent domain, materialized. AI-private Markdown an agent reads and writes as files.                                                                                                             |

Under SQLite the first population evaporates and the second still needs a
home. Phase 4.5 assigns each an owner so that the split is a decision rather
than a leftover; it implements none of them beyond the relocation.

#### 12.5.4 Materialization becomes declared, not ambient

The consumers above cannot be served by a structured port and should not be.
An ACP agent, a file watcher, and RFS need a real directory; that is a product
requirement, not a leak.

What is wrong today is that they get it by reading an ambient layout module
whose name asserts the substrate. The port layer already has the right shape
one level down — `BlobScope` exposes `materialize()` for "consumers that
genuinely need a real filename" (§7). This phase gives Space trees the same
treatment: an explicit capability a consumer depends on by name and a profile
can decline to offer, rather than a path helper that is always simply there.

Note the dependency direction this settles. `modules/workspace/` owns _which_
directory is active; `storage/` owns what the Disk backend puts inside it.
Consumers needing a Space's real directory ask `storage/`, so the current
`storage → workspace/disk` edge inverts to `workspace ← storage` plus an
explicit capability — instead of every domain reaching into a shared layout.

#### 12.5.5 Scope

In:

1. Extract pure naming to `utils/naming.ts` and delete `workspace/disk/naming.ts`
   outright — no shim, since every call site is updated in the same step.
2. Relocate the Disk structured and blob layout families, plus
   `canvas-dirs.ts`, `name-index.ts`, `space-dir-handles.ts`, and
   `world-canvas.ts`, into `storage/backends/disk/`.
3. Leave `settingDir`, `userSkillsDir`, and `workspaceMemoryPath` in a flat
   `modules/workspace/`, with no substrate segment.
4. Introduce the Space materialization capability, re-found `canvasRoot` on it,
   and move the ACP, watcher, memory, and World-bootstrap consumers onto it.
5. Move `agent/memory/analyzer.ts` off `chatDir`. Keep the agent-owned path
   families of §12.5.3 in `modules/workspace/paths.ts` as a transitional
   materialization surface; moving them into their owning domains remains
   follow-up work.
6. Extend the module-boundary test to fail when a non-storage file imports a
   storage-owned layout symbol — the guard that stops this recurring.

Out:

- Any SQLite work, schema, or adapter.
- Changing the blob scope's _identity_ (title-derived vs `canvasId`). This
  phase records the decision point; §13 owns the hazard.
- Agenetes persistence, RFS/file-tool contracts, import/export, product UI.

#### 12.5.6 Sequence and verification

The moves preserve symbol names and runtime logic, as in §12.2.2. Tests move
with their subjects. Verification is `pnpm run check` plus the extended
boundary test; behavior parity is asserted by the existing Disk suites, which
must pass unchanged — a diff that alters a Disk test's expectations is out of
scope by definition.

Phase 5 rebases onto this and drops its `utils/naming.ts` extraction, its
`workspace/disk/naming.ts` shim, and the corresponding roadmap edits.

**Landed for the Workspace-to-storage substrate move.** `modules/workspace/`
is flat and holds `paths.ts` plus `migrations/`; the Disk record layout, blob
layout, directory index, name index, directory-handle coordination, and World
bootstrap all sit under `storage/backends/disk/`. Consumers that need only a
real Space directory call `spaceDirectory()`; directory-handle release and
World bootstrap are re-exported from the facade rather than reached by path.
This does not close every application-to-Disk read: `canvas.route.ts`,
`external-watcher.ts`, and `world-target-access.ts` intentionally retain
compatibility-shim reads, alongside migration and test callers. Three guards
in `module-boundaries.test.ts` pin the Workspace move: the workspace module
has no substrate segment, imports no backend, and names no Disk layout symbol.

#### 12.5.7 Findings from step 5, and one follow-up

Working the six consumers of §12.5.1 individually produced four different
answers, only one of which was a missing port capability.

**No new port capability — a rejected design, recorded because the reasoning
generalizes.** `import-node-src.ts` asked whether a resolved path was already
inside `.artifacts/`, and answered by rebuilding the Disk artifacts directory.
The first fix added `BlobScope.owns(absolutePath): boolean`, letting the scope
answer for itself. That was wrong, in the same way this phase exists to
correct.

`materialize()` runs port → filesystem: the port _renders_ a real path as a
service, and any backend can satisfy it by spooling a temp copy.
`owns(absolutePath)` runs the other way — it hands the port a path in a
vocabulary only a local backend can interpret and asks it to adjudicate. The
`false` a remote backend would return is not a neutral implementation but an
admission that the question is meaningless there. The net effect would have
been to remove a Disk-layout import from one consumer by moving the Disk
assumption into the port, where it constrains every future backend.

**Test for the next such proposal:** a port method must be answerable by every
backend in the port's own vocabulary. If one backend's honest implementation
is a constant, the method is describing that backend, not the port.

The caller never needed storage at all. `toPhysicalRel` already maps the
virtual `artifacts/` prefix onto the hidden directory, so "is this ref already
an artifact?" is a question about the _ref_, answered by `isArtifactsRel` in
`fs-sandbox.ts` — the module that owns virtual↔physical ref mapping.
Resolving against a synthetic root keeps it free of workspace, canvas
directory, and filesystem, while still collapsing `..`.

Writing its test surfaced a limitation worth pinning: the virtual alias is
applied as a prefix, so `nodes/../artifacts/x` is not treated as an artifact.
The pre-existing check behaved identically, so the test records the behavior
rather than widening it.

**The memory analyzer's chat digest — removed, not ported.** `readChatDigest`
scanned `<canvas>/.history/chat/*.json` for a `{ messages: [] }` shape. Two
migrations retired it: `migrate-chat-threads` renamed `<threadId>.json` to
`.json.bak` and wrote `.turns.jsonl`; `migrate-chat-turns` folded those into
the Agenetes Tier-2 store under `chat_v2/`. The only live `.json` writer left
in that directory is the change-review sidecar, whose payload is an array with
no `messages` key, so every file failed the guard. The reader had returned
nothing in any migrated workspace, and its own test pointed it at a directory
that does not exist, so nothing caught it.

Adding a `SpaceChats.list()` port to serve it would have been the wrong repair
twice over: it would give the storage ports authority over data storage does
not own — `legacy/canvas-store.ts` states plainly that threads and turns
belong to the agent runtime — and would oblige every future structured backend
to model Agenetes' turn log, which is the two-authorities hazard in §13.

**Follow-up (open):** decide whether the memory agent should see conversation
turns at all, and if so reinstate the digest against `agenetes.history()` —
the call `canvas-search.ts` already uses for exactly this data. That is a
behavior change and deliberately outside this phase, whose parity rule is that
no working behavior moves. The `latestChatTs` field and its
`lastSeenThreadCursor` plumbing survive the removal because they are the
resume point such a digest would need.

### 12.6 One Space handle and the portable read surface — **implemented**

The first of three change sets that close the application-side gap between
the portable contracts and a second structured adapter (§§12.6–12.8). It
implements the handle of §6.4.1 and completes the node read surface every
later reader needs. It contains no SQLite schema, driver, migration, or
profile-selectability branch.

#### 12.6.1 The node read surface, completed

`SpaceNodes` had one read — by id — so any reader wanting more than one node
had to go around the port to the legacy Disk store. It now carries the three
shapes the application actually asks for:

- `readMany(ids)` for a named selection — a selection to describe, a
  neighbourhood to render, one View to serve. This is the one that matters for
  cost: expressed as `list()` the same read makes an unrelated node somewhere
  else part of the bill, and no backend serves that better than it serves a
  lookup by id.
- `list()` for work that genuinely spans the Space — executor prestate
  hydration, the Space GET, the canvas outline, cross-node inspection.
- `stream(onNode)` for a reader that can show partial results while the rest
  arrives. Delivery is arrival order, deliberately not a query order, and no
  backend promises a resumable cursor. It is a latency shape, not pagination.

All four reads return the same complete records and the same opaque
revisions. The node contract now asserts they never disagree about a node: an
adapter whose scan parsed more leniently than its single read, or minted a
different revision, would pass a suite written against one shape alone.

`SpaceRepository.ensureWorld()` joins them as the backend-neutral bootstrap
hook. Every backend meets an empty namespace the first time it is opened, and
a Workspace without a World has no Portal target, so ensuring one cannot stay
a Disk step run before the store exists. It is idempotent and deliberately
narrower than "create if absent": it mints a version-0 World only when the
namespace holds none, while an _established_ malformed World stays the
integrity error `worldId()` reports. Disk delegates to the same idempotent
primitive Workspace preparation calls — one writer for one file, since the
legacy preparation path still runs before the store is reached. The
Space-collection contract covers both branches, which needs a harness that can
open a namespace nobody has opened yet.

#### 12.6.2 One `space(canvasId)` handle

`Storage` gains `space(canvasId)`, the composition-layer facade of §6.4.1,
joining the structured handle with the Space's blob scope and any
backend-specific members; the barrel exports a free `space(canvasId)`
shorthand for `getStorage().space(canvasId)`, matching how `canvasBlobs()` was
already called. `StructuredStore` and `BlobStore` keep their independence —
neither imports the other — so the facade is the only new type. The
`canvasBlobs(id)` and `spaceDirectory(id)` call sites migrate to it, and both
free functions are gone. The `getStructuredStore().space(id)` call sites stay:
they already reach the structured handle they need, and §12.7 moves that whole
population — the application's reads with it — in one pass, rather than
rewriting every site twice.

The facade composes from the receiver rather than a captured local, so
`{...storage, blobs: fake}` — the obvious way to stub one axis, and what the
artifact tests already do — builds Spaces on the store it substituted instead
of silently keeping the original.

The residual Disk Space directory becomes `diskTree` on that handle, typed by
its absence (`null` on every other backend) rather than reached through a
parallel import or stubbed to throw. It is **not a port and not portable**, and
it does not live in `ports/`: `StructuredStore` and `BlobStore` remain the whole
portable surface. A Space directory is Disk's, and a backend that keeps Spaces
in tables does not have one — a capability missing from a backend is an
acceptable outcome, and the honest one. Making every backend promise a
directory would mean fabricating one, which moves the failure somewhere less
obvious than the refusal.

The capability owns a Workspace-bound Space directory, bundle publication, the
sidecar-to-record mapping, and directory-handle coordination. Workspace-bound
is literal: the tree binds to the Workspace that was active when the handle was
resolved, so a retained tree rejects after an activation rather than resolving
into the newly active Workspace — the same refusal the handle's portable
members make, on the one member that hands out real paths.
`module-boundaries.test.ts` holds the member name and the exact consumer list,
so the surface can only shrink, and asserts the barrel exposes nothing that
reads as a portable path API. Every entry in that census is a family §6.4.3
assigns a disposition: the **A** families stay and become capability-matrix
rows in §12.8, and the rest leave as they move onto a port.

One consumer left the census immediately, because it was never a storage
consumer. `import-node-src` asked storage where a Space was in order to
classify a path it had already resolved in sandbox coordinates; it now asks
`fs-sandbox` for its own root, which is the module that owns that vocabulary.

#### 12.6.3 Scope boundary

In: the node read shapes and their contract, `ensureWorld()` and its contract,
the `space(canvasId)` facade, the `diskTree` member and its census guard, and
the call-site migration off `canvasBlobs()` / `spaceDirectory()`.

Out, and owned by the two change sets that follow: retiring production
`CanvasStore` reads (§12.7), the per-area blob scopes and `BlobStore.space()`
symmetry, the extension substrate, the Disk-only capability matrix, and the
product-level backend harness (§12.8).

### 12.7 Backend-agnostic application reads — **implemented**

The second change set. Every production structured read now uses
`StructuredStore`: Space topology through `SpaceHandle.read()`, single node
content through `SpaceNodes.read()`, a named subset through
`SpaceNodes.readMany()`, and whole-Space or incremental scans through
`SpaceNodes.list()` / `SpaceNodes.stream()`. Search keeps its progressive
metadata delivery without naming a filesystem scan.

`CanvasStore` remains inside the Disk adapter and the compatibility tests. It
is not an application service: `storage/canvas-store.ts` had no importers left
and is deleted — the first of the three Phase-4.5 forwarding shims to go.

Two findings, each surfaced by building rather than by reading.

**`node-prompt` could not stay store-aware.** It is a pure merge that took a
`CanvasStore` solely to lazily read a record its caller had not supplied,
which made a pure function into a synchronous Disk dependency no async port
can satisfy. The record became an argument, and each caller now reads in the
shape its request has — which is what made `readMany` earn its place rather
than merely have one.

**The barrel was a way around the import guard.** The Space preview
projection reached the legacy store by name through `storage/index.js`, which
the path-level check resolved to the barrel and let through. The guard now
checks the imported symbol as well as the path. `resetStorageCache` is
deliberately not on that symbol list: it is on the barrel too and the
Workspace routes still call it, but it reads nothing — it is activation
dropping an adapter's caches, a composition concern with its own home to find
(§12.8).

#### 12.7.1 The last Disk-layout imports

The neutrality half of the exit criterion says no production module outside
`storage/` may name how a backend stores a Space. Three still did, and each
was a different kind of leak.

The external-note watcher read the Space record off the file beside `nodes/`.
That path read was equivalent only because Disk keeps the two together, and
"what does this Space contain" is a question every backend answers — so it
goes through the port. Reveal-nodes assembled the sidecar directory itself;
the Disk capability now answers "which folder holds the notes", which is what
having one owner for the layout is for.

Bundle import was the real one. It owned the staging location, the
title-derived directory name, the record filename, and the directory index
entry — all four are placement, and none of them are the `.huabu.zip` format
the route legitimately interprets. `stageSpaceImport` takes them, and the
route keeps unzipping, the manifest, and artifact-URL remapping.

Splitting it surfaced something worth naming: the bundle's record filename and
Disk's record filename are the same string for a historical reason, not a
shared one. One is a wire format frozen by every bundle already exported; the
other is how a backend files a record today. They are separate constants now,
because they drift the moment a backend that is not Disk exports a bundle.

With those gone, `storage/paths.js` has one production importer left and it is
a migration — exempt by construction, since rewriting a frozen historical
shape is the one legitimate reason to know a layout that is no longer current.
The guard is import-level, repo-wide, migrations and tests exempt: a local
variable that happens to be called `artifactPath` is not a violation while
importing `canvasRoot` is.

#### 12.7.2 Two behaviours that moved, deliberately

Neither is implied by the read migration, and both are hardenings rather than
side effects.

**Duplicate `canvasId` directories raise.** Two Space directories carrying the
same id resolved last-wins; the directory scan now rejects. That makes a
Finder-side duplication a loud failure of every catalogue read rather than a
Space that silently resolves to an arbitrary copy.

**The Space preview reads node records leniently.** The route read sidecars
strictly and answered 422 when one failed to parse. The port defines a single
lenient read for the collection — a record it cannot produce is omitted, a
record broken by hand recovers — and the projection already fell back to
topology data for an absent record, so a damaged sidecar now renders the way
it does when its own Space is opened instead of failing the whole preview. The
422 stays for a malformed Space _record_, and now covers a record the port
refuses to produce as well as topology that is not the expected shape. The
alternative was a `strict` flag on `list()`, which the port had just finished
arguing against: one caller's all-or-nothing preference is not a second read
semantics every backend has to carry.

### 12.8 The dispositions, and a harness that proves them — **planned**

The last change set applies §6.4.3 to the residual per-Space files and proves
the result against a mounted profile:

- **D.** `BlobStore.space(id)` returns `SpaceBlobs`, symmetric with the
  structured port, with one member per user-visible area — artifacts, the
  `skill.md` guide, the memory body, upload scratch — so the Disk paths a user
  sees are unchanged and retention can diverge later without moving bytes
  again.
- **C.** The extension substrate of §6.4.4 lands as one Space-handle member
  with a Disk case, namespace validation, and destruction with the Space.
  Memory-worker state and the debug chat prompt log become its first two
  namespaces, retiring two ad-hoc file formats. The `existsSync(spaceDir)`
  resurrection guard disappears rather than moving. ACP session state keeps
  disposition C but moves with the Agenetes `Namespace` change, not here.
- **A.** The Disk-only families become entries in a capability matrix
  `validateStorageProfile()` consults, so an operator selecting a profile
  learns up front which product features it does not offer.
- **Proof.** `storage/testing.ts` mounts a real profile onto a temporary
  Workspace through the production lifecycle rather than swapping in a stub,
  and a product-level suite runs the exit criterion against every profile in
  `PRODUCT_STORAGE_PROFILES`, naming no directory, filename, or `space.json`.

The exit criterion for the three change sets together has two halves.
**Neutrality:** adding another `StructuredStore` changes adapter, composition,
and migration code, but does not require Canvas, agent, web, RFS,
interactive-view, Task, or Workspace feature modules to learn that backend's
record layout. **One handle:** every storage capability for one Space is
reached through one `space(canvasId)` handle, and every family that is still a
bare file is one the capability matrix declares Disk-only.

Out of scope throughout: a SQLite adapter or schema, Disk→SQLite data
migration, SQLite profile registration, Postgres/Azure, the portable
change-notification capability, RFS's backend-neutral path vocabulary, ACP
session relocation, the rest of the Agenetes persistence migration, the
portable export format, a writable general-purpose virtual filesystem or OS
mount, protocol or UI changes, and stronger crash/distributed transaction
guarantees.

### 12.9 Later phases — provisional

5. Add one new adapter at a time — SQLite, then Postgres, then Azure Blob —
   running the same contract suites, migration fixtures, failure injection,
   and concurrency tests against each. An adapter may exist for isolated
   testing before its backend profile is selectable; profile validation keeps
   rejecting it until the required capability matrix is satisfied.
6. Migrate the currently synchronous Agenetes persistence ports without
   changing their persist-before-notify, sequence, and fencing semantics.
7. Refactor RFS and built-in file tools only after a logical file-view contract
   is accepted, if that option is chosen.
8. Prototype native CLI access separately and decide between protocol-only,
   materialization, and mounting from measured product requirements.
9. Design and implement backend migration/export/import only after source and
   destination consistency semantics are fixed.

## 13. Risks

- A generic CRUD abstraction may leak backend semantics and become harder to
  use than explicit domain repositories.
- Preserving every current filesystem behavior may accidentally require SQL
  backends to emulate a directory tree as their primary model — and the
  inverse: Disk's flat, basename-collapsed keyspace is now a contract term
  every blob backend must emulate (§7.1).
- A contract suite that only asserts behavior where the adapters already agree
  produces false confidence exactly where portability is at risk. `materialize()`
  was the concrete instance (§12.1.1 item 2); the general hazard is that §15
  leans on these suites as the readiness gate, so a suite that is silent about
  a divergence certifies both sides of it.
- Repository contracts frozen and covered by suites before any caller exercises
  them tend to be reshaped by the first real adoption, invalidating the suites
  written for them. Phases 2 and 3 buy bounded event, catalogue, change, record,
  and intent readers against this; Phase 4 exercises lifecycle, node, ordered
  writer, event, change, and intent mutations (§§12.2.8–12.4).
- Disk's physical layout for a Space is derived from a mutable title-derived
  directory name, so a blob scope's location moves on rename while its
  `canvasId` does not. No other backend reproduces this.
- Treating projections as writable without an ingest protocol may create two
  authorities and silent data loss.
- Cross-store partial failures may leak blobs or leave broken references.
- Adapter-specific capabilities may create divergent product behavior unless
  they are declared and validated.
- Synchronous legacy call sites may cause event-loop stalls or force remote
  backends behind blocking compatibility shims.
- Invariants held only by the absence of an `await` inside an `async` method
  are invisible to review and to the obvious test (§12.2.5).
- Filename-based identity may break on rename, case-folding, or cross-platform
  export/import.
- A local projection may expose private memory/history or host paths to an
  external agent unless visibility is capability-scoped.

## 14. Open questions

### Resolved or accepted by implemented phases

- **Blob key shape** — not content-addressed. `name` is the scope-relative
  `<artifactId><ext>` string that is already the URL key and node `src`, so
  nothing downstream re-encodes. (P1)
- **Range reads** — required. `canvas-executor` reads the first 64 KiB of an
  image for its aspect ratio. Server-side copy and conditional put are not
  required; artifact clone is `read` → `put`. (P1)
- **Per-key blob deletion** — not a public operation. `deleteAll()` covers
  Space destruction, which is the only real case today. (P1)
- **Blob write atomicity** — required. `put()` is all-or-nothing to a
  concurrent reader, which also removes the need to clean up after a torn
  write through a port that has no per-key delete. (P1, §6.2)
- **Materialize lease lifetime** — the path is read-only and invalid once
  `release()` resolves, on every backend including Disk. (P1, §6.2)
- **Repository boundaries, minimum accepted** — `SpaceRepository` (the
  collection: membership, World identity, create/delete/rename) and the
  per-Space handle — its own record read/ordered write, `SpaceNodes`,
  `SpaceChanges`, `SpaceTasks`, and `SpaceEvents` — are implemented with
  reusable contracts. Rejected in-process node → record →
  delta batches restore prestate, while title rename keeps its preceding
  best-effort boundary. This is not an aggregate crash-recovery or distributed
  transaction. (P2–P4, §§12.2–12.4, 12.4.1)
- **Bounded repository consumers** — the events route landed in P2; P3 added
  the Canvas list, Workspace World lookup, thread-change read, and memory
  record/event/intent reads; P4 migrated the structured mutation paths named
  in §12.4. (P2–P4, §§12.2.8, 12.3.3–12.4)

### Structured storage

- Which Canvas-owned records belong in each L1 repository while preserving
  Agenetes ownership of Thread/Event/Turn semantics and ports?
- Does `StructuredStore` remain only a name for the configured backend family,
  with L1 and L2 retaining separate code-level port interfaces?
- Does a real SQL deployment require a stronger atomic aggregate/outbox API
  than `OrderedSpaceWriter`, and which existing product operation justifies
  that guarantee?
- Are node bodies always structured records, and how are large extracted texts
  handled?
- Which query/search guarantees must be portable across Disk, SQLite, and
  Postgres? Is full-text search part of the port or a separate service?
- What is the schema migration/version negotiation model?
- Should Disk ever add process-crash recovery beyond its current caught-error
  rollback, and is preserving independently editable files worth that
  complexity?
- How are currently synchronous Agenetes persistence ports migrated without
  changing their persist-before-notify, sequence, and fencing semantics?
- Where do user memory, Space memory, memory-worker state, chat digest, and
  user-authored skills belong? The analyzer's Space record, action-event, and
  intent inputs moved in P3; these physical files did not.

### Blob storage

- Are signed delivery URLs a required capability, and does the domain ever see
  one? If so, content type has to become stored blob metadata rather than a
  name-derived value computed at the HTTP boundary, because signed delivery
  bypasses `sendBlob` entirely — which means `put()` grows an options
  parameter (§7.1).
- Should any scope kind ever need hierarchical names? The contract currently
  collapses names to a single segment for every backend (§7.1).
- Does `health()` need a failure mode? It cannot currently report one, and the
  contract suite asserts success, so an unhealthy backend fails the suite
  rather than reporting itself unhealthy.
- Where do staging state, orphan detection, reference counts, retention, and GC
  live?
- Is an upload scratch area durable BlobStore state, leased temporary state, or
  agent-workspace state?
- How are encryption, credentials, tenancy prefixes, and Azure container
  lifecycle configured?

### Composition and migration

- Which backend combinations are supported product configurations?
- Which Workspace-scoped handles and caches must be invalidated on activation?
  The process-wide backend connections remain open; SQL Workspaces share one
  connection/pool and activation only changes the selected namespace.
- Can a deployment change either configured backend, and is migration online
  or offline?
- How are backups and restores made consistent across structured and blob
  stores?
- How are health, readiness, degraded operation, and observability reported?
- How does backend configuration reach Agenetes adapters without putting a
  DSN, secret, database client, or method-bearing resolver into serializable
  `WorkloadSpec` / `Namespace` values?
- Which additional coordination is required before Postgres can support
  multiple Server processes? Postgres alone does not replace the current
  in-process mutex, pub/sub, or live-tail ownership.

### Agent and filesystem access

- Do users require native `cat`/`rg`/editor access, or are RFS/tool operations
  sufficient?
- Should a logical `SpaceFileView` be a shared application port?
- Should ACP `/space` be wired to that view, replaced, or removed?
- If a real directory is needed, is it read-only, scratch-enabled, or an
  editable checkout?
- How is a stable directory refreshed across a long-lived ACP session?
- How do rename, delete, duplicate IDs, filename collisions, and conflict files
  map back to domain mutations?
- Does external-note discovery remain a Disk-only optional capability?
- Is an OS mount justified on every supported desktop platform?

## 15. Validation criteria for a later implementation

Before a new backend is production-ready:

- the same structured and blob contract suites pass against every claimed
  implementation;
- those suites contain at least one assertion for each known point where the
  implementations could diverge — lease lifetime, replacement atomicity,
  ordering, rejected-batch restoration, and conflict results — because a suite
  is only evidence where it actually asserts, and two adapters with opposite
  semantics can otherwise both pass it (§13);
- authoritative Space catalogue, lifecycle, record, node, ordered-writer, and
  Canvas-log consumers have no direct physical-file fallback outside the
  adapter boundary;
- application services do not branch on backend kind for ordinary domain
  behavior;
- no common BlobStore consumer requires a permanent absolute path;
- accepted concurrency, CAS, and conflict contracts match across structured
  implementations; if idempotency is accepted, its semantics match too;
- injected in-process failures inside a node → record → delta batch restore
  prestate, while explicit title rename is tested as its separate best-effort
  boundary;
- injected failures between blob and structured commits have tested recovery
  behavior;
- unsupported filesystem capabilities are either backed by an accepted
  projection/view contract or rejected explicitly for that profile;
- invalid deployment and capability combinations fail fast with actionable
  diagnostics;
- current Disk workspaces remain readable and behaviorally compatible;
- export/import and agent access have an explicit tested contract for that
  backend profile.

## 16. Related documents

- [Canvas Storage Architecture](../architecture/canvas-storage.md) — current
  authoritative Disk implementation.
- [Canvas Command Architecture](../architecture/canvas-command-architecture.md)
  — current command and execution semantics, including partial acceptance.
- [Canvas Realtime Sync](../architecture/canvas-realtime-sync.md) — current
  versioning, persist-before-broadcast, mutex, and in-memory fan-out behavior.
- [Agent Reachback](../architecture/agent-reachback.md) — current external-agent
  HTTP reachback behavior.
- [Agent Architecture](../architecture/agent-architecture.md) — current
  built-in filesystem tools and Agenetes store wiring.
- [Agent Memory](../architecture/agent-memory.md) — current virtual memory and
  skill paths whose future storage ownership is unresolved.
- [Agent Reachback RFS proposal](./agent-reachback-rfs.md) — rationale and
  history of the RFS file/control planes.
- [Direct Space Operations](./direct-space-operations.md) — canonical external
  `SpaceQuery` and agent-allowed `CanvasCommand` facade.
- [Headless Executor](./headless-executor-plan.md) — current command execution,
  version, delta, and persistence behavior.
- [Node Write Unification](./node-write-unification-plan.md) — current node
  authored-content ownership and revision CAS design history; durable behavior
  is folded into Canvas Storage Architecture.
- [Layered Architecture](./layered-architecture.md) — Huabu/Agenetes ownership
  boundaries and agent transport model.
- [Active-Space External-Note Watcher](./active-space-external-note-watcher.md)
  — current Disk-specific external Markdown import behavior.
- [Canvas Checkpoints](./canvas-checkpoint-plan.md) — proposed checkpoint API
  whose first implementation currently assumes a directory-backed Space.
- [Agenetes design](../../external/agenetes/README.md) — authoritative L2
  persistence ownership, namespace, sequence, and replay invariants.
- [Agenetes-Agentlet Gateway Consolidation](./agenetes-agentlet-gateway-consolidation.md)
  — records removal of the old Agentlet SQLite session store; it must not be
  confused with the proposed SQLite structured backend.

## 17. Code entry points

| File/dir                                                                                                                                     | Responsibility                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/modules/storage/`](../../apps/server/src/modules/storage/)                                                                 | Ports, composition, adapters, compatibility, tests, and three forwarding shims — the canonical Phase-1–4 tree (§§12.1–12.4), guarded by `module-boundaries.test.ts`.                                                 |
| [`apps/server/src/modules/storage/ports/`](../../apps/server/src/modules/storage/ports/)                                                     | The two ports; reusable suites live in `ports/contracts/`. `blob.ts` is normative (§7.1); `structured.ts` owns the Space collection and the per-Space handle: record read/write, nodes, changes, Tasks, and history. |
| [`apps/server/src/modules/storage/storage.ts`](../../apps/server/src/modules/storage/storage.ts)                                             | Composition root: maps profiles to adapters, guards blob puts, and holds a lifecycle deletion session across the blob-first cleanup saga.                                                                            |
| [`.../storage/backends/disk/legacy/canvas-store-cache.ts`](../../apps/server/src/modules/storage/backends/disk/legacy/canvas-store-cache.ts) | Bounded LRU of legacy Disk Space objects. The single owner both the adapter and the facade resolve through, and the real limit of `space(id)` identity (§12.2.4).                                                    |
| [`apps/server/src/modules/storage/profile.ts`](../../apps/server/src/modules/storage/profile.ts)                                             | Two-axis backend selection from env, and the fail-fast validation hook for unsupported combinations.                                                                                                                 |
| [`apps/server/src/modules/storage/backends/disk/`](../../apps/server/src/modules/storage/backends/disk/)                                     | Every Disk implementation: blob/structured stores, the Space collection, and the per-Space record, node, log, and Task adapters, in-process batch restoration, and the legacy class under `legacy/`.                 |
| [`.../storage/compatibility/canvas.ts`](../../apps/server/src/modules/storage/compatibility/canvas.ts)                                       | Residual Disk read surface plus direct-module lifecycle test fixtures; production structured mutations enumerated in §12.4 use the portable ports.                                                                   |
| [`apps/server/src/modules/agent/memory/analyzer.ts`](../../apps/server/src/modules/agent/memory/analyzer.ts)                                 | P3 repository consumer for strict Space existence, bounded action events, and intent episodes; physical chat and memory files remain Disk-specific.                                                                  |
| [`apps/server/src/modules/canvas/write-coordinator.ts`](../../apps/server/src/modules/canvas/write-coordinator.ts)                           | Canvas mutation coordinator and per-Space write lock, held across asynchronous node read, revision CAS, and put.                                                                                                     |
| [`apps/server/src/modules/workspace/`](../../apps/server/src/modules/workspace/)                                                             | Workspace-owned and transitional materialization paths plus migrations. Disk layout and directory-index code now live under `storage/backends/disk/`.                                                                |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                               | Canonical command execution; submits one ordered node/record/delta batch through `SpaceHandle.write`.                                                                                                                |
| [`apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts`](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)             | Current real-Disk path resolution and traversal for built-in agent file tools.                                                                                                                                       |
| [`apps/server/src/modules/agent/acp/capabilities/fs.ts`](../../apps/server/src/modules/agent/acp/capabilities/fs.ts)                         | Synthetic ACP `/space` read capability, currently not wired into the production driver.                                                                                                                              |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                                         | External-agent workload assembly, profile working directory, and RFS environment injection.                                                                                                                          |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                                     | Current external-agent file/query/execute HTTP facade.                                                                                                                                                               |
| [`apps/server/src/modules/canvas/external-watcher.ts`](../../apps/server/src/modules/canvas/external-watcher.ts)                             | Current Disk-only external Markdown discovery.                                                                                                                                                                       |
| [`apps/server/src/modules/agent/agenetes/drivers.ts`](../../apps/server/src/modules/agent/agenetes/drivers.ts)                               | Current file-backed Agenetes thread, event, and turn stores that need future backend adapter/composition decisions while remaining L2-owned.                                                                         |
