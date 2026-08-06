# Canvas Checkpoint Plan

Status: Proposed
Last updated: 2026-07-07

## Goal

Add durable canvas checkpoints so a user can save important versions, preview
an older version, and restore the live canvas back to a known-good state. The
first release should be deliberately simple and reliable: manual checkpoints
plus an automatic safety checkpoint before every restore.

The public API should model a checkpoint as a recoverable timeline anchor, not
as a file-system snapshot. The first implementation can use full snapshots on
disk, while leaving room for content-addressed storage and finer-grained time
travel later.

## Existing Fit

The current storage model is checkpoint-friendly:

- Each canvas is already self-contained under one canvas directory.
- `canvas.json` is the live materialized canvas state and carries the monotonic
  canvas `version`.
- Node bodies live in `nodes/*.md`, so a correct checkpoint must capture sidecar
  content as well as `canvas.json`.
- Artifacts live in `.artifacts/`; the first implementation can copy the whole
  artifact directory for correctness.
- `.history/` already holds per-canvas historical data, including the delta log,
  so checkpoints naturally belong under `.history/checkpoints/`.

## Phase 1 Scope

Phase 1 supports two checkpoint reasons:

| Reason           | Created by             | Meaning                                                                 |
| ---------------- | ---------------------- | ----------------------------------------------------------------------- |
| `user`           | User action            | The user explicitly saved the current canvas as a named recovery point. |
| `before_restore` | Server restore handler | The server saved the current live canvas before applying a restore.     |

`before_restore` is important because restore is destructive at the live-canvas
level. Saving the pre-restore state means an accidental restore can itself be
undone by restoring the automatically-created checkpoint.

Out of scope for Phase 1:

- Agent-run checkpoints.
- Space-efficient blob deduplication.
- Restoring to arbitrary versions, timestamps, or run ids.
- A full timeline UI.
- Fine-grained delta replay.

## Shipping Plan

For a single-user local workflow, PR 1 + PR 2 are the completion line. They
should be enough for a user to create checkpoints, restore them safely, and
recover from an accidental restore via `before_restore`.

PR 3 is important, but it is not required for the first single-user release. It
hardens the multi-tab / collaboration experience and improves timeline polish.

### PR 1 — Server Core

Must ship:

- Shared zod API contracts for checkpoint create, list, preview, and restore.
- Server routes for the four checkpoint endpoints.
- `CanvasStore` checkpoint create, list, read, and restore methods.
- Per-canvas write locking for checkpoint create and restore, sharing the same
  serialization boundary as server-side canvas execution.
- Full-snapshot checkpoint payloads for `canvas.json`, `nodes/`, and current
  artifacts.
- Restore staging / backup behavior so a failed restore does not leave the live
  canvas half-restored.
- Restore version semantics: restored live canvas gets `fromVersion + 1`, never
  the checkpoint's old `baseVersion`.
- A restore history / delta-log record that marks the version bump as a
  full-canvas restore requiring reload, not a replayable fine-grained delta.
- Storage/name-index cache invalidation after restore.
- Tests for sidecar content, artifacts, incomplete checkpoint directories,
  missing checkpoint ids, version bumping, and `before_restore` creation.

Recommended simplifications for PR 1:

- Treat `index.json` as optional. Listing can scan checkpoint directories and
  read valid `meta.json` files directly.
- Restore checkpoint artifacts by adding or overwriting files, but do not delete
  extra live artifacts in Phase 1; old chat or history entries may still refer
  to them.

### PR 2 — Single-User Web UX

Must ship:

- Web API helpers and route builders for checkpoint create, list, preview, and
  restore.
- A create-checkpoint action with an optional label.
- A checkpoint list showing label, reason, created time, and base version.
- Restore confirmation.
- A flush of pending structure and node-content saves before creating a
  checkpoint, so the checkpoint matches what the user sees.
- Restore success handling that reloads the current canvas from the server and
  clears stale local undo / version-conflict state through the normal load path.
- Clear `before_restore` presentation as an automatic safety checkpoint.

Preview can ship in PR 2 only if it is strictly read-only and cannot trigger
autosave. If that isolation is not ready, preview should move to PR 3 rather
than risking accidental writes of old checkpoint state into the live canvas.

### PR 3 — Multi-Tab And Timeline Polish

Must ship before treating checkpoints as collaboration-ready:

- A broadcast / sync event for restore that tells other tabs to reload the full
  canvas instead of applying empty or partial deltas.
- Dirty-tab handling when another tab restores the canvas while this tab has
  unsaved node content.
- Timeline UI polish, including manual checkpoints, `before_restore` safety
  checkpoints, and later agent-run checkpoints.
- Guardrails for stale ACP / chat change cards after a whole-canvas restore.

## Data Model

Use `reason` for why the checkpoint was created, and `storageMode` for how it
is stored. These should stay separate so future storage changes do not alter the
product semantics.

```ts
type CanvasCheckpointReason = 'user' | 'before_restore';

type CanvasCheckpointStorageMode = 'full_snapshot';

type CanvasCheckpoint = {
  id: string;
  canvasId: string;
  label: string | null;
  reason: CanvasCheckpointReason;
  baseVersion: number;
  createdAt: number;
  storageMode: CanvasCheckpointStorageMode;
};
```

Phase 1 can keep `storageMode` fixed to `full_snapshot`. The field exists so the
API does not need to change when later phases add `content_addressed_snapshot`
or `snapshot_plus_delta`.

## Disk Layout

Add checkpoints under the canvas history directory:

```text
<canvasDir>/
  .history/
    checkpoints/
      index.json
      <checkpointId>/
        meta.json
        canvas.json
        nodes/
          <safe(label)>.md
        artifacts/
          <artifactId><ext>
```

`meta.json` is the authoritative metadata for one checkpoint. `index.json` is a
fast listing cache and should be treated as rebuildable.

Phase 1 should copy:

- The current `canvas.json`.
- The full current `nodes/` directory.
- The full current `.artifacts/` directory, if present.

This intentionally spends extra disk space to avoid partial-restore bugs. Later
phases can replace the full copies with a manifest and shared blobs.

Write order:

1. Create a temporary checkpoint directory.
2. Copy `canvas.json`, `nodes/`, and `.artifacts/` into it.
3. Write `meta.json` last inside the checkpoint directory.
4. Atomically move the temporary directory into place.
5. Update `index.json` after the checkpoint is complete.

Listing should ignore checkpoint directories that lack a valid `meta.json`.

## API Contract

Define the wire contract in `packages/shared/src/types/api/canvas-checkpoints.ts`
using zod schemas and inferred types, following `docs/architecture/api-design.md`.

Proposed routes:

```text
POST /api/canvas/:canvasId/checkpoints
GET  /api/canvas/:canvasId/checkpoints
GET  /api/canvas/:canvasId/checkpoints/:checkpointId
POST /api/canvas/:canvasId/checkpoints/:checkpointId/restore
```

Create body:

```ts
type CreateCanvasCheckpointBody = {
  label?: string | null;
  reason?: 'user';
};
```

Only `user` should be accepted from the public create endpoint in Phase 1.
`before_restore` is reserved for the server restore flow.

List response:

```ts
type ListCanvasCheckpointsResponse = {
  checkpoints: CanvasCheckpoint[];
};
```

Preview response:

```ts
type GetCanvasCheckpointResponse = {
  checkpoint: CanvasCheckpoint;
  canvas: CanvasFile;
};
```

The preview endpoint should return a read-only reconstructed canvas payload. It
should not expose checkpoint file paths to the client.

Restore body:

```ts
type RestoreCanvasCheckpointBody = {
  createBeforeRestore?: boolean;
};
```

`createBeforeRestore` should default to `true`.

Restore response:

```ts
type RestoreCanvasCheckpointResponse = {
  restoredFrom: CanvasCheckpoint;
  beforeRestoreCheckpoint?: CanvasCheckpoint;
  fromVersion: number;
  toVersion: number;
};
```

## Storage API

Keep all file-system details inside `CanvasStore` and `paths.ts`; route handlers
should not manually join checkpoint paths.

Path helpers:

```ts
checkpointsDir(canvasId);
checkpointDir(canvasId, checkpointId);
checkpointMetaPath(canvasId, checkpointId);
checkpointIndexPath(canvasId);
```

Canvas store methods:

```ts
createCheckpoint(input): CanvasCheckpoint
listCheckpoints(): CanvasCheckpoint[]
readCheckpoint(checkpointId): CheckpointSnapshot
restoreCheckpoint(checkpointId, options): RestoreCheckpointResult
```

`checkpointId` should be generated by the server and sanitized before it is used
in a path, for example `cp_<timestamp>_<random>`.

## Restore Semantics

Restore must not roll the live canvas version backward.

If the live canvas is at version 80 and the target checkpoint was created at
version 42, restore should produce live version 81. The checkpoint's
`baseVersion` remains 42, but the restored live `canvas.json.version` becomes
`fromVersion + 1`.

Restore flow:

1. Read the live canvas and set `fromVersion = live.version`.
2. If `createBeforeRestore !== false`, create a `before_restore` checkpoint of
   the current live canvas.
3. Read the target checkpoint payload.
4. Replace the live `canvas.json`, `nodes/`, and `.artifacts/` with the
   checkpoint payload.
5. Rewrite the restored live `canvas.json` with `version = fromVersion + 1` and
   `updatedAt = Date.now()`.
6. Append a history record for the restore operation.
7. Return `toVersion` and ask connected clients to reload the canvas.

Phase 1 does not need to synthesize fine-grained deltas for restore. A restore
is a whole-canvas operation, so clients can reconcile by loading the full canvas
after the version bump.

## Web UX

Keep the first UI small:

- Add a Create Checkpoint action.
- Show a checkpoint list with label, reason, created time, and base version.
- Allow previewing a checkpoint read-only.
- Require confirmation before restore.
- Reload the live canvas after restore succeeds.
- Display `before_restore` entries as automatic safety checkpoints.

The UI should not depend on `storageMode` or any checkpoint file path. It should
only call the checkpoint API by id.

## Tests

Prioritize storage and route tests:

- Creating a `user` checkpoint writes complete metadata and payload.
- Listing returns only complete checkpoints.
- Preview returns the checkpoint canvas without mutating the live canvas.
- Restore creates a `before_restore` checkpoint by default.
- Restore sets the live canvas version to `fromVersion + 1`.
- Restore brings back node sidecar content, not only geometry from
  `canvas.json`.
- Restore handles artifacts referenced by restored nodes.
- Missing checkpoint ids return 404.
- Incomplete checkpoint directories are ignored by list.

## Later Phases

### Phase 2 — Agent Safety Checkpoints

Add `before_agent_run` checkpoints before agent or ACP batches that may mutate
the canvas. Surface them near agent change summaries so the user can quickly
return to the pre-agent state.

### Phase 3 — Space-Efficient Storage

Replace per-checkpoint full copies with manifests and content-addressed blobs.
Deduplicate unchanged `canvas.json`, node sidecars, and artifacts across
checkpoints while preserving the same API.

### Phase 4 — Fine-Grained Time Travel

Use materialized checkpoints as anchors and replay `delta-log.jsonl` rows to
preview or restore targets by version, timestamp, or run id. Restores should
still create a new live version rather than moving the version counter backward.

### Phase 5 — Timeline UI

Combine manual checkpoints, safety checkpoints, agent runs, and important
versions into one timeline UI with preview and restore actions.
