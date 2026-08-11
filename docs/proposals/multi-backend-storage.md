# Multi-Backend Storage

Status: Phases 1–4 implemented
Last updated: 2026-08-11

> **Scope and decision confidence.** This proposal records the two-port
> `StructuredStore` / `BlobStore` split and their target backend families as
> the settled direction. The Blob contract, the structured module/repository
> shape, the Space catalogue, and the Phase-4 structured write contracts are
> accepted. Exact SQL schemas, backend migration mechanics, backend-selection
> scope, virtual filesystem behavior, agent workspace materialization, and
> write-back are still design space. Remaining candidate interfaces below are
> discussion aids, not implementation instructions.
>
> **Implementation state.** Phase 1 merged to `main` in PR #416. `BlobStore`
> is a real backend-neutral port with a Disk adapter and a reusable contract
> suite, and artifact bytes are gone from `CanvasStore`. A 2026-08-04
> adversarial review found five defects before merge; the corrections landed
> with the phase and are described in §12.1.1.
>
> Phase 2 is specified in §12.2 and is **implemented**. `storage/` gained the
> target ports/backends/compatibility hierarchy and the first narrow
> repositories. Phase 3 is specified in §12.3 and is
> **implemented** on `feat/multi-backend-storage-phase-3`: `StructuredStore`
> now exposes a read-only `SpaceCatalogRepository`, and the Canvas list,
> Workspace World lookup, thread-change read, and memory analyzer
> record/event/intent reads use repositories. Cross-store composition also
> reads `SpaceRepository` to guard blob puts.
>
> Phase 4 is specified in §12.4 and is **implemented on the current feature
> branch, but is not yet merged**. It makes `SpaceHandle.commit()` the one
> portable authority for a Space record, zero or more node mutations, and at
> most one durable delta/publication row; makes `NodeRepository` asynchronous
> and read-only; adds lifecycle create/delete repositories, Disk crash
> recovery journals, and durable node tombstones; and routes Phase-4 HTTP/SSE
> mutations through one `CanvasCommitEvent`. The compatibility facade remains
> for Disk-only physical capabilities and legacy reads, not as a second
> structured write authority. Tasks remain a separate persistence domain and
> share lifecycle admission rather than joining a Space commit.
>
> Corrections made during implementation and adversarial review are recorded
> in place, including the CAS race ordering (§12.2.5),
> log-family interface segregation (§12.2.6), and retained-handle Workspace
> guards (§12.2.4). No SQLite, Postgres, or Azure adapter exists or is
> selectable. §12 is the authoritative phase plan; the decision table in §2
> marks what each phase has actually settled.

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

| Topic                                                  | Status                    | Current position                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate authoritative structured and blob ports       | **Accepted** (P1, merged) | Storage is composed from `StructuredStore` and `BlobStore`; there is no single backend interface that mixes both concerns.                                                                                                                                                                                                                                                        |
| Structured backend family                              | **Settled direction**     | Support Disk, SQLite, and Postgres implementations. Only Disk exists.                                                                                                                                                                                                                                                                                                             |
| Blob backend family                                    | **Settled direction**     | Support Disk and Azure Blob implementations. Only Disk exists.                                                                                                                                                                                                                                                                                                                    |
| Independent composition                                | **Accepted** (P1, merged) | `StorageProfile` has two env-parsed axes; `validateStorageProfile` fails fast on unimplemented kinds and is the extension point for combination rules. The lazy `getStorage()` path now rejects profiles whose adapters require awaited initialization (§12.1.1).                                                                                                                 |
| Blob port contract                                     | **Accepted** (P1, merged) | Connection → scope, stream-oriented, no permanent absolute path in the common contract; `materialize()` returns a bounded lease for the one consumer needing a file. Replacement atomicity and post-release lease semantics are contract terms, not adapter accidents (§6.2, §12.1.1).                                                                                            |
| Concrete interface shape and async migration           | **Accepted** (P4)         | Blob is async and backend-neutral. `StructuredStore` exposes async catalogue, lifecycle, Space-record, log, Task, and read-only node repositories. Structured aggregate mutation is available only through `SpaceHandle.commit()`. Agenetes ports and Disk-only physical capabilities remain later work.                                                                          |
| Exact structured repositories and aggregate boundaries | **Accepted** (P4)         | `SpaceCommit` atomically applies the title/state record, zero or more whole-node mutations, one global version transition, and zero or one delta/publication row. Lifecycle membership is a separate repository. Task/Run writes stay independent and share deletion admission.                                                                                                   |
| Node Markdown ownership                                | **Accepted** (P4)         | Authored node content is a structured node record. `NodeRepository` returns an opaque revision of the entire record plus logical name and duplicate metadata; writes require that revision as an aggregate-commit precondition. Opaque/large artifact bytes remain in `BlobStore`.                                                                                                |
| Blob key, staging, deletion, and GC semantics          | Proposed / open           | Names are the existing `<artifactId><ext>` keys; `deleteAll()` covers Space destruction. Staging, reference counting, and GC remain undesigned. Per-key deletion stays out of the public port, but the absence of any cleanup path is what makes atomic replace mandatory (§6.2).                                                                                                 |
| Space-handle identity and caching                      | **Corrected** (P1/P4)     | `space(id)` returning a stable object is bounded by the LRU behind it, not guaranteed. The filename index remains a cache. Node tombstones are now durable, Workspace/Space-qualified Disk metadata with a bounded expiry, so eviction or restart does not erase the anti-resurrection window.                                                                                    |
| Disk structured crash recovery                         | **Accepted** (P4)         | Space commits and lifecycle changes publish deterministic before/after payloads before changing live bytes. Startup drives uncommitted transactions to before-state and committed transactions to declared after-state. Unknown live bytes fail integrity instead of being overwritten. This is process-crash recovery, not power-loss durability or multi-process serialization. |
| Backend selection scope                                | Open                      | Process-global today because the profile is read from env. Per-Workspace or per-Space selection has not been fixed.                                                                                                                                                                                                                                                               |
| Logical filesystem view                                | Open                      | A possible `SpaceFileView` above both stores; name and contract are not accepted yet.                                                                                                                                                                                                                                                                                             |
| Real agent workspace                                   | Open                      | Materialized directory, OS mount, protocol-only access, or a combination remain under evaluation.                                                                                                                                                                                                                                                                                 |
| Agent-authored filesystem write-back                   | Open                      | Read-only projection, explicit checkout/commit, and live bidirectional sync are alternatives, not decisions.                                                                                                                                                                                                                                                                      |

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

The Disk-internal legacy `CanvasStore` still implements physical codec and
capability responsibilities used by the Disk adapters:

- `space.json`, Markdown/frontmatter, logical node filenames, and directory
  rename mechanics beneath the portable repositories;
- current Disk scans, external-file revalidation, and export/import
  assumptions.

Artifact byte paths and streams are no longer among them — phase 1 moved them
behind `BlobStore` (§12.1). Phases 2 and 3 placed repository boundaries in
front of Space records, Canvas logs, catalogue reads, and Tasks. Phase 4 adds
async node snapshots and lifecycle repositories and removes record, delta, and
node mutation methods from the portable repositories. Phase-4 Canvas mutation
paths now express the complete durable change through `SpaceHandle.commit()`;
create/delete use `StructuredStore.lifecycle()`. The compatibility facade
continues to expose Disk-only physical reads and transitional application
helpers, but it is no longer a portable structured mutation surface.

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

The two storage families and the Phase-4 Canvas structured contracts are
settled in this section. SQL schemas, backend-specific query capabilities, and
the P5+ filesystem/migration work remain open.

### 6.1 StructuredStore

`StructuredStore` is a domain persistence boundary, not a generic relational
database abstraction. Disk must be able to implement the same semantics
without pretending to support arbitrary SQL, joins, or callbacks executed
inside a database transaction.

Canvas-domain structured data includes:

- Workspace and Space catalogue records;
- Space topology, nodes, edges, geometry, and versions;
- authored node documents and node metadata;
- revisions, Disk tombstones, and mutation deltas;
- artifact metadata and references to BlobStore keys;
- Canvas-owned histories, intents, events, and outbox records where applicable.

The top-level name does not require one monolithic class. Concrete persistence
ports remain owned by their domains. L1 may own repositories such as
`SpaceRepository`, `NodeRepository`, and its Canvas log stores; Agenetes L2
remains the sole owner of its existing `ThreadStore`, `EventLogStore`, and
`TurnStore` contracts. The host composition root may select one structured
backend family and inject matching adapters into both domains, but it must not
move L2 persistence ownership back into `CanvasStore`.

Every Canvas L1 port that may be implemented by Postgres is asynchronous. A
synchronous Disk or SQLite implementation must not constrain a future remote
adapter. Agenetes still owns and must separately migrate any synchronous L2
ports; a blocking compatibility facade over Postgres is not an acceptable end
state.

**As implemented**, `StructuredStore` exposes catalogue and lifecycle
repositories plus a scoped `SpaceHandle`. The handle's Space-record, delta,
and node repositories are read-only; Canvas writes go through one aggregate
`commit()` operation. A commit accepts the expected global version, canonical
post-commit title/state, a whole-record precondition for every node mutation,
and publication metadata. It atomically advances the record once, applies
zero or more node puts/deletes, and appends zero or one delta/publication row.
It does not expose a lowest-common-denominator `withTransaction(callback)`.

This storage atomicity begins after the executor has determined the accepted
command subset. It does not change command-level partial acceptance into an
all-or-nothing command batch. Tasks and Runs also remain an independent
persistence domain: their repository shares Space-deletion admission, but a
Task record is not included in `SpaceCommit`.

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

### 7.2 StructuredStore — normative Phase-4 shape

The connection → scoped-handle shape, lifecycle outcomes, read repositories,
and aggregate write boundary are accepted and implemented for Disk. The code
in
[`ports/structured.ts`](../../apps/server/src/modules/storage/ports/structured.ts)
is authoritative when this abbreviated shape disagrees with it.

```ts
interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;

  catalog(): SpaceCatalogRepository;
  lifecycle(): SpaceLifecycleRepository;
  space(canvasId: string): SpaceHandle;
}

interface SpaceLifecycleRepository {
  create(input: SpaceCreateInput): Promise<SpaceCreateResult>;
  delete(input: SpaceDeleteInput): Promise<SpaceDeleteResult>;
}

interface SpaceHandle {
  readonly canvasId: string;
  readonly record: SpaceRepository;
  readonly events: CanvasEventRepository;
  readonly deltas: CanvasDeltaRepository;
  readonly changes: CanvasChangeRepository;
  readonly intents: CanvasIntentRepository;
  readonly tasks: CanvasTaskRepository;
  readonly nodes: NodeRepository;
  commit(input: SpaceCommitInput): Promise<SpaceCommitResult>;
}

interface SpaceRepository {
  read(): Promise<CanvasFile | null>;
}

interface NodeRepository {
  read(nodeId: string): Promise<NodeSnapshot | null>;
  readMany(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, NodeSnapshot>>;
}

interface SpaceCommitInput {
  expectedVersion: number;
  record: { title: string | null; state: CanvasFile['state'] };
  nodePreconditions: readonly NodePrecondition[];
  nodeMutations: readonly SpaceNodeMutation[];
  publication: SpaceCommitPublication;
}
```

`NodeSnapshot.revision` is an opaque token over the entire canonical record,
its logical sidecar name, and duplicate-name metadata. Every mutation has
exactly one precondition; `null` means the record must be absent. Title changes
are part of the same Space commit and keep the World/title and Disk-directory
collision outcomes explicit. `SpaceRepository`, `NodeRepository`, and
`CanvasDeltaRepository` expose no independent mutation method.

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

`deleteSpace` is the one implemented cross-store saga. It takes an exclusive
per-Space lifecycle admission and an active-Workspace lease, releases Disk
directory handles, and asks the structured lifecycle repository to refuse the
World before invoking its cleanup hook. The hook sweeps blobs while the
structured record still names them; a failure leaves that member intact and
retryable. Disk then journal-quarantines the directory. The hook also runs for
an already-missing ordinary record so a retry can remove orphaned bytes.
Retry/outbox machinery for other cross-store relationships remains open.

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

Phases 1–4 are accepted and specified below. Phase 4 is implemented on the
current feature branch but is not yet merged. Phase 5 onward keeps the
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
executor, or title flow as collateral work.

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
- `intents.upsert` is linearizable by episode id, and `intents.read` exposes the
  portable state consumed by memory analysis.

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
  ordering that detects a critical section spanning an `await` (§12.2.5);
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

`StructuredStore.catalog()` returns a fresh `SpaceCatalogRepository`:

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

### 12.4 Phase 4 — aggregate structured writes and Disk recovery — **implemented**

Phase 4 makes the portable storage boundary authoritative for Canvas
structured mutation. It is implemented on the current feature branch but is
not yet merged. The phase deliberately stays Disk-only: it fixes the contract
and proves the Disk adapter against reusable node, commit, lifecycle, recovery,
and mutation-route tests; it does not claim that a second adapter or a
multi-process deployment is ready.

#### 12.4.1 Read-only nodes and whole-record revisions

`SpaceHandle.nodes` is an asynchronous, read-only `NodeRepository`:

```ts
interface NodeRepository {
  read(nodeId: string): Promise<NodeSnapshot | null>;
  readMany(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, NodeSnapshot>>;
}
```

A snapshot carries the canonical `NodeContent`, a single-segment logical name,
duplicate-name metadata when present, and an opaque `NodeRecordRevision`.
Disk derives that token from canonicalized whole-record data, logical name,
and duplicates. The token therefore changes for authored content, derived
metadata, type/label changes, filename changes, and duplicate state. Callers
may compare or retain it; they must not parse or synthesize it.

Mutation is intentionally absent from the repository. Every put/delete names
one node and has exactly one whole-record precondition in `SpaceCommitInput`;
`null` means the node must remain absent. This replaces content-only revision
checks as the storage OCC boundary without changing the existing narrower
HTTP authored-content revision exposed to editors.

#### 12.4.2 One Space commit authority

`SpaceHandle.commit()` is the only portable authority for record, node, and
delta/publication mutation. One input contains:

- the observed global Space version;
- the canonical post-commit title and full state;
- zero or more node puts/deletes and their exact whole-record preconditions;
- originator, optimistic-echo, command, structural-delta, and optional run
  publication metadata.

One successful changed commit atomically applies the title/state record, all
effective node mutations, exactly one global version transition, and exactly
one delta row containing the canonical publication. It returns the committed
record, post-commit node snapshots, and the same `CanvasCommitEvent` later
used on the wire. A default semantic no-op returns `committed: false`, does not
advance the version, and appends no row. An absent delete may still establish
the backend tombstone without becoming a visible commit.

The record and node baselines are checked both before work and in the final
Disk critical section. Conflicts distinguish missing Space, global version,
node revision, a node put missing from or disagreeing in type with the
post-commit topology, duplicate/logical-name collision, suppressed late
write, title collision, and forbidden World title. A title change and its
physical Disk directory rename participate in the same recovery boundary.

Application serialization and Workspace identity are separate fences around
that storage OCC. Every `withCanvasMutex()` invocation acquires an active
Workspace operation lease before joining its Workspace/Space-qualified queue
and holds it until the queued task settles. The executor's outer workflow lease
also covers artifact import and image normalization before the mutex. The
preprocess route/dispatcher similarly pins route preflight, asynchronous
pipeline work, Persist, and its final check. Runtime activation of a different
Workspace rejects while any such operation is live, so neither pre-mutex work
nor queued work can resume against a new root.

The topology/sidecar check is an adapter invariant, not only route hygiene.
Content PUT also rejects a stale node type or missing topology entry before
writing. Before asynchronous preprocessing begins, route preflight captures
the exact topology-owned type, global Space version, and whole-record node
revision under the Canvas mutex; that same baseline is passed into the
dispatcher, not replaced by a later read. Persist and the final dispatcher
observation suppress the result if any component changed, including a
same-type delete/recreate or edit. A late content write after remote deletion
returns a recoverable conflict rather than claiming that suppressed bytes were
durably saved. The final guard also covers cache short-circuits and
`allowPersistence:false` runs, which do not reach Persist.

Sidecar deletion is derived separately from outward topology deletion. If a
Markdown-backed node becomes non-Markdown under the same id, structural PUT,
the executor, and apply-delta keep the id in topology but delete its old
sidecar in the same aggregate. Conversely, an inserted topology id is read
rather than assumed absent: structural PUT attaches an existing same-type
orphan unchanged with its exact revision, rejects an incompatible orphan type,
and lets duplicate or concurrent sidecar changes fail normal whole-record OCC.
Executor/apply-delta insertion uses the same explicit orphan read when building
its mutation preconditions.

Every effective node-only or structure-changing commit advances the one global
Space version exactly once. `structureRevision` is a separate opaque hash of
the slim title/topology projection. A structural save may therefore rebase
over intervening node-only global versions when its structure baseline still
matches, while a stale structural baseline conflicts. Node-content fields are
not accepted back through the structural PUT, so a stale topology save cannot
clobber an independently committed sidecar.

#### 12.4.3 Disk transaction journal and durable tombstones

Disk commits publish an immutable deterministic undo/redo manifest under
Workspace-owned metadata before touching live Space bytes. It carries exact
before and after bytes for the Space record and affected sidecar paths, the
optional directory transition, the exact delta-log length/prefix hash, and the
exact append bytes. The adapter repairs a final malformed JSONL crash fragment
before fixing that prefix. Lifecycle create/delete use the same deterministic
format for their declared directory and file transitions.

Watcher handles are released before the aggregate's final synchronous record
and node OCC checks and deterministic filename plan. The journal is prepared
only after they pass. Before its first live mutation, the committer rechecks
the directory source/destination, exact record baseline, every whole-node
revision, filename plan, and raw journal before-state. Drift during journal
publication discards the still-unapplied journal without replaying stale
before-bytes. For a title change, rename is the first durable mutation; a
rename failure also discards the unapplied journal and returns the typed
not-found or title conflict. The declared delta append and deterministic file
apply then run without a promise boundary.

If a live operation fails after mutation but before its commit marker, abort
drives the transaction to its exact before-state; once marked committed,
cleanup cannot reverse the decision. Workspace preparation calls
`recoverDiskTransactions()` before normal use. Recovery drives an uncommitted
deterministic journal to before-state and a committed journal to its declared
after-state, then removes transaction residue. Live bytes that match neither
state, an unknown append tail, unsafe paths, or corrupt recovery metadata stop
recovery rather than being overwritten. This is restart safety for a process
crash. It deliberately does **not** claim power-loss durability (directories
are not fsynced) or serialization between Server processes.

Node deletion writes a Workspace/Space-qualified, expiring tombstone under
`.huabu/tombstones/`. It survives the bounded `CanvasStore` LRU and a Server
restart, preventing a content PUT or preprocess job that began before deletion
from resurrecting the sidecar. Tombstone transitions are captured and restored
with aggregate rollback, cleared by an authoritative absent-to-present insert,
and removed best-effort when the whole Space is deleted. Restart-loaded expiry
is scheduled immediately; empty-scope caching is bounded, and cleanup I/O
failures stay contained and retry with capped backoff.

#### 12.4.4 Lifecycle ownership and admission

`StructuredStore.lifecycle()` owns portable membership outcomes:

- create journal-publishes one catalogue member together with its empty
  version-0 record, returns the effective de-duplicated Disk title, and gives a
  same-id race one winner;
- delete returns `deleted`, `not-found`, or `world-forbidden`, invokes the
  independent blob cleanup while the record still exists, then
  journal-quarantines the Disk directory.

Composition holds an active-Workspace lease and a writer-preferring,
process-local per-Space admission. Create/delete are exclusive; blob puts,
Space commits, Task writes, and remaining Canvas log mutations share mutation
admission. A mutation that begins once deletion is active or queued rejects
instead of resuming against a removed Space. Reads are not gated. This is a
single-Server Disk guarantee, not distributed locking.

Tasks and Runs deliberately remain outside `SpaceCommit`. Their independently
atomic repository and the Canvas topology can still leave the explicit orphan
outcomes documented in Canvas Storage Architecture; sharing deletion
admission prevents a Task write from racing past Space destruction without
inventing a cross-domain transaction.

#### 12.4.5 Mutation adoption and canonical publication

The Canvas content PUT, structural PUT, node delete, preprocess persistence,
and executor/apply-delta paths express their durable record/node/delta change
through `SpaceHandle.commit()`. Intent and change-review writers use their
async repositories. Task and remaining Canvas-log writers use their own
repository contracts under the same lifecycle admission. Raw Disk operations
remain inside adapters and Disk-only capabilities; the obsolete public
record CAS, delta append, synchronous `LegacyNodeStore`, and Canvas
write-coordinator mutation helpers are removed.

New Markdown-backed nodes use the structural PUT as their aggregate-create
boundary: topology and the first sidecar record land together. The web
content/preprocess queues hold that node until the structural acknowledgement,
adopt the exact server content revision and effective label, then flush an edit
made while create was in flight. Deleting the local node before acknowledgement
cancels the held work instead of issuing a late sidecar/preprocess request.

`CanvasCommitEvent` is the canonical Phase-4 publication envelope. It carries
server-minted `commitId`, exact `fromVersion`/`toVersion`, post-commit
`structureRevision`, originator and optimistic flags, structural consequences,
and per-node `inline`, `invalidate`, or `delete` changes. Inline UI projections
are capped at 64 KiB of UTF-8 JSON; larger records produce an invalidation and
are fetched through the node-content endpoint. Executor command echoes are
projected to slim public fields. Full change-review inverse data remains in its
repository; realtime carries a bounded `changesInvalidated` signal that makes
the client refetch the affected thread rather than embedding the accumulated
inverse history in SSE.

Durability precedes notification. Migrated mutation HTTP responses carry the
same commit envelope (with a compact mutation acknowledgement retained for
compatibility), and the Server publishes it on Canvas SSE only after the
aggregate is committed. The web client runs HTTP and SSE through one
`commitId`/version gate: whichever arrives first advances the cursor; the
other is a duplicate. It suppresses same-tab optimistic echoes, applies
non-optimistic node/preprocess results once, refetches invalidations, detects a
version gap, and preserves unsaved local structure instead of installing a
remote structure as its next OCC baseline. A non-committing preprocess result
carries the `observedVersion` from its exact final baseline check; the web
applies legacy projection fields only if its local cursor still equals that
version. An intervening commit therefore drops the stale projection, while a
committing result is ordered through its normal event.

Canvas SSE listener maps are qualified by resolved Workspace path plus
`canvasId`; a subscription and its unsubscribe retain the originally captured
key, so a reused id in another active Workspace cannot receive or inherit its
events. The SSE route subscribes before it emits the initial snapshot and
buffers intervening commits; the client reconnects with snapshot catch-up and
buffers adjacent gaps before falling back to a dirty-state-safe reload.

#### 12.4.6 Compatibility debts and explicit non-goals

Two historical Canvas-PUT behaviors remain intentionally visible:

1. a version-0 PUT for a missing id implicitly creates the empty Space through
   lifecycle before committing topology; if the second step fails, the empty
   v0 member remains visible rather than leaving torn bytes;
2. an accepted structural PUT uses temporary `forceVersionBump`, so even an
   unchanged autosave advances the global version once. The default
   `SpaceCommit` no-op behavior remains no version/no publication.

Both are marked as compatibility debt in code and here. The repository's
GitHub Issues feature was disabled when Phase 4 was implemented, so no issue
number could be created; removal must be tracked in the next enabled project
tracker rather than implied to be complete.

Phase 4 does **not** select SQLite, Postgres, or Azure; add idempotency keys or
a durable outbox; make the Disk journal power-loss safe or multi-process;
migrate Agenetes persistence; design a logical filesystem; change RFS,
external watchers, export/import, or native agent workspaces; or resolve
online backend migration. Those remain P5+ work below.

### 12.5 Later phases — provisional

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
  written for them. Phases 2–4 exercise bounded reads, lifecycle, aggregate
  writes, and mutation routes against the accepted shapes.
- Disk's physical layout for a Space is derived from a mutable title-derived
  directory name, so a blob scope's location moves on rename while its
  `canvasId` does not. No other backend reproduces this.
- Treating projections as writable without an ingest protocol may create two
  authorities and silent data loss.
- Cross-store partial failures may leak blobs or leave broken references.
- Adapter-specific capabilities may create divergent product behavior unless
  they are declared and validated.
- Remaining Disk-only filesystem capabilities may cause event-loop stalls or
  block a non-Disk profile until they gain an explicit capability boundary.
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
- **Repository and aggregate boundaries** — catalogue, lifecycle, Space
  record, read-only node, event, delta, change, intent, and Task repositories
  are accepted. Record/node/delta mutation belongs only to
  `SpaceHandle.commit()`; Task/Run mutation stays separate. (P2–P4,
  §§12.2–12.4)
- **Node OCC** — a backend-issued opaque revision covers the entire canonical
  node record, logical name, and duplicate metadata. Each aggregate node
  mutation supplies exactly one precondition. (P4, §12.4.1)
- **Lifecycle writes** — create atomically publishes membership plus an empty
  v0 record; delete has explicit outcomes and preserves the blob-first saga.
  (P4, §12.4.4)
- **Disk crash recovery** — manifest-first deterministic before/after recovery
  covers aggregate commits and lifecycle create/delete; unknown live bytes
  fail integrity instead of being overwritten. Durable expiring tombstones
  cover late node writers. Power loss and multi-process coordination remain
  open. (P4, §12.4.3)
- **Process-local workflow fencing** — Workspace operation leases cover
  pre-mutex executor/preprocess work and the full wait/run lifetime of each
  Workspace/Space-qualified Canvas mutex task. Canvas SSE channels use the
  same Workspace/Space qualification. (P4, §§12.4.2, 12.4.5)
- **Mutation publication** — changed commits advance the global version once;
  `structureRevision` separates topology OCC; HTTP and SSE share one
  `CanvasCommitEvent` ordering/deduplication path, while a non-committing
  preprocess projection carries an `observedVersion` client guard. (P4,
  §§12.4.2, 12.4.5)
- **Bounded repository consumers** — the events route landed in P2; P3 added
  the Canvas list, Workspace World lookup, thread-change read, and memory
  record/event/intent reads. (P2–P3, §§12.2.8, 12.3.3)

### Structured storage

- Is backend selection global, per Workspace, or per Space? (Process-global
  today only because the profile is read from env — that is an implementation
  default, not a decision.)
- Which Canvas-owned records belong in each L1 repository while preserving
  Agenetes ownership of Thread/Event/Turn semantics and ports?
- Does `StructuredStore` remain only a name for the configured backend family,
  with L1 and L2 retaining separate code-level port interfaces?
- Should very large extracted text remain inline in structured node records or
  gain a separately streamed structured capability? Phase 4 keeps it in the
  record and uses SSE invalidation rather than broadcasting large projections.
- Which query/search guarantees must be portable across Disk, SQLite, and
  Postgres? Is full-text search part of the port or a separate service?
- What is the schema migration/version negotiation model?
- What distributed admission/locking and publication mechanism replaces the
  current process-local Disk mutexes for multi-Server Postgres deployments?
- Does a supported Disk deployment require power-loss durability beyond the
  current process-crash journal, including file and directory fsync?
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

| File/dir                                                                                                                                     | Responsibility                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/modules/storage/`](../../apps/server/src/modules/storage/)                                                                 | Ports, composition, Disk adapters, compatibility, and reusable contracts — the canonical Phase-4 storage tree, guarded by `module-boundaries.test.ts`.                                   |
| [`apps/server/src/modules/storage/ports/`](../../apps/server/src/modules/storage/ports/)                                                     | The two ports; `structured.ts` owns catalogue/lifecycle, scoped read repositories, Task storage, whole-node revisions, and aggregate commit. Reusable suites live in `ports/contracts/`. |
| [`apps/server/src/modules/storage/storage.ts`](../../apps/server/src/modules/storage/storage.ts)                                             | Composition root: maps a validated `StorageProfile` to adapters and holds them for the process. The lazy path rejects profiles whose adapters require awaited `init()` (§12.1.1).        |
| [`.../storage/backends/disk/legacy/canvas-store-cache.ts`](../../apps/server/src/modules/storage/backends/disk/legacy/canvas-store-cache.ts) | Bounded LRU of legacy Disk Space objects. The single owner both the adapter and the facade resolve through, and the real limit of `space(id)` identity (§12.2.4).                        |
| [`apps/server/src/modules/storage/profile.ts`](../../apps/server/src/modules/storage/profile.ts)                                             | Two-axis backend selection from env, and the fail-fast validation hook for unsupported combinations.                                                                                     |
| [`apps/server/src/modules/storage/backends/disk/`](../../apps/server/src/modules/storage/backends/disk/)                                     | Disk implementations, including `node-repository.ts`, `space-commit.ts`, `space-lifecycle.ts`, and `transaction-journal.ts`; physical codecs remain under `legacy/`.                     |
| [`.../storage/compatibility/canvas.ts`](../../apps/server/src/modules/storage/compatibility/canvas.ts)                                       | Transitional Disk facade for `getCanvasStore`, full-record listing, and old create/delete signatures. Lifecycle wrappers delegate to the portable composition service.                   |
| [`apps/server/src/modules/agent/memory/analyzer.ts`](../../apps/server/src/modules/agent/memory/analyzer.ts)                                 | P3 repository consumer for strict Space existence, bounded action events, and intent episodes; physical chat and memory files remain Disk-specific.                                      |
| [`apps/server/src/modules/workspace.ts`](../../apps/server/src/modules/workspace.ts)                                                         | Active-Workspace operation leases and runtime-switch rejection while leased workflows remain in flight.                                                                                  |
| [`apps/server/src/modules/canvas/canvas-mutex.ts`](../../apps/server/src/modules/canvas/canvas-mutex.ts)                                     | Workspace/Space-qualified application serialization whose lease covers queue wait and task execution; durable authority remains `SpaceHandle.commit()`.                                  |
| [`apps/server/src/modules/canvas/canvas-sync.ts`](../../apps/server/src/modules/canvas/canvas-sync.ts)                                       | Workspace/Space-qualified in-memory publication channels used by Canvas SSE.                                                                                                             |
| [`apps/server/src/modules/workspace/disk/`](../../apps/server/src/modules/workspace/disk/)                                                   | Cross-domain physical Workspace layout: paths, canvas dirs, naming, name index, dir handles, World bootstrap. `storage/paths.ts` forwards here.                                          |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                               | Canonical command execution; accepted state/node changes are persisted through aggregate commit before realtime publication.                                                             |
| [`apps/server/src/modules/preprocessing/dispatcher.ts`](../../apps/server/src/modules/preprocessing/dispatcher.ts)                           | Exact topology/version/record preprocessing baseline, workflow lease, final supersession, and noncommit observed version.                                                                |
| [`packages/shared/src/types/api/canvas-sync.ts`](../../packages/shared/src/types/api/canvas-sync.ts)                                         | Canonical `CanvasCommitEvent`, mutation acknowledgement, inline/invalidate node-change policy, and sync wire schema.                                                                     |
| [`apps/web/src/store/canvasCommitSync.ts`](../../apps/web/src/store/canvasCommitSync.ts)                                                     | Shared HTTP/SSE commit ordering, deduplication, version-gap detection, and optimistic-echo policy.                                                                                       |
| [`apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts`](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)             | Current real-Disk path resolution and traversal for built-in agent file tools.                                                                                                           |
| [`apps/server/src/modules/agent/acp/capabilities/fs.ts`](../../apps/server/src/modules/agent/acp/capabilities/fs.ts)                         | Synthetic ACP `/space` read capability, currently not wired into the production driver.                                                                                                  |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                                         | External-agent workload assembly, profile working directory, and RFS environment injection.                                                                                              |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                                     | Current external-agent file/query/execute HTTP facade.                                                                                                                                   |
| [`apps/server/src/modules/canvas/external-watcher.ts`](../../apps/server/src/modules/canvas/external-watcher.ts)                             | Current Disk-only external Markdown discovery.                                                                                                                                           |
| [`apps/server/src/modules/agent/agenetes/drivers.ts`](../../apps/server/src/modules/agent/agenetes/drivers.ts)                               | Current file-backed Agenetes thread, event, and turn stores that need future backend adapter/composition decisions while remaining L2-owned.                                             |
