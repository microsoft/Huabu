# Multi-Backend Storage

Status: Phase 1 in review; Phase 2 ready to implement
Last updated: 2026-08-04

> **Scope and decision confidence.** This proposal records the two-port
> `StructuredStore` / `BlobStore` split and their target backend families as
> the settled direction. Except for the implemented Blob contract and the accepted
> phase-2 module/repository shape, exact schemas, later aggregate boundaries,
> migration mechanics, backend-selection scope, virtual filesystem behavior,
> agent workspace materialization, and write-back are still design space. The
> remaining candidate interfaces below are discussion aids, not implementation
> instructions.
>
> **Implementation state.** Phase 1 is written but **not merged to `main`** —
> it lives on `proposal/multi-backend-storage` and is in review. `BlobStore`
> is a real backend-neutral port with a Disk adapter and a reusable contract
> suite, and artifact bytes are gone from `CanvasStore`. `StructuredStore` is
> a lifecycle and backend-selection boundary only — `SpaceHandle` is still
> literally `CanvasStore`. A 2026-08-04 adversarial review found five defects
> on that branch; the fixes are on it and are described in §12.1.1.
>
> Phase 2 is specified in §12.2 and **ready to implement**: its plan is
> committed, phase 1 is merged into its branch
> (`feat/structured-space-repositories`), and the server suite is green. It
> makes `storage/` match the target ports/backends/compatibility hierarchy,
> adds scoped Space-record and Canvas-log repositories behind the existing
> facade, and migrates exactly one read-only consumer through the new
> repository so the contract shape is validated by a real caller before it is
> frozen. No SQLite, Postgres, or Azure adapter exists. §12 is the
> authoritative phase plan; the decision table in §2 marks what each phase has
> actually settled.

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

| Topic                                                  | Status                       | Current position                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate authoritative structured and blob ports       | **Accepted** (P1, in review) | Storage is composed from `StructuredStore` and `BlobStore`; there is no single backend interface that mixes both concerns.                                                                                                                                                             |
| Structured backend family                              | **Settled direction**        | Support Disk, SQLite, and Postgres implementations. Only Disk exists.                                                                                                                                                                                                                  |
| Blob backend family                                    | **Settled direction**        | Support Disk and Azure Blob implementations. Only Disk exists.                                                                                                                                                                                                                         |
| Independent composition                                | **Accepted** (P1, in review) | `StorageProfile` has two env-parsed axes; `validateStorageProfile` fails fast on unimplemented kinds and is the extension point for combination rules. Lazy `getStorage()` must stop skipping `init()` (§12.1.1).                                                                      |
| Blob port contract                                     | **Accepted** (P1, in review) | Connection → scope, stream-oriented, no permanent absolute path in the common contract; `materialize()` returns a bounded lease for the one consumer needing a file. Replacement atomicity and post-release lease semantics are contract terms, not adapter accidents (§6.2, §12.1.1). |
| Concrete interface shape and async migration           | Partly settled               | Blob is async and backend-neutral. P2 gives `StructuredStore.space()` async record/log repositories and a narrow synchronous node surface, and migrates exactly one read-only route through them; every other application consumer stays on the Disk compatibility facade.             |
| Exact structured repositories and aggregate boundaries | Partly settled               | `SpaceRepository` and `CanvasLogRepository` are accepted in P2. Catalogue/lifecycle, `NodeRepository`, title mutation, and the cross-repository `SpaceCommit` boundary remain open.                                                                                                    |
| Node Markdown ownership                                | Proposed                     | Keep authored node content with structured node records because it participates in revision CAS, search, and node mutation. Keep opaque and large bytes in BlobStore.                                                                                                                  |
| Blob key, staging, deletion, and GC semantics          | Proposed / open              | Names are the existing `<artifactId><ext>` keys; `deleteAll()` covers Space destruction. Staging, reference counting, and GC remain undesigned. Per-key deletion stays out of the public port, but the absence of any cleanup path is what makes atomic replace mandatory (§6.2).      |
| Space-handle identity and caching                      | **Corrected** (P1)           | `space(id)` returning a stable handle is bounded by the LRU behind it, not guaranteed. In-memory tombstones and the filename index are therefore adapter-local caches, never durable state (§12.1.1, §12.2.4).                                                                         |
| Backend selection scope                                | Open                         | Process-global today because the profile is read from env. Per-Workspace or per-Space selection has not been fixed.                                                                                                                                                                    |
| Logical filesystem view                                | Open                         | A possible `SpaceFileView` above both stores; name and contract are not accepted yet.                                                                                                                                                                                                  |
| Real agent workspace                                   | Open                         | Materialized directory, OS mount, protocol-only access, or a combination remain under evaluation.                                                                                                                                                                                      |
| Agent-authored filesystem write-back                   | Open                         | Read-only projection, explicit checkout/commit, and live bidirectional sync are alternatives, not decisions.                                                                                                                                                                           |

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

[`CanvasStore`](../../apps/server/src/modules/storage/canvas-store.ts) still
combines several responsibilities:

- Space catalogue, topology, version, node records, and filenames;
- Markdown/frontmatter serialization and node revision behavior;
- intent, event, delta, and change-review persistence;
- directory creation, rename, deletion, scanning, and export assumptions.

Artifact byte paths and streams are no longer among them — phase 1 moved
them behind `BlobStore` (§12.1). The rest is what phases 2 and 3 narrow.

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

## 6. Settled backend split; proposed contract properties

Only the two storage families and their target implementations are settled in
this section. The ownership and contract properties below are proposals to be
reviewed separately.

### 6.1 StructuredStore

`StructuredStore` is a domain persistence boundary, not a generic relational
database abstraction. Disk must be able to implement the same semantics
without pretending to support arbitrary SQL, joins, or callbacks executed
inside a database transaction.

Expected Canvas-domain data includes, subject to the final repository split:

- Workspace and Space catalogue records;
- Space topology, nodes, edges, geometry, and versions;
- authored node documents and node metadata;
- revisions, tombstones, idempotency records, and mutation deltas;
- artifact metadata and references to BlobStore keys;
- Canvas-owned histories, intents, events, and outbox records where applicable.

The top-level name does not require one monolithic class. Concrete persistence
ports remain owned by their domains. L1 may own repositories such as
`SpaceRepository`, `NodeRepository`, and its Canvas log stores; Agenetes L2
remains the sole owner of its existing `ThreadStore`, `EventLogStore`, and
`TurnStore` contracts. The host composition root may select one structured
backend family and inject matching adapters into both domains, but it must not
move L2 persistence ownership back into `CanvasStore`.

As a proposed requirement, every port that may be implemented by Postgres
should become asynchronous. A synchronous Disk or SQLite implementation must
not constrain Postgres or future remote implementations. This includes an
explicit migration for Agenetes ports that are synchronous today; a blocking
compatibility facade over Postgres is not an acceptable end state.

**As implemented**, `StructuredStore` is not yet any of this. Phase 1 lands
it as a lifecycle and backend-selection boundary whose `SpaceHandle` is
literally `CanvasStore` — synchronous and filename-shaped, so no SQL adapter
can be written against it. Phase 2 (§12.2) establishes the target module shape
and vends async Space-record and Canvas-log repositories behind the unchanged
Disk compatibility facade, with one read-only consumer moved onto them. Later
phases migrate the rest, settle lifecycle, and replace the synchronous node
surface. Until then, the paragraphs above describe the target, not the code.

The public contract should express domain commits and preconditions rather
than expose a lowest-common-denominator `withTransaction(callback)` API. The
exact atomic aggregate is open, but likely needs to cover a Space version/CAS
transition together with its node mutations, deltas, and durable publication
record. This storage atomicity would apply after the executor has determined
the accepted command subset; it does not change current command-level partial
acceptance into an all-or-nothing transactional batch.

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
defaulting to `disk`. Credential references, selection scope, config storage,
restart behavior, and runtime switching remain open — a Postgres DSN or Azure
container reference will extend these members.

Some combinations require capability validation. For example, Postgres plus a
node-local DiskBlob implementation is unsafe in a multi-replica deployment
unless the path is a deliberately shared and supported filesystem. SQLite on a
network filesystem has different correctness and availability constraints from
local SQLite. `validateStorageProfile()` is where such rules live; today it
rejects kinds that are named but not implemented, so an unsupported profile
fails at startup with an actionable message rather than nondeterministically
while serving data.

## 7. Contracts

### 7.1 BlobStore — normative

The blob sketch that appeared here has been superseded by the implemented
port in
[`ports/blob.ts`](../../apps/server/src/modules/storage/ports/blob.ts), whose
contract suite is
[`ports/blob-store.contract.ts`](../../apps/server/src/modules/storage/ports/blob-store.contract.ts).
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

### 7.2 StructuredStore — target sketch, partly accepted

The connection → scoped-handle shape and the record/log members are accepted
for phase 2. Catalogue/lifecycle, application adoption, the asynchronous
`NodeRepository`, and the aggregate `commit` operation remain later work.
§12.2 is authoritative for the accepted contracts and containment boundary.

```ts
interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;

  space(canvasId: string): SpaceHandle;
}

interface SpaceHandle {
  readonly canvasId: string;
  readonly record: SpaceRepository;
  readonly logs: CanvasLogRepository;
  readonly nodes: LegacyNodeStore; // phase-2 compatibility surface
}

interface FutureCanvasPersistence {
  spaces: SpaceRepository;
  nodes: NodeRepository;
  logs: CanvasLogRepository;
  commit(input: SpaceCommit): Promise<SpaceCommitResult>;
}

interface SpaceCommit {
  spaceId: string;
  expectedVersion: number;
  idempotencyKey: string;
  changes: DomainChange[];
}
```

Questions left by this sketch include catalogue and aggregate lifecycle
ownership, title mutation, whether repositories expose snapshots or cursors,
and what one `SpaceCommit` must atomically include.

## 8. Cross-store consistency — proposed, not settled

Postgres and Azure Blob cannot share an ACID transaction. Portable behavior
must not depend on stronger accidental guarantees from Disk + Disk — nor on
Disk being the _weaker_ side, which is the case for write atomicity (§6.2).
Both directions produce code that is correct against one adapter only.

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

`deleteCanvas` is the one place where this design already exists in code, and
it currently runs in the order this section argues against: it destroys the
structured records first, then calls `deleteAll()` on the blob scope. On Disk
that is a harmless second delete of an already-removed directory. On a remote
backend a failed `deleteAll()` leaves blobs that nothing can find again,
because the catalogue entry that named them is already gone. The order is
inverted as part of phase 1 (§12.1.1); the retry/outbox machinery around it
stays open.

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

Phases 1 and 2 are accepted and specified below. Phases 3 onward keep the
provisional character of the original outline: they record intended order,
not approved designs.

The current on-disk format remains readable throughout port extraction. A
database adapter must not require Disk consumers to simulate tables, and the
Disk adapter must not define semantics that Postgres cannot reproduce.

### 12.1 Phase 1 — the split — **in review**

Delivers the two-port composition with Disk adapters only. The work is on
`feat/structured-space-repositories` and is not merged; §12.1.1 lists what
must land before it is.

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

`StructuredStore` lands as a **lifecycle and backend-selection boundary
only**: `SpaceHandle` is `CanvasStore`, so no SQLite or Postgres adapter can
be written against it. That limitation was stated rather than papered over,
Phase 2 establishes the narrow seam; later consumer and node phases remove the
legacy facade.

The agent filesystem surface (`fs-sandbox.ts`, ACP `/space`) and Space
export/import stay Disk-coupled. They are the open `SpaceFileView` question
of §10, not an oversight.

#### 12.1.1 Corrections from review — landed

A 2026-08-04 adversarial review of the branch found five defects. Each was a
property this proposal already claimed, contradicted by the code, so they were
phase-1 corrections rather than new scope, and they are now on the branch.

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

The branch also carried one failing test it did not cause,
`rfs.route.test.ts` → "returns an actionable error when World reconciliation
is required" (expected 409, received 200), which had been red on `main` since
2026-07-27. It turned out to be a stale expectation rather than a defect: the
test was written when a missing canonical Portal was answered with a 409, and
`ensureCanonicalPortals` subsequently made the router reconcile the Portal
first, so the asserted failure could no longer occur. It is now split into the
two contracts that do hold — reconcile-and-succeed for a live Space, 409 for a
source that is not one — leaving the route's error branch covered. The server
suite is green, which is what Phase 2 requires as a starting baseline.

### 12.2 Phase 2 — storage module shape and scoped repositories — **ready**

The preconditions this phase sets for itself are met: the plan below is
committed (§12.2.9 commit 1), phase 1 including its review corrections is
merged into the implementation branch, and `typecheck` / `test` / `lint` are
green. Implementation starts at commit 2.

Phase 2 is a containment and ownership refactor. Its primary acceptance
criterion is that `apps/server/src/modules/storage/` has the target
ports/backends/compatibility hierarchy and dependency direction. It exposes
the first narrow structured repositories through `StructuredStore`, and it
migrates **exactly one** read-only consumer onto them. Every other application
consumer stays on the existing Disk facade.

That boundary is practical rather than cosmetic: the legacy `getCanvasStore()`
surface has many consumers, and moving them is an async rewrite that has
nothing to do with module shape. Phase 2 can make the new side correct and
testable without forcing that rewrite.

The one exception exists because a repository contract with no callers is a
guess. Phase 2 freezes `SpaceRepository` and `CanvasLogRepository` and writes
reusable contract suites against them; if the first real adoption happens two
phases later, that is when the shapes get tested against reality, and that is
when they will need to change — invalidating the suites written now. One
bounded slice through a real route costs little and converts the accepted
shape from a proposal into something a caller has exercised. §12.2.8 names the
slice.

| Axis                                        | Phase 2                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Canonical module layout                     | `ports/`, `backends/disk/`, and `compatibility/`                     |
| Space record (`space.json`)                 | Async, version-CAS `SpaceRepository` behind the facade               |
| Canvas logs (4 families)                    | Async, concurrency-specified `CanvasLogRepository` behind it         |
| Node sidecars (`nodes/*.md`)                | Narrow synchronous `LegacyNodeStore`; no full-handle backdoor        |
| Existing application storage API            | Preserved by the compatibility facade                                |
| Catalogue, World, create/delete, and title  | Existing Disk behavior retained; portable lifecycle remains open     |
| Non-storage helpers currently in the folder | Moved to their actual owners                                         |
| Application consumer migration              | One read-only route (§12.2.8); no other `await` or signature cascade |

After this phase a SQLite application profile is still blocked by three
separate facts: node persistence is synchronous and Disk-shaped, all but one
application consumer still use the compatibility facade, and several product
capabilities require a physical Space directory. Phase 2 claims the target
module seam, not backend neutrality for the running application.

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

#### 12.2.3 Compatibility boundary and blast-radius budget

`storage/compatibility/canvas.ts` owns the current synchronous application
surface: `getCanvasStore`, cache reset, Space list/summary/create/delete,
the legacy `CanvasStore` class, and their existing result types.
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
  readonly logs: CanvasLogRepository;
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
`getCanvasStore(id)`; it does **not** add a cache of its own. The record, log,
and node adapters therefore share whatever legacy Disk object the existing
cache currently holds for that id, which is the same object the compatibility
facade resolves.

Keeping one cache in the module is deliberate. A second cache would have to be
invalidated in lockstep with the first, and `resetStorageCache()` — called on
workspace switch — clears only the legacy map, so a separately cached
composite would survive a workspace change still wrapping the previous
workspace's object. The composite is a few field assignments over an object
the existing cache already returns, so there is nothing to gain by caching it
twice.

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
until their portable contract is designed.

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
executor, or title flow as collateral work.

#### 12.2.6 `CanvasLogRepository` — scoped log contract

```ts
export interface CanvasLogRepository {
  appendEvents(events: readonly NewCanvasEvent[]): Promise<void>;
  readEvents(limit?: number): Promise<CanvasEvent[]>;
  appendDelta(entry: DeltaLogEntry): Promise<void>;
  readDeltasSince(fromVersion: number): Promise<DeltaLogEntry[]>;
  readChanges(threadId: string): Promise<CanvasChangeRecord[]>;
  appendChanges(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]>;
  removeChange(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null>;
  readIntents(): Promise<IntentEpisode[]>;
  upsertIntent(episode: IntentEpisode): Promise<void>;
}
```

`NewCanvasEvent` is the current `{ payload: RecentAction; ts?: number }`
input. The repository covers four small Canvas-owned log families; splitting
them later remains mechanical.

The contract includes their synchronization semantics rather than preserving
Disk's accidental await-free behavior:

- one `appendEvents` batch is appended contiguously and reads preserve order;
- delta versions are unique and strictly increasing per Space; a duplicate or
  older append rejects, and `readDeltasSince` returns version order;
- `appendChanges` and `removeChange` are linearizable for each Space/thread
  pair, so concurrent agents cannot lose one another's records;
- `readChanges` and the value returned by `appendChanges` are coalesced by
  canvas entity;
- `upsertIntent` is linearizable by episode id, and `readIntents` exposes the
  portable state consumed by memory analysis.

The Disk adapter enforces these guarantees with uninterrupted synchronous
legacy operations before returning each promise, under the same
non-`await` constraint and the same enforcement as §12.2.5. This is
sufficient for the supported single-Server Disk topology; a future Postgres
adapter must uphold the same behavior across connections and replicas. The
port does not expose a generic transaction callback.

Phase 2 does not redirect any log **writer**, or the memory analyzer. It
redirects one reader — the events route of §12.2.8 — so `readEvents` has a
real caller and the rest of the contract does not. The write-side contract
becomes available and testable without changing behavior, and becomes
authoritative only after the legacy mutation entry points are migrated.

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

Structural writes currently clear `CanvasStore`'s in-memory node tombstones.
That is a cross-surface Disk invariant, not a portable
`SpaceRepository` contract: phase 2 covers it in a Disk `SpaceHandle`
integration test. A later mutation phase decides how a durable Node tombstone
and a versioned Space commit interact across repositories.

The rare tombstone suppression path also consults current structural presence
inside the concrete Disk store. That direct read remains adapter-private in
phase 2 and is another reason a mixed SQLite-record/Disk-node profile is not
selectable. It must not leak onto `LegacyNodeStore` as a general record API;
the async node phase replaces it only after re-establishing the write
invariant.

#### 12.2.8 The one consumer slice

The slice is `GET /api/canvas/:canvasId/events` in `canvas.route.ts`. Its
single `store.readEvents(limit)` call becomes
`await getStructuredStore().space(canvasId).logs.readEvents(limit)`.

It is chosen for being the cheapest migration that still exercises the seam
end to end:

- the handler is already `async`, so there is no signature cascade and no new
  `await` anywhere else;
- it is a pure read with no write coordination, no CAS interaction, and no
  realtime broadcast;
- there is exactly one call site in production code;
- the response shape is unchanged, so no shared package, protocol, or web
  change follows.

The route has no test today — there is no `canvas.route.test.ts` — so the
migration commit writes one. That is a real addition rather than a free ride,
and it is worth stating plainly: without it the slice would swap the data
source of an untested handler and prove nothing. The test asserts the payload
the handler produces, so it is meaningful before and after the swap.

The Space-existence check at the top of the handler stays on the compatibility
facade. Catalogue and lifecycle are explicitly not on a portable contract in
this phase (§12.2.3), and forcing them in through the back door of one route
would expand the phase.

What the slice proves: that a repository read returns what the legacy path
returned for a real request, that the composite handle resolves for a real
`canvasId`, and that `readEvents`' limit and ordering semantics survive
contact with a caller before they are frozen. What it does not prove: anything
about writes, CAS, or single write authority — those stay adapter-local
(§12.2.3).

Two nearby routes are deliberately excluded. `GET
/:canvasId/threads/:threadId/changes` is an equally clean read and is the
natural next slice in phase 3, but "exactly one" is the point of the budget.
The `changes/:changeId/revert` route reads and then mutates, so migrating its
read would pull a write path into a phase that has no write migration.

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
  ordering that detects a critical section spanning an `await` (§12.2.5);
- `canvas-log-repository.contract.ts`: event order/tail/empty append,
  delta filtering and duplicate rejection, change coalescing, concurrent
  append/remove behavior, and intent read/insert/update/concurrent upsert.

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
pnpm --filter @sediment/server typecheck
pnpm --filter @sediment/server test
pnpm --filter @sediment/server lint
```

Implementation starts from a green baseline, and does so literally: at the
time this phase was made ready, `typecheck`, `test` (602 passing), and `lint`
(no errors) all pass on the branch. The one inherited failure is resolved and
described in §12.1.1. A red baseline must not be normalized as Phase 2 debt —
if one appears, it is fixed or explicitly rebaselined before the next commit.

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
   migrate it to `logs.readEvents` (§12.2.8).

Commit 7 is the only consumer change in Phase 2, and it is last so that
reverting it leaves the module shape intact.

### 12.3 Later phases — provisional

3. Design `SpaceCatalogRepository` and aggregate World/create/delete/title
   semantics, then migrate read-only record/log consumers in bounded domain
   slices, beginning with the thread-changes read deferred from Phase 2
   (§12.2.8). Remove direct authoritative file reads only as each owner moves;
   keep explicitly physical capabilities separate.
4. Design `NodeRepository` and `SpaceCommit` together, including which
   node mutations, deltas, and publication records land with a version/CAS
   transition. Re-establish the write-coordinator invariant for async storage,
   migrate mutation paths, and remove the legacy Canvas facade only after its
   last consumer is gone.
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
  written for them. Phase 2 buys one bounded caller against this (§12.2.8).
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

### Resolved or accepted by planned phases

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
- **Repository boundaries, partly** — `SpaceRepository` and
  `CanvasLogRepository` are accepted; catalogue/lifecycle,
  `NodeRepository`, title mutation, and `SpaceCommit` remain open.
  (P2, §12.2)
- **First repository consumer** — the events route, migrated in P2 so the
  accepted contracts have one real caller before later phases build on them.
  (P2, §12.2.8)

### Structured storage

- Is backend selection global, per Workspace, or per Space? (Process-global
  today only because the profile is read from env — that is an implementation
  default, not a decision.)
- Which Canvas-owned records belong in each L1 repository while preserving
  Agenetes ownership of Thread/Event/Turn semantics and ports?
- Does `StructuredStore` remain only a name for the configured backend family,
  with L1 and L2 retaining separate code-level port interfaces?
- What must one `SpaceCommit` atomically include?
- Are node bodies always structured records, and how are large extracted texts
  handled?
- Which query/search guarantees must be portable across Disk, SQLite, and
  Postgres? Is full-text search part of the port or a separate service?
- What is the schema migration/version negotiation model?
- What are the single-writer and crash-recovery guarantees of
  DiskStructuredStore?
- How are currently synchronous Agenetes persistence ports migrated without
  changing their persist-before-notify, sequence, and fencing semantics?
- Where do user memory, Space memory, memory-worker state, and user-authored
  skills belong?

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
- What happens to open connections on a free-mode Workspace switch? Today the
  switch resets the Space-instance cache but never rebuilds the storage
  holder, which is invisible only because both Disk adapters are stateless and
  resolve the workspace path per call.
- Can a Workspace change either backend after creation, and is migration
  online or offline?
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
  ordering, and conflict results — because a suite is only evidence where it
  actually asserts, and two adapters with opposite semantics can otherwise
  both pass it (§13);
- authoritative Space catalogue, record, and Canvas-log consumers have no
  direct physical-file fallback outside the adapter boundary;
- application services do not branch on backend kind for ordinary domain
  behavior;
- no common BlobStore consumer requires a permanent absolute path;
- accepted concurrency, CAS, and conflict contracts match across structured
  implementations; if idempotency is accepted, its semantics match too;
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

| File/dir                                                                                                                         | Responsibility                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/modules/storage/`](../../apps/server/src/modules/storage/)                                                     | Current mixed folder; Phase 2 leaves only ports, composition, adapters, compatibility, tests, and three forwarding shims (§12.2.1).                               |
| [`apps/server/src/modules/storage/ports/`](../../apps/server/src/modules/storage/ports/)                                         | The two ports and reusable suites. `blob.ts` is normative (§7.1); Phase 2 makes `structured.ts` a composite record/log boundary.                                  |
| [`apps/server/src/modules/storage/storage.ts`](../../apps/server/src/modules/storage/storage.ts)                                 | Composition root: maps a validated `StorageProfile` to adapters and holds them for the process. The lazy path must stop bypassing `init()` (§12.1.1).             |
| [`apps/server/src/modules/storage/canvas-store-cache.ts`](../../apps/server/src/modules/storage/canvas-store-cache.ts)           | Bounded LRU of legacy Disk Space objects. Sets the real limit of `space(id)` handle identity and of any in-memory state held on those objects (§12.1.1, §12.2.4). |
| [`apps/server/src/modules/storage/profile.ts`](../../apps/server/src/modules/storage/profile.ts)                                 | Two-axis backend selection from env, and the fail-fast validation hook for unsupported combinations.                                                              |
| [`apps/server/src/modules/storage/backends/`](../../apps/server/src/modules/storage/backends/)                                   | Current flat Disk adapters; Phase 2 groups all implementations under `backends/disk/`.                                                                            |
| [`apps/server/src/modules/storage/canvas-store.ts`](../../apps/server/src/modules/storage/canvas-store.ts)                       | Current mixed Disk facade; Phase 2 moves its implementation under `backends/disk/legacy/` and leaves this path as a forwarding shim.                              |
| [`apps/server/src/modules/storage/write-coordinator.ts`](../../apps/server/src/modules/storage/write-coordinator.ts)             | Current Canvas mutation coordinator; Phase 2 moves it to `modules/canvas/` without changing its synchronous node invariant (§12.2.7).                             |
| [`apps/server/src/modules/storage/paths.ts`](../../apps/server/src/modules/storage/paths.ts)                                     | Current cross-domain Disk Workspace layout; Phase 2 moves ownership to `modules/workspace/disk/` and leaves a forwarding shim.                                    |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                   | Canonical canvas command execution and current multi-file persistence sequence.                                                                                   |
| [`apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts`](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) | Current real-Disk path resolution and traversal for built-in agent file tools.                                                                                    |
| [`apps/server/src/modules/agent/acp/capabilities/fs.ts`](../../apps/server/src/modules/agent/acp/capabilities/fs.ts)             | Synthetic ACP `/space` read capability, currently not wired into the production driver.                                                                           |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                             | External-agent workload assembly, profile working directory, and RFS environment injection.                                                                       |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                         | Current external-agent file/query/execute HTTP facade.                                                                                                            |
| [`apps/server/src/modules/canvas/external-watcher.ts`](../../apps/server/src/modules/canvas/external-watcher.ts)                 | Current Disk-only external Markdown discovery.                                                                                                                    |
| [`apps/server/src/modules/agent/agenetes/drivers.ts`](../../apps/server/src/modules/agent/agenetes/drivers.ts)                   | Current file-backed Agenetes thread, event, and turn stores that need future backend adapter/composition decisions while remaining L2-owned.                      |
