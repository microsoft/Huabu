# Move Selected Nodes and Frames Between Spaces

Status: Proposed

Last updated: 2026-09-01

Tracking issue: [#142](https://github.com/microsoft/Huabu/issues/142)

> **Scope.** This proposal adds the smallest complete user-facing operation for moving selected Canvas nodes and Frame subtrees between existing ordinary Spaces in the active Workspace. It includes moving an eligible Agent Node's existing conversation identity instead of resetting or copying it. It deliberately does not introduce a general multi-Space transaction API, filesystem WAL, crash recovery, Blob reference counting, garbage collection, or multi-backend transaction protocol.

> **Reliability boundary.** The operation provides user-visible all-or-compensated behavior while the Server process continues running and returns a determinate result. Process termination, power loss, and an unknown remote-backend outcome remain outside #142, matching the current `SpaceHandle.write()` contract.

## 1. Problem

Huabu can copy a selection through the clipboard and paste it into another Space, but that path is UI-owned reconstruction rather than a move operation. It expands selected Frames, remaps hierarchy and internal edges, and clones cross-Space artifacts, then leaves source deletion to a separate user action. Its conversation-fork request is also currently unavailable because a generic copy does not provide the complete target Agent workload.

That behavior is insufficient for moving work because it has no explicit Move semantic, destination picker, authoritative Server-side selection expansion, coordinated source deletion, or reliable artifact handling. Artifact cloning is intentionally best-effort during paste, so a failed clone may leave a pasted node with a missing-artifact placeholder.

Resetting an Agent Node on move would also violate the user's expectation that moving work preserves it. A move has enough authoritative context to retain the existing `threadId`, workload record, driver state, and conversation logs while changing their owning Space. This is narrower than conversation copy: no second independently continuing Agent is created and no target workload identity must be invented.

The storage layer now provides the primitives needed to implement the business operation without redesigning storage: ordinary Space lifecycle, complete Space records, `SpaceNodes.readMany()`, Blob reads and writes, version-checked `SpaceHandle.write()`, and in-process rollback for each rejected Space write. It does not provide a transaction spanning two Spaces or structured and Blob stores.

## 2. Decision

Add one Server-owned `SpaceMoveService` and one HTTP execution endpoint. The web gathers the current selection, lets the user choose an existing destination, shows a compact confirmation, drains pending writes, and submits selected root IDs plus the destination Space ID.

The Server re-reads authoritative source and destination state, expands Frame subtrees, allocates fresh destination node and edge IDs, clones required artifacts, rehomes eligible Agent conversations, executes the destination insertion and source deletion while holding both Canvas locks, and delays both Canvas Sync publications until the operation succeeds.

If a determinate failure occurs after the destination write, the service compensates the Agent rehome and destination insertion before releasing the locks. This is application-level coordination over the current single-Space and Agenetes store guarantees, not a new portable storage transaction contract.

## 3. Goals

- Move one or more selected ordinary Canvas nodes into an existing ordinary Space.
- Treat selected Frames as subtree roots and preserve every descendant exactly once.
- Preserve parent-child hierarchy, parent-local child geometry, root-to-root relative geometry, node style, Frame layout data, and internal edge style.
- Omit edges that cross the transfer boundary and report them explicitly.
- Clone only artifacts referenced by transferred nodes and rewrite those references for the destination.
- Preserve an eligible Agent Node's `threadId`, complete workload record, driver state, folded turns, and event log while changing the owning Space.
- Avoid overwriting destination nodes, edges, sidecars, and artifacts by allocating fresh IDs and de-duplicating labels.
- Keep source nodes unchanged when validation or destination preparation fails.
- Compensate a completed destination insertion when the following source deletion returns a determinate failure.
- Publish no intermediate Canvas Sync state.
- Return an actionable result containing the destination, moved roots and descendants, preserved edges, omitted boundary edges, label changes, and moved Agent conversations.

## 4. Non-goals

- A reusable transaction spanning arbitrary Spaces or storage aggregates.
- ACID guarantees across `StructuredStore` and `BlobStore`.
- Recovery after process termination, power loss, or an unknown backend outcome.
- A filesystem WAL, two-phase commit protocol, transactional outbox, or idempotency ledger.
- Per-key Blob deletion, artifact reference counting, orphan collection, or general Blob GC.
- Moving nodes across Workspaces.
- Creating a destination Space as part of the move flow.
- Moving the World Canvas or managed World projection/reference nodes.
- Moving Tasks, Runs, pending change-review records, Canvas event history, permissions, or unrelated nearby content.
- Copying or forking Agent conversations.
- Moving a running Agent, a Task/Run root Agent, or an Agent with pending change-review records.
- Replacing or changing Huabu clipboard copy/paste.

## 5. User experience

Both the single-selection and multi-selection floating toolbars expose **Move to Space** for movable ordinary nodes. The action is unavailable for `spacePreview`, `canvasRef`, `frameRef`, and `nodeRef` because their identity is owned by Space Preview or legacy World reconciliation rather than ordinary node transfer.

The modal reuses `Modal`, `Select`, and `Button` from `apps/web/src/components/Common`. It contains:

- an existing-Space picker that excludes the current Space and World;
- the number and labels of selected roots;
- the number of descendants included through selected Frames;
- the number of internal edges that will be preserved;
- the number of boundary edges that will be omitted;
- the number of eligible Agent conversations that will move;
- a blocking explanation when the selection contains a running Agent, a Task/Run root Agent, or an Agent with pending change-review records;
- **Cancel** and **Move** actions.

The confirmation summary is derived from the loaded Canvas only to explain the requested action. It is not an authorization or persistence plan. The Server repeats every structural check against authoritative state before mutating anything.

Before submitting, the web drains pending node-content writes and the structure-save queue. The Move action remains disabled while that drain or the request is in progress.

On success, the source selection disappears through its normal Canvas Sync update. A success toast reports the moved node and conversation counts and offers **Open destination**. On failure, a persistent localized error explains whether the selection became stale, the destination disappeared, an Agent was ineligible, validation failed, compensation failed, or the outcome is unknown.

## 6. Selection and subtree semantics

The request carries the IDs selected by the user. The Server validates that every requested ID is a live movable node in the source Space.

The service removes any requested node that already has a requested Frame ancestor. The remaining IDs are the transferred roots. It then recursively includes every descendant of each transferred Frame, regardless of whether that descendant was independently selected.

This produces one transfer set:

```text
requested selection
  -> remove selected descendants of selected Frames
  -> recursively expand selected Frame roots
  -> validate one acyclic source subtree forest
```

Nodes whose parent is included retain their parent-local `position` and remap `parentId` to the new destination parent ID. A transferred root whose source parent is not included becomes a root node in the destination.

## 7. Destination placement

The service resolves each transferred root's absolute source position and computes the bounding box of all transferred roots and their subtrees. It preserves the relative offsets between roots and applies one translation to the complete root set.

For an empty destination, the transferred bounds begin at a fixed root-space origin such as `{ x: 0, y: 0 }`. For a non-empty destination, the bounds are placed to the right of the destination's current absolute bounds with a fixed gap. This deterministic rule is intentionally simpler than a general collision-free packing algorithm.

Only root positions receive the translation. Descendant positions remain parent-local, preserving nested Frame geometry and structured-layout assignments.

## 8. Identity and collision handling

Every transferred node receives a fresh `node-<uuid>` ID and every preserved internal edge receives a fresh `edge-<uuid>` ID. An Agent Node keeps its globally unique `threadId`; node identity and conversation identity are separate domains. The response includes the old-to-new node mapping for diagnostics and destination navigation.

Fresh IDs avoid overwriting destination topology or sidecars and prevent a previous copy of the same source node from colliding with the move. Sketch stroke IDs are also regenerated because strokes form a node-local editing identity domain and may later be merged with another sketch.

Node labels are processed in source tree order using the existing `deduplicateLabel()` behavior against destination labels and labels already allocated during this transfer. The result reports every changed label. Disk sidecar paths continue to derive from the resolved destination labels; callers never construct those paths.

## 9. Edge behavior

An edge is internal when both endpoints belong to the transfer set. Internal edges are recreated with remapped endpoints and their complete persisted `edgeStyle`.

An edge is a boundary edge when exactly one endpoint belongs to the transfer set. Boundary edges are not created in the destination. Deleting the transferred source nodes removes their incident boundary edges from the source through the existing `DELETE_NODES` semantics.

The result reports omitted boundary edge IDs and endpoint labels where available. Huabu does not create cross-Space edge references or broken placeholder edges.

## 10. Artifact behavior

The service discovers artifact references through the shared `ARTIFACT_DATA_FIELDS`, `markdownArtifactFields()`, `collectMarkdownArtifactRefs()`, and `parseArtifactRef()` helpers. Bare keys and legacy Canvas-scoped artifact URLs are cloneable; `data:`, `blob:`, and external `http(s)` values remain unchanged.

Clone work is deduplicated by normalized source artifact key across the entire transfer. Each destination clone receives a fresh artifact key and every matching node-data or Markdown reference is rewritten to that key.

Unlike clipboard paste, a required artifact that is absent or cannot be read or written rejects the move before source deletion. The operation never intentionally creates a visible destination node with a missing required artifact.

The current Blob port has no per-key delete. A failed transfer into an existing destination may therefore leave newly written, unreferenced artifact bytes. They are not reachable from destination topology and are not a partial user-visible copy. Per-key cleanup and orphan GC are deferred to the storage follow-up rather than added to #142.

Source artifacts are not deleted after success because other source nodes may still reference the same key and the current storage model has no reference counts.

## 11. Agent conversation ownership

A Question node without a `threadId` moves as ordinary authored node data. A Question or fixed Agent Node with a `threadId` keeps that thread identity and moves its complete conversation ownership to the destination Space.

The move service rejects the complete request before mutation when any transferred Agent:

- has an active turn or `status === 'running'`;
- is referenced by a Task/Run as `rootNodeId` or `rootThreadId`;
- has pending change-review records;
- has a missing, malformed, or conflicting workload/history record.

Pending change-review records do not move because their commands and inverse changes belong to the source Canvas. Tasks and Runs do not move because their ledger and lifecycle form a larger execution aggregate than a Canvas selection.

Huabu supplies Agenetes with the complete target workload spec. It preserves the source driver kind, workload type, `threadId`, and driver state while replacing the namespace and host-owned Canvas context with the destination. Agenetes does not merge or interpret host fields.

Add a destructive counterpart to the existing `Agenetes.fork(source, targetSpec)` boundary:

```ts
interface Agenetes {
  rehome(source: ThreadIdentity, targetSpec: WorkloadSpec): void;
}
```

`rehome()` requires the source to have no live handle and the target namespace to contain no record or log for the thread. It snapshots and validates the source record plus both logs, writes the target logs, writes the target record last as the destination visibility point, then removes the source record before removing the source logs. It preserves driver state and removes no source data until the complete target is durable.

The underlying `ThreadStore`, `EventLogStore`, and `TurnStore` receive narrow replace/delete capabilities implemented by both memory and file stores. If any target write or source removal fails, `rehome()` restores the complete source snapshot and removes every target record/log it wrote before returning the original error. A failed rollback becomes an explicit unknown-outcome error. Huabu never reads, renames, or deletes Agenetes-private files directly. This change belongs to the `external/agenetes/` subtree and must be committed separately so it can be pushed upstream.

Before calling `rehome()`, Huabu closes the dormant runtime handle and verifies the Agent turn lease is free. After rehome, the next invocation recovers from the destination namespace with the preserved driver state and history.

The existing generic conversation-copy endpoint remains unavailable. Move can build a complete target spec from the node being moved; clipboard copy still cannot safely infer an independent target Agent identity.

## 12. HTTP contract

Add the shared zod contract under `packages/shared/src/types/api/space-move.ts` and validate it at the route boundary according to [API Design](../architecture/api-design.md).

```ts
interface MoveSelectionRequest {
  selectedNodeIds: string[];
  destinationCanvasId: string;
  expectedSourceVersion: number;
}
```

The route is:

```text
POST /api/canvas/:sourceCanvasId/move-selection
```

The response contains:

```ts
interface MoveSelectionResponse {
  transferId: string;
  destination: { canvasId: string; title: string | null };
  sourceVersion: number;
  destinationVersion: number;
  roots: Array<{
    sourceNodeId: string;
    destinationNodeId: string;
    label: string;
  }>;
  movedNodeCount: number;
  movedFrameCount: number;
  preservedEdgeCount: number;
  omittedBoundaryEdges: Array<{
    edgeId: string;
    source: string;
    target: string;
  }>;
  renamedNodes: Array<{ sourceNodeId: string; from: string; to: string }>;
  movedConversationCount: number;
}
```

The route uses typed error codes for stale source version, missing source node, invalid node type, missing or same destination, World refusal, running Agent, Task/Run-owned Agent, pending Agent changes, invalid Agent history, missing artifact, destination conflict, compensation failure, and unknown outcome. User-facing text is localized in the web application.

A separate planning endpoint is intentionally omitted. It would duplicate most reads and validation for a confirmation that the Server must repeat during execution. The loaded Canvas provides the preview; the execution endpoint remains authoritative.

## 13. Execution sequence

The service follows this order:

```text
drain client writes
  -> acquire Workspace operation lease
  -> acquire source and destination Canvas locks in sorted-id order
  -> read and validate both current Space records
  -> expand selection and build transfer model
  -> validate Agent eligibility and acquire thread leases
  -> read required node records, Agent records, and artifacts
  -> allocate IDs, labels, placement, and rewritten references
  -> write fresh destination artifacts
  -> execute destination CREATE_NODES + CONNECT_NODES without publication
  -> rehome eligible Agent conversations to the destination namespace
  -> execute source DELETE_NODES without publication
  -> publish destination and source updates
  -> return result
```

The existing `withCanvasMutex()` becomes a small multi-key coordinator that acquires unique Canvas IDs in lexical order. Existing single-Canvas callers continue through the same one-key path.

The Canvas executor exposes internal already-locked variants for both command execution and inverse-delta application, plus the current public lock-taking wrappers. Move calls only the already-locked variants so both locks remain held across destination insertion, source deletion, and any compensation; calling the public `applyDeltasOnServer()` while holding the destination lock would otherwise wait on itself. Normal executor callers remain unchanged.

The destination and source operations reuse `CREATE_NODES`, `CONNECT_NODES`, and `DELETE_NODES`; move-specific selection expansion, ID mapping, artifact rewriting, Agent eligibility, and result reporting stay in `SpaceMoveService` rather than becoming a `CanvasCommand`.

Every acquired Agent turn lease is released in a `finally` path after success, compensation, or unknown-outcome reporting. Canvas locks remain held until Agent leases are released and the final publication or error outcome is fixed.

## 14. Determinate failure and compensation

Validation, source reads, artifact reads, and destination artifact writes occur before source deletion. Failure in those stages leaves the source unchanged and creates no visible destination topology.

If destination command execution rejects, its existing `SpaceHandle.write()` rollback restores that Space's structured prestate. The source has not yet changed.

If an Agent rehome rejects, the service applies the destination execution's inverse deltas while both Canvas locks remain held. The source nodes and Agent ownership remain unchanged.

If source deletion rejects after Agent rehome, the service rehomes moved conversations back to their source specs, then applies the destination execution's inverse deltas. It publishes neither the insertion nor the compensation.

If compensation succeeds, the endpoint returns the original failure and both Spaces remain user-visible equivalents of their pre-request states, apart from possible unreachable destination Blob bytes.

If compensation itself fails or the backend outcome becomes unknown, the endpoint returns a distinct persistent-error code and instructs the client to reload both Spaces before retrying. The service does not claim success and the client must not automatically retry.

## 15. Durability and publication

The service allocates one `transferId` and includes it as the `runId` on both executor batches. Existing per-Space delta logs therefore provide durable correlation without adding a transfer ledger.

Canvas Sync updates are constructed from the two executor results and published only after both writes complete. The destination update is published before the source update so a user with both Spaces open never observes source removal before the destination exists.

The operation does not require exactly-once delivery. After an ambiguous transport failure, the client reloads the source and destination and uses the returned error guidance rather than automatically submitting the request again.

## 16. Permissions and destination validation

Huabu currently has one authenticated owner and no per-Space roles. An existing destination is writable when it is an ordinary live Space in the active Workspace and its configured structured and Blob stores admit the required writes.

World, the source Space itself, a missing Space, and a Space in deletion admission are rejected before topology mutation. A future role or capability model can replace this predicate without changing selection-transfer semantics.

## 17. Implementation plan

### Slice A: Agenetes rehome primitive

1. Add replace/delete capabilities to `ThreadStore`, `EventLogStore`, and `TurnStore`, with in-memory and file-backed contract coverage.
2. Add `Agenetes.rehome(source, targetSpec)`, preserving driver state and logs, rejecting live or conflicting targets, and compensating determinate store failures.
3. Cover internal and external workload records, complete history, empty history, destination collision, malformed source, and rollback.
4. Commit the `external/agenetes/` subtree change independently.

### Slice B: Server move operation

1. Add shared request, response, and typed-error contracts plus route builders and the web API helper.
2. Extract pure selection expansion and transfer-model construction from current clipboard behavior without changing clipboard semantics.
3. Add sorted multi-Canvas lock acquisition and an already-locked Canvas executor entry while preserving all current callers.
4. Implement `SpaceMoveService` using current Space, node, Blob, Task ledger, Agent service, executor, and lifecycle APIs.
5. Add Agent eligibility checks and build complete destination workload specs for `Agenetes.rehome()`.
6. Add the move-selection route and delayed paired Canvas Sync publication.

### Slice C: Product UI

1. Add the existing-Space picker modal and single/multi-selection toolbar actions with localized English and Chinese strings.
2. Drain pending source writes before submission, disable the action during execution, and surface eligibility errors.
3. Add success feedback with moved counts and an **Open destination** action.
4. Add focused service, route, resolver, and UI regression tests.
5. Fold shipped behavior into `docs/architecture/canvas-storage.md`, `docs/architecture/agent-architecture.md`, `docs/architecture/canvas-command-architecture.md`, and `docs/architecture/web-architecture.md`.

### Execution order and effort

Slice A is the only `external/agenetes/` change and lands as its own upstreamable commit. Slice B depends on Slice A. Slice C can begin after the shared API contract in Slice B is stable, but the feature remains hidden until the server path and end-to-end Agent continuation tests pass.

The expected implementation size is approximately 700–1,000 production lines and 500–800 test lines. Slice A is expected to take 1–2 engineering days, Slice B 3–4 days, and Slice C 1–2 days, excluding review latency. The estimate intentionally excludes generic transaction infrastructure, new-Space creation, conversation copy, and Task/Run migration.

## 18. Test plan

### Selection and hierarchy

- Move one standalone node.
- Move several standalone roots while preserving their relative geometry.
- Move nested Frames and preserve every parent-local position and Frame layout field.
- Select a Frame and one or more descendants and transfer each node once.
- Move a child without its source parent and place it as a destination root using its source absolute position.
- Reject a stale, missing, cyclic, or managed reference selection without mutation.

### Edges

- Recreate internal edges with fresh IDs, remapped endpoints, labels, direction, line shape, dash, stroke, and width.
- Omit incoming and outgoing boundary edges and report each omission.
- Remove source incident edges through the existing recursive delete semantics.

### Identity and collisions

- Allocate fresh node, edge, Sketch stroke, and artifact IDs.
- De-duplicate labels against destination nodes and earlier nodes in the same transfer.
- Preserve source labels and IDs unchanged until source deletion commits.
- Move a selection previously copied to the destination without overwriting the copy.

### Artifacts

- Clone dedicated `src` and `coverUrl` references.
- Rewrite Markdown-embedded image references.
- Clone one source key once when referenced repeatedly.
- Leave external, inline, and Blob URLs unchanged.
- Reject a missing or failed required artifact before source deletion.
- Confirm a failed existing-destination transfer leaves no topology referencing staged artifact keys.

### Runtime data boundaries

- Move an idle/done/error Agent while preserving `threadId`, workload spec, driver state, folded turns, event log, authored content, and style.
- Rewrite the target namespace and host Canvas context without changing Agent binding or driver kind.
- Continue the moved conversation from the destination and verify subsequent Canvas tool writes target the destination.
- Reject a running Agent without mutation.
- Reject an Agent referenced by Task/Run root identity without mutation.
- Reject an Agent with pending change-review records without mutation.
- Leave Tasks, Runs, change-review records, and Canvas events in the source.

### Failure behavior

- Destination write failure leaves source and destination topology unchanged.
- Source deletion failure applies destination inverse deltas and publishes no intermediate update.
- Agent rehome failure removes destination topology and leaves source ownership unchanged.
- Source deletion failure rehomes Agent conversations back before removing destination topology.
- Compensation failure returns the distinct unknown-state error and never auto-retries.
- Concurrent writes serialize under sorted dual locks.
- A stale `expectedSourceVersion` rejects before mutation.

### UI

- Single and multi-selection toolbars open the same modal.
- The existing-Space flow submits the selected destination ID.
- The confirmation shows normalized roots, descendants, preserved edges, omitted edges, and moved Agent conversation count.
- Ineligible Agent selections disable confirmation and explain the blocking reason.
- Pending writes drain before submission.
- Success shows counts and an Open destination action.
- Failure keeps the current source view and shows localized persistent feedback.

## 19. Validation

Run focused checks first:

```bash
pnpm --filter @huabu/shared test -- src/types/api/space-move.test.ts
pnpm --filter @agenetes/agenetes test -- src/instance.rehome.test.ts src/thread-store.test.ts src/event-log.test.ts src/turn-store.test.ts
pnpm --filter @huabu/server test -- src/modules/canvas/space-move.service.test.ts src/modules/canvas/space-move.route.test.ts
pnpm --filter @huabu/web test -- src/components/Panels/Canvas/MoveSelectionModal.test.tsx
pnpm --filter @huabu/shared typecheck
pnpm --filter @huabu/server typecheck
pnpm --filter @huabu/web typecheck
```

Before pull-request handoff, run the repository-required checks:

```bash
pnpm typecheck
pnpm format
pnpm lint:fix
```

## 20. Deferred storage follow-up

A separate storage design should decide whether and how Huabu provides a backend-neutral transaction spanning two Spaces and Blob scopes. That work owns crash recovery, WAL or native SQL transaction mapping, idempotency, transactional publication, per-key Blob deletion, staging, reference counts, retention, and orphan GC.

That follow-up may later replace the compensation implementation behind `SpaceMoveService`. It must not expand #142 or delay the user-facing business flow defined here.

## Code entry points

| File/dir                                                                                                                   | Responsibility                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`packages/shared/src/types/api/`](../../packages/shared/src/types/api/)                                                   | Shared move-selection request, response, and error contracts.                                               |
| [`apps/server/src/modules/canvas/canvas-executor.ts`](../../apps/server/src/modules/canvas/canvas-executor.ts)             | Existing single-Space command execution, persistence, inverse deltas, and Canvas Sync payload construction. |
| [`apps/server/src/modules/canvas/write-coordinator.ts`](../../apps/server/src/modules/canvas/write-coordinator.ts)         | Existing per-Canvas mutex to extend with sorted multi-key acquisition.                                      |
| [`apps/server/src/modules/storage/ports/structured.ts`](../../apps/server/src/modules/storage/ports/structured.ts)         | Existing Space records, node reads, versioned writes, and reported-failure rollback boundary.               |
| [`apps/server/src/modules/storage/ports/blob.ts`](../../apps/server/src/modules/storage/ports/blob.ts)                     | Existing scoped artifact reads and writes; per-key cleanup remains deferred.                                |
| [`apps/server/src/modules/agent/agent-thread.service.ts`](../../apps/server/src/modules/agent/agent-thread.service.ts)     | Agent eligibility, complete destination workload construction, and turn-lease coordination.                 |
| [`external/agenetes/packages/agenetes/src/`](../../external/agenetes/packages/agenetes/src/)                               | Driver-agnostic destructive thread rehome and durable store move primitives.                                |
| [`apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                             | Current selection, clipboard subtree expansion, save queues, and Canvas Sync application.                   |
| [`apps/web/src/components/Panels/Canvas/FloatingToolbars/`](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/) | Single- and multi-selection action entry points.                                                            |
| [`apps/web/src/components/Common/`](../../apps/web/src/components/Common/)                                                 | Existing modal, picker, input, and button primitives reused by the flow.                                    |
