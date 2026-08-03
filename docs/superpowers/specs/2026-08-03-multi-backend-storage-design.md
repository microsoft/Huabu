# Multi-Backend Storage — Phase 1 Design

Status: Accepted
Date: 2026-08-03
Implements: the **settled direction** of
[docs/proposals/multi-backend-storage.md](../../proposals/multi-backend-storage.md)

---

## 1. Scope

The proposal marks exactly four rows as settled direction:

1. Storage is composed from two authoritative ports, `StructuredStore` and
   `BlobStore`; no single interface mixes both concerns.
2. Structured backend family: Disk, SQLite, Postgres.
3. Blob backend family: Disk, Azure Blob.
4. Structured and blob choices are independent configuration axes, subject to
   deployment compatibility checks.

This phase implements that split with Disk adapters only. It ships **no**
SQLite, Postgres, or Azure code. Everything the proposal marks *open* —
repository boundaries, `SpaceCommit`, async migration of Agenetes ports, the
logical file view, agent workspace materialization, blob GC — stays open.

### Out of scope, and deliberately so

These remain Disk-coupled after this phase. They are the proposal's open
`SpaceFileView` question (§10), and pulling them in would exceed the
blast-radius budget:

- `modules/agent/tools/handlers/fs-sandbox.ts` and `fs-read.ts` — built-in
  agent file tools that walk the real Space directory, including `.artifacts/`.
- `modules/agent/acp/capabilities/fs.ts` — the synthetic `/space` read
  capability.
- `modules/canvas/canvas.route.ts` export/import, which globs the whole Space
  directory into an archive.

After this phase, **domain code is blob-backend-neutral; the agent filesystem
surface is not.** That is a stated limitation, not an oversight.

## 2. Shape

The connection is the primary object. Scopes are derived from it. Blob storage
is not canvas-specific — canvas scoping is one derived view, and other scope
kinds can be added without touching the connection.

```text
StorageProfile ── createStorage() ──┬── StructuredStore ──.space(id)──> CanvasStore
                                    └── BlobStore       ──.scope(ref)─> BlobScope
```

`StorageHealth`, shared by both ports, lives in `modules/storage/ports/common.ts`
so neither port has to import the other.

### 2.1 Blob port — `modules/storage/ports/blob.ts`

```ts
export type BlobBackendKind = 'disk' | 'azure';

/** Identifies a bounded namespace of blobs within a connection. */
export type BlobScopeRef = { kind: 'canvas'; canvasId: string };

export interface BlobInfo {
  /** Scope-relative name, e.g. `artifact_abc123.png`. */
  name: string;
  size: number;
  mimeType: string | null;
  /** Last modification time, ms since epoch. */
  updatedAt: number;
}

export interface BlobPutOptions {
  mimeType?: string | null;
}

/** Inclusive byte offsets, matching HTTP Range semantics. */
export interface BlobRange {
  start?: number;
  end?: number;
}

export interface BlobRead {
  info: BlobInfo;
  body: Readable;
}

/**
 * A temporary real filesystem path for a blob, valid only until
 * `release()`. Disk returns its own storage path with a no-op release;
 * remote backends spool to a temp file and unlink on release.
 */
export interface BlobLease {
  readonly path: string;
  release(): Promise<void>;
}

/** A bounded namespace of blobs — the read/write surface. */
export interface BlobScope {
  put(name: string, body: Readable | Buffer, options?: BlobPutOptions): Promise<BlobInfo>;
  head(name: string): Promise<BlobInfo | null>;
  open(name: string, range?: BlobRange): Promise<BlobRead | null>;
  read(name: string): Promise<Buffer | null>;
  list(): Promise<BlobInfo[]>;
  materialize(name: string): Promise<BlobLease | null>;
  /** Remove every blob in this scope. Used when a Space is destroyed. */
  deleteAll(): Promise<void>;
}

/** A connection to a blob backend. Process-wide; scopes are derived. */
export interface BlobStore {
  readonly kind: BlobBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  scope(ref: BlobScopeRef): BlobScope;
}
```

`BlobScopeRef` is a one-member union today. New scope kinds extend the union
without changing the connection interface.

Rather than putting both `scope()` and a `canvas()` convenience on the
interface, `storage.ts` exports a free helper:

```ts
export function canvasBlobs(canvasId: string): BlobScope;
```

**`list()` exists because of a real consumer**, not for symmetry:
`canvas.route.ts` currently calls `resolveArtifactFilePath` once per node
during hydration. One `list()` replaces N stat calls, and maps to a single
list-by-prefix on Azure rather than N round-trips.

**No `AsyncDisposable`.** The repo targets ES2020, so `await using` is
unavailable without a global tsconfig bump. `BlobLease.release()` is used with
`try/finally`.

**No single-key `delete()`.** Nothing in the codebase deletes an individual
artifact today; artifacts only disappear when the whole Space directory is
removed. `deleteAll()` covers that one real case. Adding per-key deletion
without a GC/reference-counting design would be speculative, and the proposal
marks blob lifecycle explicitly open.

**Name semantics.** `name` is the bare `<artifactId><ext>` string that is
already the URL key and node `src` value, so nothing downstream re-encodes.
Names are normalized with `path.basename()` and rejected when empty, `.`, or
`..` — byte-for-byte the contract `paths.ts::artifactPath()` enforces today, so
there is no behavior change. Every adapter applies the same normalization.

### 2.2 Structured port — `modules/storage/ports/structured.ts`

```ts
export type StructuredBackendKind = 'disk' | 'sqlite' | 'postgres';

export interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  space(canvasId: string): SpaceHandle;
}
```

`SpaceHandle` is `CanvasStore` in this phase.

This is stated plainly because the naming would otherwise overclaim:
`StructuredStore` is a real **lifecycle and backend-selection boundary**, but
it is **not yet a backend-neutral data contract**. Narrowing `SpaceHandle` into
async repositories (`SpaceRepository`, `NodeRepository`, `CanvasEventRepository`)
is the next phase. Defining those interfaces now, with zero consumers and two
ways to read a Space, would be the worse error.

What this phase *does* deliver on the structured side is the removal of blob
concerns from `CanvasStore` — which is what actually makes good on "no single
interface mixes both concerns".

### 2.3 Composition — `modules/storage/profile.ts`, `storage.ts`

```ts
export interface StorageProfile {
  structured: { kind: StructuredBackendKind };
  blobs: { kind: BlobBackendKind };
}
```

Parsed from `HUABU_STRUCTURED_BACKEND` and `HUABU_BLOB_BACKEND`, both
defaulting to `disk`. `validateStorageProfile()` rejects kinds that are named
but not implemented, with an error naming the supported set — so
`HUABU_BLOB_BACKEND=azure` fails at startup with a clear diagnostic instead of
failing confusingly on first upload. The function is the documented extension
point for combination rules (e.g. Postgres + node-local DiskBlob across
replicas).

`getBlobStore()` / `getStructuredStore()` read a module-level holder,
lazily initializing from env on first use. `initStorage()` is called at server
boot so misconfiguration fails fast; it is the same code path, so tests and
scripts that never call it still work.

**No reset/teardown wiring.** Disk adapters resolve through `getWorkspacePath()`
lazily per operation, exactly as `canvasRoot()` does today, so a free-mode
workspace switch needs no invalidation. Adding a reset hook now would be
speculative machinery.

## 3. Consumer migration

| Consumer | Today | Becomes |
| --- | --- | --- |
| `artifact.route` upload | `writeArtifactStream` | `put(name, data.file, { mimeType })` |
| `artifact.route` serve | `reply.sendFile(name, artifactsDir())` | `open(name)` → stream body + headers |
| `artifact.route` mhtml | `resolveArtifactFilePath` + `readFile` | `read(name)` |
| `artifact.route` clone | resolve + `readFile` + `writeArtifactBuffer` | `src.read` → `dst.put` |
| `canvas.route` hydrate | N× `resolveArtifactFilePath` | 1× `list()` → predicate |
| `canvas-executor` aspect ratio | `artifactPath` + `existsSync` + 64KB fd read | `open(name, { end: 65535 })` |
| `snapshot-nodes` (3 sites) | resolve + `readFile` + `writeArtifactBuffer` | `head` / `read` / `put` |
| `image-inlining` | resolve → `readFile` | `read(name)` |
| `attachments` | resolve → `readFile` utf-8 | `read(name)` → `toString('utf-8')` |
| `image-generation` | resolve → `readFile` → `toFile` | `read(name)` → `toFile` |
| `import-node-src` | `artifactsDir()` + `writeArtifactBuffer` | `put` + `head`-based containment check |
| `preprocessing/extract` | resolve → `loader.load(path)` | `materialize(name)` + `try/finally release()` |
| `CanvasStore.destroy()` | `rm -rf` Space dir | also `deleteAll()` on the Space's blob scope |

`canvas.route`'s `hydrateOneNode` stays **synchronous**. The batch path
(`hydrateNodeContent`) does one `await list()` and passes a
`(key) => boolean` predicate down. This is a performance improvement over
today's per-node `existsSync`.

`preprocessing` is the only consumer that genuinely needs a real filename —
its document loaders take a path (`loader.load(filePath)`). Everything else
only wanted bytes.

### CanvasStore strip

Removed: `artifactsDir`, `artifactPath`, `writeArtifactStream`,
`writeArtifactBuffer`, `resolveArtifactFilePath`, and the `ArtifactRecord` /
`WriteArtifactInput` types.

`paths.ts`'s `artifactsDir()` / `artifactPath()` survive as internals of
`DiskBlobStore` — and remain used by the out-of-scope agent fs tools.

## 4. Testing

A reusable contract suite, `ports/blob-store.contract.ts`, exporting
`describeBlobStoreContract(name, factory)`. Run against `DiskBlobStore` now;
reusable verbatim against Azure later. This is the proposal's §15 requirement
("the same contract suites pass against every claimed implementation").

Covers: round-trip `put`/`read`; stream and Buffer bodies; `head` on missing
key → `null`; `open` with and without range; `list` contents and empties;
`materialize` path readability plus `release()`; `deleteAll`; name
normalization and rejection of `.` / `..` / empty.

Existing tests touching artifact APIs — `canvas-executor.test.ts`,
`import-node-src.test.ts`, `acp/capabilities/fs.test.ts` — are updated to the
new surface.

## 5. Commit sequence

1. `docs:` this spec.
2. `feat(server):` ports, Disk adapters, profile, storage holder, contract tests.
3. `refactor(server):` migrate blob consumers, strip artifact methods from
   `CanvasStore`, update affected tests.

Each commit leaves `pnpm --filter @sediment/server typecheck test lint` green.

## 6. What this explicitly does not claim

- No backend other than Disk exists or is proven.
- `StructuredStore` is a selection/lifecycle boundary, not a portable data
  contract; `SpaceHandle` is still `CanvasStore`.
- The agent filesystem surface and Space export/import remain Disk-coupled.
- Blob GC, staging, reference counting, and cross-store consistency are
  untouched — no consumer needs them yet.
