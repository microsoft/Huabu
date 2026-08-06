# Multi-Backend Storage

Status: Proposed
Last updated: 2026-08-03

> **Scope and decision confidence.** This proposal records the two-port
> `StructuredStore` / `BlobStore` split and their target backend families as
> the settled direction. Exact contracts, schemas, transaction boundaries,
> migration mechanics, backend-selection scope, virtual filesystem behavior,
> agent workspace materialization, and write-back are still design space. The
> candidate interfaces and rollout sequence below are discussion aids, not
> implementation instructions.

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

| Topic                                                  | Status                | Current position                                                                                                                                                      |
| ------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate authoritative structured and blob ports       | **Settled direction** | Storage is composed from `StructuredStore` and `BlobStore`; there is no single backend interface that mixes both concerns.                                            |
| Structured backend family                              | **Settled direction** | Support Disk, SQLite, and Postgres implementations.                                                                                                                   |
| Blob backend family                                    | **Settled direction** | Support Disk and Azure Blob implementations.                                                                                                                          |
| Independent composition                                | **Settled direction** | Structured and blob choices are separate configuration axes, subject to deployment compatibility checks.                                                              |
| Concrete interface shape and async migration           | Proposed / open       | Domain-owned ports need asynchronous variants for Postgres, but the ownership and migration sequence are not fixed.                                                   |
| Exact structured repositories and aggregate boundaries | Proposed / open       | Use domain-oriented asynchronous ports; exact repository split and `SpaceCommit` boundary need design.                                                                |
| Node Markdown ownership                                | Proposed              | Keep authored node content with structured node records because it participates in revision CAS, search, and node mutation. Keep opaque and large bytes in BlobStore. |
| Blob key, staging, deletion, and GC semantics          | Proposed / open       | Prefer immutable opaque keys and streaming; lifecycle details need design.                                                                                            |
| Backend selection scope                                | Open                  | Global, per Workspace, or another scope has not been fixed.                                                                                                           |
| Logical filesystem view                                | Open                  | A possible `SpaceFileView` above both stores; name and contract are not accepted yet.                                                                                 |
| Real agent workspace                                   | Open                  | Materialized directory, OS mount, protocol-only access, or a combination remain under evaluation.                                                                     |
| Agent-authored filesystem write-back                   | Open                  | Read-only projection, explicit checkout/commit, and live bidirectional sync are alternatives, not decisions.                                                          |

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

[`CanvasStore`](../../apps/server/src/modules/storage/canvas-store.ts) currently
combines several responsibilities:

- Space catalogue, topology, version, node records, and filenames;
- Markdown/frontmatter serialization and node revision behavior;
- artifact byte paths and streams;
- intent, event, delta, and change-review persistence;
- directory creation, rename, deletion, scanning, and export assumptions.

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
- Shipping any adapter as part of accepting this proposal.

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
`SpaceRepository`, `NodeRepository`, and its Canvas event stores; Agenetes L2
remains the sole owner of its existing `ThreadStore`, `EventLogStore`, and
`TurnStore` contracts. The host composition root may select one structured
backend family and inject matching adapters into both domains, but it must not
move L2 persistence ownership back into `CanvasStore`.

As a proposed requirement, every port that may be implemented by Postgres
should become asynchronous. A synchronous Disk or SQLite implementation must
not constrain Postgres or future remote implementations. This includes an
explicit migration for Agenetes ports that are synchronous today; a blocking
compatibility facade over Postgres is not an acceptable end state.

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

The proposed common contract is stream-oriented and does not expose a
permanent local absolute path. Azure delivery URLs, local paths, and provider
SDK objects would be adapter capabilities, not domain values.

Consumers that require a filename may eventually use a separate temporary
materialization service returning a bounded lease. Whether that service belongs
to the blob adapter or an application-level cache remains open.

### 6.3 Composition

Configuration conceptually has two axes:

```ts
interface StorageProfile {
  structured: DiskStructuredConfig | SqliteConfig | PostgresConfig;
  blobs: DiskBlobConfig | AzureBlobConfig;
}
```

This shape is illustrative. Credential references, selection scope, config
storage, restart behavior, and runtime switching remain open.

Some combinations require capability validation. For example, Postgres plus a
node-local DiskBlob implementation is unsafe in a multi-replica deployment
unless the path is a deliberately shared and supported filesystem. SQLite on a
network filesystem has different correctness and availability constraints from
local SQLite. Invalid combinations should eventually fail at startup rather
than fail nondeterministically while serving data.

## 7. Candidate contracts — non-normative

These sketches exist to expose required semantics. Names, arguments, return
types, and repository boundaries may change.

```ts
interface StructuredStore {
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;

  canvas: CanvasPersistence;
}

interface CanvasPersistence {
  spaces: SpaceRepository;
  nodes: NodeRepository;
  events: CanvasEventRepository;
  commit(input: SpaceCommit): Promise<SpaceCommitResult>;
}

interface SpaceCommit {
  spaceId: string;
  expectedVersion: number;
  idempotencyKey: string;
  changes: DomainChange[];
}
```

```ts
interface BlobStore {
  put(body: Readable, options: BlobPutOptions): Promise<BlobInfo>;
  head(key: BlobKey): Promise<BlobInfo | null>;
  open(key: BlobKey, options?: BlobReadOptions): Promise<BlobRead>;
  delete(key: BlobKey, options?: BlobDeleteOptions): Promise<void>;
}
```

Questions left by these sketches include whether repositories expose snapshots
or cursors, whether blob keys are always content-addressed, whether range reads
are mandatory, and whether deletion is a public operation or a maintenance/GC
operation.

## 8. Cross-store consistency — proposed, not settled

Postgres and Azure Blob cannot share an ACID transaction. Portable behavior
must not depend on stronger accidental guarantees from Disk + Disk.

A candidate create/replace flow is:

```text
write immutable blob
  -> verify size/checksum
  -> structured transaction records metadata + reference + outbox
  -> retry or garbage-collect an unreferenced blob on failure
```

A candidate deletion flow first removes or marks the structured reference,
then deletes the blob asynchronously after a grace period. Replacement would
write a new key and atomically swap the structured reference rather than
overwrite bytes in place.

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

## 12. Provisional migration outline

This order minimizes simultaneous changes, but it is not approved as an
implementation plan.

1. Inventory every structured record, byte object, absolute-path consumer,
   external-edit behavior, and current consistency guarantee.
2. Define contract tests and introduce asynchronous ports with behavior-
   preserving Disk implementations over the current layout.
3. Move domain consumers behind StructuredStore and byte consumers behind
   BlobStore, eliminating permanent-path requirements from common code.
4. Add one new adapter at a time and run the same contract suites, migration
   fixtures, failure injection, and concurrency tests.
5. Refactor RFS and built-in file tools only after a logical file-view contract
   is accepted, if that option is chosen.
6. Prototype native CLI access separately and decide between protocol-only,
   materialization, and mounting from measured product requirements.
7. Design and implement backend migration/export/import only after source and
   destination consistency semantics are fixed.

The current on-disk format should remain readable throughout the initial port
extraction. A database adapter must not require Disk consumers to simulate
tables, and the Disk adapter must not define semantics that Postgres cannot
reproduce.

## 13. Risks

- A generic CRUD abstraction may leak backend semantics and become harder to
  use than explicit domain repositories.
- Preserving every current filesystem behavior may accidentally require SQL
  backends to emulate a directory tree as their primary model.
- Treating projections as writable without an ingest protocol may create two
  authorities and silent data loss.
- Cross-store partial failures may leak blobs or leave broken references.
- Adapter-specific capabilities may create divergent product behavior unless
  they are declared and validated.
- Synchronous legacy call sites may cause event-loop stalls or force remote
  backends behind blocking compatibility shims.
- Filename-based identity may break on rename, case-folding, or cross-platform
  export/import.
- A local projection may expose private memory/history or host paths to an
  external agent unless visibility is capability-scoped.

## 14. Open questions

### Structured storage

- Is backend selection global, per Workspace, or per Space?
- Which Canvas-owned records belong in each L1 repository while preserving
  Agenetes ownership of Thread/Event/Turn semantics and ports?
- Does `StructuredStore` remain only a name for the configured backend family,
  with L1 and L2 retaining separate code-level port interfaces?
- What are the repository and aggregate boundaries inside StructuredStore?
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

- Are blob keys content-addressed, generated IDs, or provider-neutral logical
  keys?
- Are range reads, server-side copy, conditional put, and signed delivery URLs
  required capabilities?
- Where do staging state, orphan detection, reference counts, retention, and GC
  live?
- Is an upload scratch area durable BlobStore state, leased temporary state, or
  agent-workspace state?
- How are encryption, credentials, tenancy prefixes, and Azure container
  lifecycle configured?

### Composition and migration

- Which backend combinations are supported product configurations?
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
- application services do not branch on backend kind for ordinary domain
  behavior;
- no common BlobStore consumer requires a permanent absolute path;
- accepted concurrency, CAS, and conflict contracts match across structured
  implementations; if idempotency is accepted, its semantics match too;
- injected failures between blob and structured commits have tested recovery
  behavior;
- invalid deployment combinations fail fast with actionable diagnostics;
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

| File/dir                                                                                                                         | Responsibility                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/server/src/modules/storage/`](../../apps/server/src/modules/storage/)                                                     | Current Disk storage facade, layout, naming, indexing, and write coordination.                                                               |
| [`apps/server/src/modules/storage/canvas-store.ts`](../../apps/server/src/modules/storage/canvas-store.ts)                       | Current mixed structured, document, blob-path, history, and Space lifecycle facade.                                                          |
| [`apps/server/src/modules/storage/paths.ts`](../../apps/server/src/modules/storage/paths.ts)                                     | Current physical Workspace and Space path vocabulary.                                                                                        |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)                   | Canonical canvas command execution and current multi-file persistence sequence.                                                              |
| [`apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts`](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) | Current real-Disk path resolution and traversal for built-in agent file tools.                                                               |
| [`apps/server/src/modules/agent/acp/capabilities/fs.ts`](../../apps/server/src/modules/agent/acp/capabilities/fs.ts)             | Synthetic ACP `/space` read capability, currently not wired into the production driver.                                                      |
| [`apps/server/src/modules/agent/acp/service.ts`](../../apps/server/src/modules/agent/acp/service.ts)                             | External-agent workload assembly, profile working directory, and RFS environment injection.                                                  |
| [`apps/server/src/modules/remote_fs/rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts)                         | Current external-agent file/query/execute HTTP facade.                                                                                       |
| [`apps/server/src/modules/canvas/external-watcher.ts`](../../apps/server/src/modules/canvas/external-watcher.ts)                 | Current Disk-only external Markdown discovery.                                                                                               |
| [`apps/server/src/modules/agent/agenetes/drivers.ts`](../../apps/server/src/modules/agent/agenetes/drivers.ts)                   | Current file-backed Agenetes thread, event, and turn stores that need future backend adapter/composition decisions while remaining L2-owned. |
