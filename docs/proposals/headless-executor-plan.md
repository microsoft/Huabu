# Headless Executor & Sync Plan

Status: Needs Review — partially shipped

Last updated: 2026-07-22

## Goals

1. **Headless executor**: agent commands execute on the server, with real success/failure feedback flowing back to the LLM.
2. **Canvas sync**: server is the authority for canvas structure; all clients (tabs, devices, agent) converge automatically.
3. **Multi-tab note editing**: opening the same note in multiple tabs converges without conflicts.

These three goals share a foundation: the canvas-command executor must be runnable on the server, not just in the browser.

## Architecture Summary

Two orthogonal sync channels:

| Channel       | Carries                                         | Protocol                             | Source of truth                                                              |
| ------------- | ----------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| **Structure** | nodes, edges, frame parenthood, label, geometry | HTTP `execute` + SSE delta broadcast | `canvas.json` (materialized view) + `delta_log` SQLite table (authoritative) |
| **Content**   | per-node markdown body                          | Yjs over WebSocket + debounced flush | `nodes/<label>.md`                                                           |

Both channels are mediated by the server, but they do not interfere with each other. The structure channel writes `canvas.json`; the content channel writes `nodes/*.md`. Neither touches the other.

The structure channel uses a **delta-based event-sourcing** model. Clients submit _commands_ (intents like `AUTO_LAYOUT`, `CREATE_NODES`, drag); the shared engine expands each command into a sequence of self-inverting _deltas_ (concrete facts like `SET_GEOMETRY(id, prev, next)`, `INSERT_NODE(id, fullData)`). Only deltas are persisted to the per-canvas log with a monotonically increasing version; only deltas cross the wire to other clients. `canvas.json` is the materialized view of replaying the delta log. Because deltas are facts (not intents), the log is deterministic by construction — non-deterministic command expansion (e.g. fCoSE seeding, default position assignment, ID generation) happens once on the server, and every consumer sees the same outcome.

## Post-Effects Split

The executor produces side-effects that are intentionally split across three buckets:

| Bucket          | Examples                                                                                                       | Lives in                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Pure**        | edge handle reroute                                                                                            | `packages/shared/src/canvas-engine/postEffects.ts`, runs on both sides |
| **Web-only**    | CSS transition cleanup, deferred frame-fit-after-DOM-measure, local history snapshot, `markAiContentEdit` flag | `apps/web/src/handler/canvasCommand/postEffects.web.ts`                |
| **Server-only** | delta log append, preprocessing / ingestion queue, broadcast to subscribers                                    | `apps/server/src/modules/canvas/postEffects.server.ts`                 |

Both sides call the shared pure subset first, then run their own host-specific post-effects. **Preprocessing (ingestion, embeddings, knowledge graph) is server-only after M2**: the client never triggers it directly, so an agent-created node is preprocessed exactly once regardless of how many tabs are open.

## Phasing Principles

1. **Pure refactor first, behavior change second.** Extracting the engine to a shared package must produce zero behavior change. Only after extraction stabilizes does the server start using the engine.
2. **No dual-mode middleware.** Avoid intermediate states where some agent commands run on the server and others run in the browser. Cut over the whole batch at once.
3. **Each milestone is independently shippable.** Any milestone can be merged to `main` and deployed without requiring the next one.
4. **Yjs is opt-in and orthogonal.** Content sync (M4) does not block, and is not blocked by, structure sync (M1–M3).
5. **Engine maps commands to deltas; deltas are the log unit.** Client and server both run the shared engine. The server's deltas are the source of truth; client predicts the same deltas locally for instant feedback. For deterministic commands the prediction equals the authoritative output and the optimistic apply is silently confirmed; for non-deterministic commands (auto-layout, geometric defaults) the server's deltas win and the client reconciles by replacing its prediction. Only deltas are ever logged or broadcast — replay needs no engine.

## Shipping Phases

The M1→M2→M3→M4 milestones below describe the **target architecture**. This section records how we actually ship them and where we diverged from the original plan for pragmatic reasons.

### M1 status: shipped, with task 1.7 deferred

Engine extraction (1.1–1.6, 1.8–1.10) landed. **Task 1.7 (move per-command change extractors to `deltaExpanders.ts`) was deferred** — the extractors in `apps/web/src/hooks/useCanvasChanges.ts` remain client-side. Phase A absorbs this by computing deltas via a coarse `diffCanvasState(prev, next)` (see below) instead of per-command expanders. Per-command, per-property expanders only become useful when fine-grained `SET_DATA(key, prev, next)` deltas are needed (M5 / CRDT) — defer until then.

> **Superseded (2026-07):** once the sketch pipeline moved to server-side
> apply, `apps/web/src/hooks/useCanvasChanges.ts` had no remaining callers and
> was **deleted wholesale** — the extractors were never moved into the engine
> (task 1.7 is moot). Revertible AI changes are now server-authored delta
> records surfaced through `acpThreadChangesStore`; later references in this
> doc and its appendices to `useCanvasChanges.ts` /
> `snapshotAndExtractChanges` describe that since-removed client-side
> mechanism.

### Phase A = M2 + M3.1–3.4 (one release, four PRs)

Ship M2 and M3's **passive-sync subset** together. Phase A solves the headless-agent and per-tab agent-write visibility problems; multi-tab UI co-editing still falls back to today's 409 path.

Subdivide into four independent PRs so each one is reviewable and reversible:

| PR  | Scope                                                                                                                                                | Unlocks                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Shared `delta.ts` + `diff.ts` (`Delta` union, `invertDelta`, `applyDeltas`, `diffCanvasState`)                                                       | Zero runtime impact; type-only foundation                                         |
| 2   | Server `canvas-executor` + `delta_log` table + `POST /:id/execute`; rewrite `handleCanvasCommands` to call executor; web `applyDeltasFromToolResult` | **Headless agent works**; LLM gets real per-command results (errors included)     |
| 3   | Server `canvas-broadcast` + SSE `GET /:id/events` + pull `GET /:id/log?since=v`; web `useCanvasSync` hook                                            | Agent writes auto-sync to other tabs                                              |
| 4   | `PUT /:id` internally goes through executor; `saveCanvas` 409 auto-recover via `/log?since=`                                                         | UI drags auto-sync to other tabs; OCC 409 becomes recoverable (toast as fallback) |

**Phase A pragmatic choice: coarse deltas.** Rather than refactoring every command handler to emit per-property deltas (D5 ideal), Phase A runs the existing shared engine and then diffs `prestate → poststate` to produce coarse deltas: `INSERT_NODE / DELETE_NODE / REPLACE_NODE / INSERT_EDGE / DELETE_EDGE / REPLACE_EDGE` plus scalar `SET_EXPANDED_NODE`. Trade-off accepted:

- ✅ Self-inverting (carries pre + post node/edge data).
- ✅ Replay needs no engine — downstream clients just `applyDeltas`.
- ❌ A single-field data change shows up as a full `REPLACE_NODE`, not `SET_DATA(key, prev, next)`. CRDT-friendliness deferred.

**Phase A version dedup (no `optimisticTag` yet).** The tab that originated an agent run receives the same delta batch through two channels: SSE `tool_result` (with deltas + `toVersion`) and SSE `/events` (broadcast). Both apply paths gate on `if (localVersion >= toVersion) skip` — no per-tab tag machinery needed in Phase A.

**Phase A retains the old write paths intentionally.** `PUT /api/canvas/:id` and the 409 toast both survive Phase A. The PUT handler internally calls the executor so it still produces `delta_log` rows + broadcasts, but the wire shape is unchanged for the web client. Phase B removes both.

### Phase B = M3.5–3.9 (later release)

Defer until real usage data from Phase A informs the optimistic-reconcile design. Phase B's hard part is 3.6 (predicted vs authoritative reconcile), which only matters when two tabs concurrently mutate the same canvas — a workload Huabu has no real telemetry for yet. Phase A's `delta_log` will produce that telemetry.

## Open Design Decisions

### D1. Engine location

`packages/shared/src/canvas-engine/` — no new package; lives alongside existing `shared` exports.

### D2. Engine portability

The engine is fully self-contained — **no `EngineHostHooks` abstraction is needed**. All "would-be web-coupled" pieces are actually pure code and move with the engine:

- `stripMarkdown` (`apps/web/src/utils/io/markdown.ts`) → `packages/shared/src/canvas-engine/utils/markdown.ts` (pure regex, zero DOM).
- `getNodeDefaultSize` + `DEFAULT_SIZES` (`apps/web/src/config/nodeSizes.ts`) → `.../canvas-engine/utils/nodeSizes.ts` (static map).
- `placeNode` + entire `apps/web/src/handler/autoLayout/` → `.../canvas-engine/autoLayout/` (Cytoscape + fCoSE, pure algorithm). Cytoscape deps move to `packages/shared/package.json`; web bundle is unaffected (already uses them).
- `markAiContentEdit` is the **only** web-only thing the executor currently calls. Extract it from the executor by adding `aiContentEditedNodeIds: string[]` to `ExecutorOutput`; the web caller invokes `markAiContentEdit` for each id after the executor returns. Engine stays pure.

The change extractors in `apps/web/src/hooks/useCanvasChanges.ts` (`extractCreateNodes`, `extractDeleteNodes`, etc.) move into the engine as the **command-to-delta expanders**: their job becomes producing the typed delta sequence for each command. Both server (authoritative) and web (optimistic prediction) call the same expanders.

### D3. Content sync API

Per-node Yjs over WebSocket (`/api/canvas/:id/nodes/:nodeId/yjs`), `.md` is canonical store. Yjs is a transient sync mirror; closing all tabs disposes the Y.Doc. "Mode C": `.md` is authoritative, Y.Doc seeds from it on open, flushes to it on debounced update.

### D4. Yjs timing

Solo dev: M1 → M2 → M3 → M4 sequential. Two devs: M4 can run in parallel from week 2.

### D5. Log granularity: deltas, not commands

The log stores **deltas** (state-change facts), not **commands** (intents). The engine signature is:

```ts
engine.expand(command: CanvasCommand, prestate: CanvasState): Delta[]
```

Deltas are self-describing and self-inverting — each carries both pre-image and post-image data so its inverse can be computed by inspecting the row alone, with no state lookup required. Examples:

- `INSERT_NODE(id, fullNodeData)` ↔ `DELETE_NODE(id, fullNodeData)`
- `SET_GEOMETRY(id, prev: {x, y, w, h}, next: {x, y, w, h})` ↔ same struct with prev/next swapped
- `SET_DATA(id, key, prevValue, nextValue)` ↔ swap
- `INSERT_EDGE(id, fullEdgeData)` ↔ `DELETE_EDGE(id, fullEdgeData)`
- `SET_NODE_PARENT(id, prev, next)` ↔ swap

Why deltas instead of commands:

1. **Determinism by construction.** Non-deterministic command expansion (fCoSE seeding, default node sizing, ID generation, default position assignment) happens once on the server. Every consumer — other tabs, future replays, late-joining clients on an older engine version — gets identical state without re-running fCoSE.
2. **Replay needs no engine.** Catching up from `v17` to `v23` is `applyDeltas(state, deltas_v18..v23)` — a pure structural transform. An older client missing the latest engine version can still converge.
3. **Revert without state read.** Inverse is `deltas.reverse().map(invert)`; no need to query "what was X's geometry before this batch" or store a separate `revert_command_json`.
4. **CRDT-compatibility hatch.** Deltas correspond closely to CRDT ops (`Y.Map.set`, `Y.Array.insert`). If multi-user real-time collab ever becomes a requirement, the delta abstraction is what makes adding a CRDT layer additive rather than a rewrite (out of scope for M1–M4; see "Out of Scope").

Cost: each delta row is ~2× the size of an equivalent command row (stores pre + post image instead of just the patch). Accepted; large rows (e.g. auto-layout on a 500-node canvas) can be gzipped if log table size becomes a real concern.

### D6. Structure sync strategy

Hand-roll a delta-based event-sourcing model on top of a per-canvas SQLite `delta_log` table. No external sync library.

Schema:

```sql
CREATE TABLE delta_log (
  canvas_id       TEXT NOT NULL,
  version         INTEGER NOT NULL,
  command_json    TEXT NOT NULL,    -- intent (informational; useful for audit / agent debugging)
  delta_json      TEXT NOT NULL,    -- array of self-inverting deltas (authoritative)
  originator_json TEXT NOT NULL,    -- { source, tabId, optimisticTag?, userId? }
  run_id          TEXT NOT NULL,    -- agent run / undo group
  ts              INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, version)
);
CREATE INDEX delta_log_by_run ON delta_log (canvas_id, run_id);
```

- One row per accepted command. A batched `/execute` call produces N contiguous versions sharing one `run_id`.
- `version` is strictly monotonic per canvas; allocated atomically inside the per-canvas mutex.
- Clients subscribe to SSE that announces `(canvas_id, fromVersion, toVersion, originator, command, deltas)` per write. If `localVersion === fromVersion` the client applies deltas directly (no engine needed). Otherwise it pulls `GET /api/canvas/:id/log?since=<localVersion>` to backfill.
- `canvas.json` is a fast-read materialized snapshot — never the source of truth for version semantics.

Why not a library:

- **Replicache** fits conceptually but is in maintenance mode and adds ~50 KB + a key-value cache layer we'd need to adapt to.
- **ElectricSQL / PowerSync** require Postgres or cloud backends; we use local SQLite.
- **TinyBase** would require rewriting the zustand canvas store wholesale.
- **Automerge / Yjs (full-CRDT for structure)** is powerful but mis-fits structure data with hard invariants (label uniqueness, frame nesting, edge reference integrity). Out of scope for M1–M4; the delta abstraction keeps the door open for adding a CRDT layer additively later (see "Out of Scope").
- The delta-based event-sourcing pattern itself is timeless. We adopt it without a dependency.

### D7. Chat-panel revert (preserved as-is)

Today's per-chat-message revert UX is preserved unchanged through M1–M4. The mechanical adjustment: every log row's deltas are self-inverting, so revert is a pure local computation — no server-returned `revertCommand` field is needed in the `/execute` response. Web takes the original batch's deltas (received via broadcast and cached against the chat message id), runs `deltas.reverse().map(invert)` from the shared engine, and submits the result as a new `/execute` call with `originator.source = 'ui-revert'`. The server treats it like any other mutation — no special "revert" semantics in the executor.

Anything more sophisticated (preserving user's interleaved edits, cross-turn timeline UI, snapshot/restore, file-level backup) is **deferred to M5**. Designing it requires real usage data from M2/M3 first.

### D8. Optimistic update pattern (this-tab-initiated only)

The split is by **who initiated the mutation**, not by user-vs-agent. Any mutation initiated in _this tab_ — drag, alignment, type change, chat-panel Revert click, etc. — applies locally via the shared engine for instant feedback, then syncs to server:

```
this-tab mutation
  → engine.expand(command, localState) → predicted deltas[]
  → applyDeltas(localState, predicted) locally (sync, ~16 ms)
  → POST /api/canvas/:id/execute (async, with optimisticTag)
  → broadcast returns authoritative deltas[] + optimisticTag echo:
      - predicted ≡ authoritative → silently confirm, bump localVersion
      - predicted ≠ authoritative → rollback predicted, apply authoritative
      - stale prestate (server applied other commands in between) → server
        re-expanded command against current head; client rolls back predicted
        and applies the authoritative deltas
```

Mutations originated elsewhere — agent runs on the server, or commands posted from sibling tabs — skip optimistic apply and are simply consumed from the broadcast (just `applyDeltas`, no engine needed). The web tab that posted to `/execute` is the only one allowed to carry an `optimisticTag` for that batch.

## Milestones

### M1. Extract engine to shared (pure refactor)

**Goal**: relocate the executor, command handlers, auto-layout, and change extractors to `packages/shared/src/canvas-engine/`. Zero behavior change.

| #    | Task                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Create `packages/shared/src/canvas-engine/` with subdirs `commands/`, `utils/`, `autoLayout/`.                                                                                                                                                                                                                                                                       |
| 1.2  | Move `executor.ts`, `commands/*`, `runtime.ts`, `utils/frame.ts`, `utils/edge.ts`, `types.ts` from `apps/web/src/handler/canvasCommand/` into the new location.                                                                                                                                                                                                      |
| 1.3  | Move `apps/web/src/utils/io/markdown.ts` (the `stripMarkdown` function) to `packages/shared/src/canvas-engine/utils/markdown.ts`. Web re-exports from the new location.                                                                                                                                                                                              |
| 1.4  | Move `apps/web/src/config/nodeSizes.ts` to `packages/shared/src/canvas-engine/utils/nodeSizes.ts`. Web re-exports.                                                                                                                                                                                                                                                   |
| 1.5  | Move `apps/web/src/handler/autoLayout/` to `packages/shared/src/canvas-engine/autoLayout/`. Move `cytoscape`, `cytoscape-fcose`, and related deps to `packages/shared/package.json`. Web continues to import the same symbol names.                                                                                                                                  |
| 1.6  | Extract `markAiContentEdit` out of the executor: add `aiContentEditedNodeIds: string[]` to `ExecutorOutput`; web caller invokes `markAiContentEdit` for each id after the executor returns. Engine no longer imports from `@/...`.                                                                                                                                   |
| 1.7  | Move the per-command change extractors from `apps/web/src/hooks/useCanvasChanges.ts` (`extractCreateNodes`, `extractDeleteNodes`, etc.) into `packages/shared/src/canvas-engine/deltaExpanders.ts` and rename to `expandCreateNodes`, `expandDeleteNodes`, etc. Each function returns the typed `Delta[]` for its command (D5). The React-hook wrapper stays in web. |
| 1.8  | Split current `apps/web/src/handler/canvasCommand/postEffects.ts` into: `packages/shared/src/canvas-engine/postEffects.ts` (pure: edge reroute) and `apps/web/src/handler/canvasCommand/postEffects.web.ts` (transition cleanup, deferred frame fit, `canvasHistoryManager.trackDelete`, `markAiContentEdit` consumption).                                           |
| 1.9  | Forbid any `@/...` (web alias) or `@xyflow/react` runtime imports inside `packages/shared/src/canvas-engine/`. Type-only imports of `@xyflow/react` are allowed. Enforce via ESLint rule on `packages/shared`.                                                                                                                                                       |
| 1.10 | Lint, typecheck, and `apps/server/evals` all pass.                                                                                                                                                                                                                                                                                                                   |

**Done when**:

- `packages/shared/src/canvas-engine/` is pure TypeScript with no web runtime dependencies.
- All existing user-facing behavior is unchanged (verified by evals).
- `pnpm --filter web typecheck`, `pnpm --filter server typecheck`, and `pnpm --filter @huabu/shared typecheck` all pass.

### M2. Server-side execution + delta log

**Goal**: agent commands execute on the server; every accepted command's expansion is persisted as a delta-row to an authoritative log; preprocessing migrates server-side.

> **Phase A note**: tasks 2.1–2.7 describe the **target** wire shape per D5. In practice we ship them with the coarse-delta shortcut described in "Shipping Phases" above — `delta_json` carries `INSERT/DELETE/REPLACE_NODE` rather than per-property `SET_DATA`. The schema and endpoint surfaces are unchanged; only the delta producer is simpler.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | New SQLite table `delta_log` (schema in D6). Index on `(canvas_id, run_id)` for "revert this agent run" queries.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2.2 | `apps/server/src/modules/canvas/canvas-executor.ts`: imports the shared engine + command-to-delta expanders directly (no hooks). Per-canvas async mutex serializes concurrent writers. Allocates next `version` atomically; persists `(command_json, delta_json)` pair per accepted command.                                                                                                                                                                                                                                               |
| 2.3 | New endpoint `POST /api/canvas/:id/execute`: body `{ commands, originator, optimisticTag? }`; response `{ fromVersion, toVersion, results: Array<{ command, deltas, error? }> }`. Writes log rows inside the mutex; updates `canvas.json` as the materialized view; runs server-only post-effects. Web computes inverses locally from `deltas` (D7) — no `revertCommand` round-trip.                                                                                                                                                       |
| 2.4 | Replace body of `handleCanvasCommands` (agent tool handler): invoke `canvas-executor` directly. Return real per-command results (deltas applied or structured error) to the LLM.                                                                                                                                                                                                                                                                                                                                                           |
| 2.5 | Refactor `applyCanvasCommandsFromToolResult` (web) into `applyDeltasFromToolResult`: no longer executes commands locally — it consumes the authoritative deltas the server returns inside the tool result and `applyDeltas`-es them into the local state (gated by `localVersion >= toVersion`). The chat-card UI continues to read `perCommand[].command` for "AI made N changes" affordances. (M3 broadcast is an _additional_ delivery channel for tabs that did not originate the run, not a replacement for the tool-result payload.) |
| 2.6 | Move the preprocessing pipeline server-side: server-only post-effects enqueue ingestion / embeddings / knowledge graph work directly. Remove `triggerPreprocessing` callback path from `postEffects.web.ts`.                                                                                                                                                                                                                                                                                                                               |
| 2.7 | Debug / audit: SQL view `delta_log_view` expanding `delta_json` via `json_each` for human-readable history. Joins **nothing** against current node/edge tables — historical rows must show labels/data as of the time of the delta, not the current ones.                                                                                                                                                                                                                                                                                  |

**Done when**:

- Every agent-issued command persists to `delta_log` and updates `canvas.json` atomically.
- Label collisions, missing nodes, frame-nesting violations return structured errors that the LLM can act on.
- Web no longer calls `triggerPreprocessing`; opening an agent-created PDF in two tabs results in exactly one ingestion run.
- `delta_log` answers "which canvas state existed at version N?" by `applyDeltas(emptyState, deltas v1..vN)` — pure structural transform, no engine required.

### M3. Delta broadcast + multi-tab sync

**Goal**: any structure change reaches all clients within ~50 ms via delta broadcast; chat-panel revert works across tabs without latency regression.

> **Phase A note**: only 3.1–3.4 ship in Phase A, and 3.4 is simplified — no `optimisticTag` matching, no rollback. The Phase A hook just gates on `localVersion >= toVersion` to skip already-applied batches (covers the case where the tab that originated an agent run receives the same batch twice: once via tool-result, once via broadcast). 3.5–3.9 are Phase B.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | SSE endpoint `GET /api/canvas/:id/events`: per-canvas channel. Each event carries `{ canvasId, fromVersion, toVersion, originator, command, deltas }`. Heartbeat every 30 s.                                                                                                                                                                                                                                                                         |
| 3.2 | `canvas-executor` emits one SSE event per log row after every successful write. Event payload mirrors the `delta_log` row contents (sans `ts`).                                                                                                                                                                                                                                                                                                      |
| 3.3 | Pull endpoint `GET /api/canvas/:id/log?since=<version>`: returns rows from `version + 1` up to head (capped, e.g. 500 rows). Each row carries its deltas; client applies them in order without invoking the engine.                                                                                                                                                                                                                                  |
| 3.4 | Web `useCanvasSync(canvasId)` hook: subscribes to SSE. On event: if `fromVersion === localVersion` and `originator.optimisticTag` matches one of this tab's pending applies → deep-compare predicted vs broadcast deltas; identical → silently confirm; different → rollback predicted, apply broadcast. If `fromVersion === localVersion` and no tag match → `applyDeltas(state, deltas)` directly. Otherwise → fetch log delta and apply in order. |
| 3.5 | _(Optional, deferable)_ Same-origin `BroadcastChannel('huabu-canvas-sync')`: when this tab successfully posts to `/execute`, broadcast `(version, deltas, optimisticTag)` to sibling tabs so they apply before SSE arrives. May be deferred if SSE latency on localhost proves sufficient.                                                                                                                                                           |
| 3.6 | Optimistic apply path: web `executeCommands(cmds, source)` (drags, alignment, chat revert, etc.) runs the engine locally to predict deltas, applies them with an `optimisticTag`, simultaneously POSTs to `/execute`, and reconciles on broadcast (D8).                                                                                                                                                                                              |
| 3.7 | Remove `PUT /api/canvas/:id` entirely. Full canvas re-saves (import, rename, hand-edited JSON) become a single `/execute` call with a `RESET_CANVAS` command that expands into `(delete all existing nodes & edges) + (insert all new nodes & edges)` deltas. One endpoint, one mutation primitive, log stays complete.                                                                                                                              |
| 3.8 | Remove "409 → toast → forced refresh" flow. Replaced by log-pull-and-apply reconciliation — the user never sees a conflict toast.                                                                                                                                                                                                                                                                                                                    |
| 3.9 | Env flag `HUABU_ENABLE_SYNC` (default on) gates SSE subscription; legacy refetch path remains as fallback for one release cycle.                                                                                                                                                                                                                                                                                                                     |

**Done when**:

- Two browser tabs on the same canvas converge within 100 ms for any single command.
- Agent-driven changes appear in all tabs automatically without refetch.
- Clicking "Revert" in a chat message removes the change from all tabs within ~50 ms; user-perceived latency in the originating tab is one frame.
- No version-conflict toast ever shown to the user.
- Killing one tab's network for 30 s and reconnecting: the tab pulls the log delta and converges without manual refresh.

### M4. Yjs for note content

**Goal**: two tabs editing the same note converge in real time; agent always reads the freshest `.md`.

| #   | Task                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Add deps: `yjs`, `y-protocols`, `y-indexeddb`, `@milkdown/plugin-collab`.                                                                                                                                                   |
| 4.2 | `apps/server/src/modules/sync/node-ydoc-registry.ts`: per-node Y.Doc registry. On first connection, seed Y.Doc from `.md`; on `update`, debounce 500 ms then `store.writeNode`; dispose Y.Doc when last client disconnects. |
| 4.3 | WebSocket endpoint `/api/canvas/:id/nodes/:nodeId/yjs` using `y-protocols`.                                                                                                                                                 |
| 4.4 | Web `MilkdownEditor`: wire `@milkdown/plugin-collab` with the Y.Doc, add `y-indexeddb` for offline cache.                                                                                                                   |
| 4.5 | Agent runner: before invoking tools, `await nodeYDocRegistry.flushPendingWrites(canvasId)` so `fileread` sees current editor content.                                                                                       |
| 4.6 | Agent writes (via `canvas-executor`): after `.md` written, notify the registry to reload the Y.Doc and broadcast to connected clients.                                                                                      |

**Done when**:

- Two tabs editing the same node merge edits live, no lost content.
- Agent `fileread` returns the post-flush content (≤ 500 ms behind active typing; strongly consistent after a `flushPendingWrites`).
- Closing all tabs of a node disposes the Y.Doc; the `.md` file remains the single source of truth.

### M5. (Future) Timeline & smart revert — placeholder

**Not scoped, not designed yet.** Tracked here so it doesn't leak complexity into M1–M4.

After M3 ships, revisit whether real usage justifies any of:

- A per-agent-turn diff timeline UI (cheap: derive from `delta_log` grouped by `run_id`).
- "Restore to before this turn" that preserves user's interleaved edits (hard: requires per-delta CAS, file-level backup, or snapshot + manual conflict UX).
- Long-form version history (à la Notion / Cursor checkpoints).

**Decision deferred**. Today's all-or-nothing per-message revert (D7) plus Milkdown's per-node Cmd+Z is the M1–M4 baseline and is expected to cover the vast majority of real cases.

## Risks and Mitigations

| Risk                                                                                        | Mitigation                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 extraction silently changes a handler behavior                                           | Run `apps/server/evals` after every command group moves; keep PRs small (one file group per PR).                                                                                                                               |
| Delta payload bloats on large batches (e.g. `AUTO_LAYOUT` on a 500-node canvas)             | Self-inverting deltas store both prev and next geometry, so a 500-node layout row can hit tens of KB. Acceptable for now; gzip `delta_json` on insert if a single row exceeds ~64 KB. Auto-layout is the realistic worst case. |
| Delta log grows unbounded                                                                   | Periodic compaction: a `RESET_CANVAS` row collapses prior history into one delete-all + insert-all pair; safe to do per canvas at idle. Defer until log size becomes an actual issue.                                          |
| Concurrent agent invocations corrupt `canvas.json`                                          | Per-canvas mutex in M2; version allocation is atomic inside the mutex.                                                                                                                                                         |
| Mutex `Map<canvasId, Promise>` leaks entries                                                | Delete the entry when the promise settles; or use an LRU. Trivial fix, easy to forget — enforce in code review.                                                                                                                |
| SSE behaves differently inside Tauri                                                        | Tauri uses real `EventSource`; tested separately. `HUABU_ENABLE_SYNC` flag plus log-pull fallback keeps a recovery path.                                                                                                       |
| Predicted deltas ≠ authoritative deltas (e.g. concurrent mutation between predict and POST) | Expected and handled: web rolls back its predicted deltas and applies the server's. With self-inverting deltas, rollback is one `applyDeltas(state, predicted.reverse().map(invert))` call — no log refetch needed.            |
| Yjs Y.Doc diverges from `.md`                                                               | Strict "Mode C" rule: `.md` is canonical, Y.Doc disposed when last tab closes; never persist Y.Doc binary alongside `.md`.                                                                                                     |
| Long-running agent run blocks user edits via mutex                                          | Mutex is per-canvas, per-batch; agent batches should stay small. Long-running agent work chunks into multiple `/execute` calls separated by other work.                                                                        |

## Out of Scope

- Multi-process / horizontally scaled server (mutex is in-process; revisit when needed).
- Cross-canvas sync (each canvas is independent).
- Cmd+Z global undo of agent changes (chat-panel Revert covers per agent message).
- **Cross-turn surgical revert that preserves user's interleaved edits** — deferred to M5; today's all-or-nothing per-message revert is preserved through M4.
- AI attribution overlay in the canvas itself (text-level provenance via Milkdown already handles content; canvas-level attribution deferred).
- Approve / reject "AI proposed changes" UX. Today's flow auto-applies; reconsider if user feedback demands it.
- **Real-time multi-user co-editing of canvas structure** (collaborative-editor style). The delta abstraction (D5) leaves room to add a CRDT layer on top of the delta log later if needed — deltas correspond closely to CRDT ops, so the addition would be additive rather than a rewrite. Not pursued in M1–M4 because (a) Huabu's current workload is single-user + agent + multi-tab; (b) CRDT-for-structure requires non-trivial invariant-compensation machinery (label uniqueness, frame nesting, edge integrity) that off-the-shelf Yjs cannot enforce.

## Validation Strategy

Per milestone:

1. **Static**: `pnpm --filter web typecheck && pnpm --filter server typecheck && pnpm --filter @huabu/shared typecheck && pnpm lint`.
2. **Behavioral**: existing `apps/server/evals/cases/*.yml` all pass.
3. **Manual smoke (M2)**: trigger an agent that creates a node with content; verify server-side preprocessing fires; verify chat-message Revert removes the node.
4. **Manual smoke (M3)**: open two tabs; drag a node in tab A; tab B converges within 100 ms; click Revert in tab A's chat; tab B sees the revert.

## Sequencing

```
M1 (extract engine) → M2 (server execute + log) → M3 (log broadcast + optimistic) → M4 (Yjs)
```

Solo dev: strictly sequential.

Two devs: M4 can start in parallel after M1 lands (M4 only requires `nodes/*.md` interface, which is stable; it does not touch the command log).
