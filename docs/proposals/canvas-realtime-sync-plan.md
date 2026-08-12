# Canvas Collaboration Sync — Upgrade Roadmap (Multi-Agent → Multi-User)

Status: In-Progress — P0 + P1 shipped; P2 is the next milestone.
Last updated: 2026-07-02

> **Shipped foundation (P0 + P1)** is documented in
> [../architecture/canvas-realtime-sync.md](../architecture/canvas-realtime-sync.md).
> This proposal now tracks only what remains (P2 onward).

> **End goal:** one canvas edited concurrently by **many agents and many
> humans**, converging without lost edits or forced reloads. We get there in
> two waves — **multi-agent first** (several agents + several tabs on one
> desktop), **multi-user second** (multiple people, presence, identity,
> cloud). This doc is the single roadmap: what already ships, what's next, in
> priority order, with the uplift each step buys. Milestone/PR mechanics and
> the engine-extraction history live in the sibling
> [headless-executor-plan.md](./headless-executor-plan.md) (Phase A/B, M1–M4);
> the original M3 broadcast decisions are preserved verbatim in Appendix A.

## 0. End state & the two-wave strategy

The target is a **hybrid**, matching the industry consensus —
**no single CRDT for everything**, because structure and content have
different conflict semantics:

| Concern                                               | Model                                                                                                  | Why                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Structure** (nodes, edges, geometry, frame nesting) | Server-authoritative **op-log** (delta event-sourcing), evolving to field-level deltas + server rebase | Hard invariants (label uniqueness, frame nesting, edge integrity) are easiest to enforce centrally |
| **Content** (per-node markdown body)                  | **Yjs CRDT** per node over WebSocket, `.md` canonical                                                  | Character-level merge; last-writer-wins loses keystrokes                                           |
| **Presence** (cursors, selection, "who's here")       | Ephemeral awareness over the same WebSocket                                                            | Not persisted; per-session                                                                         |
| **Identity / permissions**                            | Auth layer + `userId` on every `originator`                                                            | Multi-user prerequisite                                                                            |

Two waves:

- **Wave 1 — Multi-agent (P1–P2).** N agents (built-in + ACP + headless) and
  N tabs on the _same_ desktop server converge safely. No identity needed.
- **Wave 2 — Multi-user (P3–P6).** Structural co-edit without conflicts, text
  co-editing, presence, identity, and multi-device / cloud infra.

## 1. Shipped foundation (P0 + P1)

The delta-based event-sourcing substrate, the out-of-band SSE broadcast, the
dirty-node conflict model, and the per-thread change-review card are **shipped**
and documented in
[../architecture/canvas-realtime-sync.md](../architecture/canvas-realtime-sync.md).

<details>
<summary>P0/P1 capability map (historical)</summary>

The delta-based event-sourcing substrate **and** the out-of-band broadcast are
in place. What ships today:

| Capability                                                                                | Status | Where                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared engine + coarse deltas (`INSERT`/`DELETE`/`REPLACE_NODE`), fail-open `applyDeltas` | ✅     | [canvas-engine](../../packages/shared/src/canvas-engine)                                                                                                               |
| Server-side executor + per-canvas mutex + monotonic `version`                             | ✅     | [canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)                                                                                          |
| Persistent delta log (`.history/delta-log.jsonl`)                                         | ✅     | [canvas-store.ts](../../apps/server/src/modules/storage/canvas-store.ts)                                                                                               |
| `POST /:id/execute` headless write path                                                   | ✅     | [canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts)                                                                                                |
| In-memory pub/sub + `GET /:id/sync/stream` SSE                                            | ✅     | [canvas-sync.ts](../../apps/server/src/modules/canvas/canvas-sync.ts), [sync.route.ts](../../apps/server/src/modules/canvas/sync.route.ts)                             |
| Web sync subscriber → `applyDeltasFromAgent`                                              | ✅     | [canvasSyncStore.ts](../../apps/web/src/store/canvasSyncStore.ts)                                                                                                      |
| **All agent writes broadcast to every tab** (unconditional)                               | ✅     | `executeOnServer` always publishes ([canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts))                                                     |
| ACP chat-card correlation (`threadId` + `changes` + per-card revert)                      | ✅     | [acpThreadChangesStore.ts](../../apps/web/src/store/acpThreadChangesStore.ts), revert route in [canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts) |
| Snapshot-on-connect version reconcile (gap → `loadCanvas`)                                | ✅     | [canvasSyncStore.ts](../../apps/web/src/store/canvasSyncStore.ts)                                                                                                      |

</details>

**Gaps remaining after P1** (= the P2 backlog): no `clientId` echo filter
(needed only once user hand-edits broadcast); broadcast receivers still _trigger_
preprocessing (cost already deduped server-side, ownership cleanup pending);
version gaps do a full `loadCanvas` (incremental delta-log backfill pending) —
now skipped while the tab has un-persisted local edits; user hand-edits don't
propagate to other tabs at all.

## 2. Roadmap (priority order)

Legend: ✅ shipped · 🟡 partial · ⬜ todo.

### P1 — Multi-agent correctness — ✅ SHIPPED

Folded into
[../architecture/canvas-realtime-sync.md](../architecture/canvas-realtime-sync.md).
The one deferred remainder (O2 preprocessing _ownership_) is tracked under P2
below. Original rationale kept for history:

<details>
<summary>P1 detail (shipped)</summary>

Makes "several agents + several tabs on one desktop" actually safe. Every item
is a small, independently shippable fix on top of P0.

- ✅ **C2 — all built-in agents broadcast-only (unified with ACP).** _Shipped +
  verified._ The built-in chat **and question-node** agents deliver canvas
  mutations _only_ via the sync broadcast, like ACP — the chat SSE tool result
  no longer applies state, so the initiating tab is a plain receiver (**no
  self-echo, no `clientId`**; C5 moved to P2). Broadcasting is now
  **unconditional** in `executeOnServer` — the per-caller `broadcastCanvasWrites`
  / `broadcast` flag chain was removed
  ([canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts),
  [agent.service.ts](../../apps/server/src/modules/agent/agent.service.ts),
  [canvas-write.ts](../../apps/server/src/modules/agent/tools/handlers/canvas-write.ts)).
  `animateCanvasCommandsFromToolResult` no longer applies state or extracts
  client-side changes — it just surfaces the command list + animation
  ([useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts)). Revert is
  owned by the per-thread `ChangeReviewCard` (renamed from `AcpChangeCard`, now
  renders for internal bindings too) fed by the broadcast `changes`
  ([ChangeReviewCard.tsx](../../apps/web/src/components/Panels/ChatPanel/ChangeReviewCard.tsx)).
  The per-message `CanvasCommandCard` is now display-only; its dead revert path
  was deleted. (A `sketch-recognized` carve-out existed here until sketch
  gesture recognition was removed; every writer now goes through broadcast.)
- 🟡 **C4 / O2 — preprocessing cost deduped (full ownership deferred to P2).**
  Duplicate **work** is fixed:
  [PreprocessDispatcher](../../apps/server/src/modules/preprocessing/dispatcher.ts)
  coalesces concurrent identical requests
  ([coalesce.ts](../../apps/server/src/modules/preprocessing/coalesce.ts)), so N
  tabs replaying one broadcast delta run the pipeline (extract + LLM enrich)
  **once**, not N times. This removed the actual harm (N× LLM / embedding
  cost). The remaining _ownership_ cleanup — receivers not _triggering_ at all
  (`applyDeltasFromAgent` still calls `triggerPreprocessing`, now cheap) plus a
  server-side trigger + enriched writeback broadcast — is **moved to P2**: it
  shares the "server produces a delta → broadcast" mechanism with Plan A and is
  no longer cost-urgent, so it is not worth its medium risk on its own.
- ✅ **C3 — `dirtyNodeIds` protection + conflict surfacing.** _Shipped._
  `applyDeltasFromAgent` skips incoming `REPLACE`/`DELETE` deltas targeting a
  node with un-persisted local **content** edits (pending debounced save or
  in-flight PUT, exposed via `nodeContentQueue.pendingNodeIds()`), so an agent
  write never clobbers what a human is mid-typing — `INSERT` always applies.
  Resolution is deterministic **local-first**: the skipped node keeps the
  human's value and post-effects (preprocessing / fit) skip it too; `version`
  still advances to `toVersion` so the next autosave doesn't 409. The skipped
  ids flow back through `canvasSyncStore` into `acpThreadChangesStore`
  (`conflictedByThread`); the `ChangeReviewCard` renders those rows as
  **conflicts** ("· skipped", warning icon, revert disabled) and the question
  node's **done** badge grows a warning `ConflictBadge` count — surfacing the
  conflict per node/thread instead of a global toast. **Scope:** content only;
  same-node **structure** conflicts (geometry/parent) stay coarse — no per-node
  structure-dirty tracking yet, rebased away by P3's field-level deltas.

**Uplift:** any mix of built-in + ACP + headless agents writing concurrently
converges on _every_ open tab — no double-apply, no duplicate embeddings, no
lost local edits. The happy path (in-order broadcasts) already applies
incrementally; only the rare version-gap case still falls back to a full
`loadCanvas` (the incremental gap-heal is deferred to P2). This is
"multi-agent done."

</details>

### P2 — Multi-window user-edit sync (Plan A) ← Wave 1 finish

- ⬜ **Plan A (C6).** On the autosave PUT, the server diffs old→new and
  broadcasts the resulting deltas to _other_ `clientId`s. Minimal client
  change; ~1s debounce latency; reuses the existing 409 safety net.
- ⬜ **C5 — per-client echo filter.** Deferred from P1: only _now_ needed,
  because with user edits broadcasting (Plan A) a tab must skip its **own** PUT
  echo. Each tab mints a `clientId`, carried on `/execute` + PUT `originator`;
  the broadcast carries `originatorClientId`; the receiver skips its own. (The
  built-in agent no longer needs this once C2 makes it a pure receiver.)
- ⬜ **O2 — server-owned preprocessing + writeback broadcast.** Moved here from
  P1 (cost already deduped by coalescing). Make broadcast receivers skip
  `triggerPreprocessing` (`applyDeltasFromAgent` gains a `preprocess` toggle;
  [canvasSyncStore.ts](../../apps/web/src/store/canvasSyncStore.ts) passes
  `false`, the built-in-agent path keeps `true`); run preprocessing once
  server-side for broadcast `/execute` writes; broadcast the enriched writeback
  (label / summary / keywords) as a `MERGE_NODE_DATA` delta, guarded against
  re-triggering itself. Reuses the same PUT→diff→broadcast path as Plan A.
  ~5 files, medium risk (loop guard, server-side snapshot fidelity, async
  writeback timing).
- ⬜ **Log backfill.** Wire `GET /:id/log?since=v` into the sync store so a
  version gap heals incrementally instead of a full `loadCanvas` flicker. Pure
  optimization of the existing gap fallback (not needed for correctness); more
  valuable here because Plan A's user-edit broadcasts raise gap frequency.
- ⬜ **Reversibility category (c) (C7 phase 1).** Checkpoint "restore to the
  version before this run" (the delta log already supports it) + AI-change
  badges via `NodeOrigin`; a transient undoable toast for truly-remote
  changes. Keep remote changes OUT of this tab's global undo stack.
- ⬜ **Broadcast the change-card _list state_ across tabs.** Today only the
  canvas deltas broadcast; the per-thread change records (`acpThreadChangesStore`)
  do **not** re-sync when another tab Accepts/Reverts. So tab B's above-input
  card can go stale (still lists a change tab A already kept/reverted). Fix:
  when a change is accepted (`DELETE …/changes/:id`) or reverted, also broadcast
  the thread's updated coalesced list (reuse the `update` event's `threadId` +
  `changes`) so every tab's `replaceFromBroadcast` converges. Low-medium risk,
  additive.
- ⬜ **SSE reliability (heartbeat + client auto-reconnect).** The sync stream
  has no periodic keep-alive and `canvasSyncStore` (a `fetch` + typed-SSE reader,
  not native `EventSource`) does not reconnect on drop, so a broken stream stays
  broken until a canvas switch / reload. Add a server-side `: ping` interval
  (cleared on close) to both SSE routes, and a client exponential-backoff
  reconnect that re-runs the snapshot-on-connect reconcile to heal the gap.
  Low risk; matches the current `external.route.ts` gap too.
- ⬜ **Revert-route atomicity.** The `…/changes/:changeId/revert` handler reads
  the record and removes it outside the per-canvas mutex (only
  `applyDeltasOnServer` is inside), so two concurrent reverts of the same change
  could double-apply. Wrap read → apply → remove in `withCanvasMutex`, or make
  removal a compare-and-remove that skips apply when the record is already gone.
  Negligible on single-user desktop; superseded by P3's unified write path.

**Uplift:** two windows/tabs on the same device editing one canvas see each
other's edits within ~1s; remote changes are reviewable (badge / checkpoint)
instead of triggering a forced reload.

### P3 — Unified write path + field-level deltas + rebase ← Wave 2 foundation

The structural-conflict engine for real multi-user. Aligns with the headless
plan's Phase B (M3.5–3.9).

- ⬜ **Plan B (C6 / D8).** Route user edits through `/execute`: optimistic local
  apply + async post + reconcile on broadcast + rollback on failure. One write
  path, server as source of truth, immediate propagation (no 1s debounce).
- ⬜ **Field-level deltas (D5, deferred M1 task 1.7).** Replace coarse
  `REPLACE_NODE` with `SET_GEOMETRY` / `SET_DATA(key)` / `SET_NODE_PARENT` so
  two clients editing _different fields_ of one node don't clobber.
- ⬜ **Server rebase.** Re-expand a command against current head; `clientId` +
  `optimisticTag` reconcile predicted vs authoritative deltas.
- ⬜ **Retire PUT + 409 (M3.7 / 3.8).** Full re-saves become a `RESET_CANVAS`
  `/execute`; the "modified elsewhere" conflict toast disappears.

**Uplift:** two users editing the same node's different fields merge cleanly;
the 409 conflict wall is gone; concurrent structural editing becomes safe.

### P4 — Content co-editing (Yjs) ← Wave 2 (text)

- ⬜ **Yjs per node over WebSocket (D3 / headless M4).** `.md` canonical, Y.Doc
  a transient mirror seeded on open and flushed debounced. Orthogonal to the
  structure channel (P1–P3); can proceed in parallel once the WS transport
  from P5 exists.

**Uplift:** two people typing in the same note body merge at character level
instead of last-writer-wins.

### P5 — Presence + identity + permissions ← Wave 2 (the "multi-user" gate)

- ⬜ **WebSocket transport consolidation.** Replace SSE + PUT for the sync /
  presence channel with a single bidirectional connection (one-way agent
  streams can stay on SSE). Prerequisite for low-latency co-edit + awareness.
- ⬜ **Awareness.** Live cursors, selections, "who's on this canvas."
- ⬜ **Identity / auth / per-canvas permissions.** Currently zero — the real
  gate for multi-user, and larger than the sync algorithm itself.
- ⬜ **Attribute everything to `userId`.** Extend `originator`; deltas,
  change-cards, undo, and badges all become per-person.

**Uplift:** real multi-user — see collaborators live, changes attributed to
people, access controlled.

### P6 — Multi-device / cloud infra ← Wave 2 (scale-out)

- ⬜ **Broker-backed pub/sub.** Replace the in-memory `listenersByCanvas` Map
  with Redis / NATS so multiple server replicas fan out to each other. (The
  Map is fine for one process / one desktop; "single process" — not "single
  client" — is its true ceiling.)
- ⬜ **Shared server + shared storage topology.** Today each desktop forks its
  own `127.0.0.1` server against local files, so two devices are two
  independent servers + two `canvas.json`s. Multi-device needs a shared
  authority (or a sync-of-syncs).
- ⬜ **`delta_log` → SQLite (D6).** Migrate the JSONL log to the table schema
  for indexed server-side `since=v` backfill at scale.

**Uplift:** multi-device and horizontally-scaled cloud deployments converge.

## 3. Dependency map

```
P0 (shipped)
 └─► P1 multi-agent correctness ──► P2 user-edit sync (Plan A)      ◄ Wave 1 done
       │  (C2 makes built-in agent a pure receiver — no clientId)
       └─► P3 unified path + field deltas + rebase
             ├─► P4 Yjs content (parallelizable; needs WS from P5)
             └─► P5 presence + identity ──► P6 cloud / multi-replica ◄ Wave 2 done
```

Critical path to **multi-agent**: P1. Critical path to **multi-user**:
P3 → P5 (+ P4 for text). P6 only when leaving the single-process desktop.

---

## Appendix A — Decision rationale (C1–C7, preserved)

> Preserved verbatim from the original M3 broadcast design. These decisions
> still govern the mechanisms above — P1–P2 are largely the implementation of
> C3–C7.
>
> **Note (2026-07):** the appendices below reference
> `apps/web/src/hooks/useCanvasChanges.ts` / `snapshotAndExtractChanges`, a
> client-side change-capture hook that has since been **deleted**. Revertible
> AI changes are now server-authored delta records surfaced through
> `acpThreadChangesStore`; read those names as the historical stand-in for that
> machinery.

### C1 — Plan A (server-side SSE broadcast) is the chosen mechanism

This is exactly the "M3 cross-tab broadcast" the codebase already anticipated.
Catch-up clients use `fromVersion` vs local `version`: matching → incremental
apply; mismatch (gap) → full `loadCanvas` fallback. `applyDeltas`'s fail-open
behavior is the second safety net.

### C2 — State mutation flows through ONE path (pure broadcast)

Collapse the two paths ("M3 will collapse the two paths once cross-tab
broadcast lands"):

- **State** is mutated only via the broadcast applier (`applyDeltasFromAgent`).
- The agent SSE `tool` result degrades to a **UI-only signal** (tool card,
  animation, per-card revert metadata). It no longer mutates canvas state.
- Latency is negligible: the built-in agent already runs server-side, so both
  the tool event and the broadcast originate from the same server over SSE
  (same process on desktop). Lower maintenance: one state path.
- Ordering nuance (tool card on agent stream vs state on sync stream): the
  receiving tab can `snapshotAndExtractChanges` right before applying the
  broadcast deltas (REPLACE deltas already carry before/after), and the card
  animation simply waits for state to land.

### C3 — Conflict model: version + "dirty node" protection. Local unsaved is NEVER overwritten.

`version` remains the concurrency primitive (autosave PUT keeps optimistic
concurrency; server-ahead → 409 → existing sticky toast + Reload). Layered on
top, a new **`dirtyNodeIds`** set (nodes with un-persisted local edits) filters
incoming broadcast deltas:

```
For each incoming delta:
  INSERT (new node)        → always safe to apply (ACP new nodes never collide)
  REPLACE / DELETE (exist) → if id ∈ dirtyNodeIds → SKIP (preserve local unsaved)
                           → else apply
```

`applyDeltas` is id-keyed, so locally-edited-but-not-in-delta nodes are
untouched. The only real hazard (same node edited locally + remotely) resolves
**local-first** by skipping that delta row. When `fromVersion !== localVersion`
(diverged) with local dirty state, do NOT blind-`loadCanvas` (would lose local
edits) — let autosave's 409 path arbitrate so unsaved edits are recoverable.

### C4 — Preprocessing: "whoever modified the canvas" runs it, exactly once; writeback also broadcasts without looping

- The **originator** of a canvas change runs preprocessing
  (embedding/summary). Receivers of a broadcast NEVER call
  `triggerPreprocessing`.
- For ACP / headless `/execute`, the originator is the **server** → server runs
  preprocessing.
- Preprocessing produces a **writeback** (embedding/summary), which is itself a
  canvas mutation → it goes through the same fan-out and broadcasts to others.
- Loop/duplication avoidance: tag the writeback (e.g. `origin: 'preprocess'`
  or touch only non-content fields) so the originator does NOT re-preprocess
  its own writeback. Receivers don't preprocess anyway, so they're safe.

### C5 — Echo filtering via per-client id

Each tab generates a `clientId`, carried on its `/execute` `originator` (and on
PUT). The broadcast event carries `originatorClientId`; a receiver skips events
whose `originatorClientId === own` to avoid double-applying its own change.

### C6 — Broadcast to other tabs WHILE keeping local editing optimistic

User edits stay optimistic (apply locally + render immediately, never wait for
backend). To propagate them to other tabs, prefer **Plan A first**:

- **Plan A (chosen first)**: user edit stays as today (optimistic local +
  debounced state PUT). The **server diffs old vs new state on PUT** to produce
  deltas and broadcasts them to **other** clientIds. Minimal client change;
  reuses the existing 409 safety net. Cost: other tabs see edits with up to the
  ~1s autosave debounce delay.
- **Plan B (later evolution)**: route user edits through the `/execute` command
  stream like the agent. Still optimistic — apply locally immediately, then
  fire `/execute` async (do not await); reconcile version on response/broadcast;
  roll back the optimistic apply on `/execute` failure. Finer deltas, immediate
  broadcast (no 1s debounce), single write path / server as source of truth.
  Cost: larger refactor (all UI mutations through `/execute`, plus optimistic
  rollback handling).

Decision: **ship Plan A first, treat Plan B as the "unified write path"
evolution target.**

### C7 — AI-change undo/reversibility model (industry-aligned, but split by origin)

Adopt the industry consensus, but classify by **who initiated the
change AND how its delta reaches the frontend** — there are THREE categories,
not two. ACP is user-initiated and interactive (it has a chat card), so it
belongs with the built-in agent in the "local interactive" bucket — NOT the
"remote" bucket. ACP differs from the built-in agent only in the transport of
its delta (broadcast instead of the chat SSE tool result).

| Category                                                             | Delta transport                                               | Reversibility strategy                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Built-in agent (this tab)**                                    | rides the chat SSE tool result (today)                        | local interactive: (1) whole **run** = one undo transaction; (2) streaming intermediate → **proposal layer**, not undo; (4) tool card + change badges.                                                                                              |
| **(b) ACP agent (this tab's chat session; external process writes)** | **must ride the broadcast** (delta is NOT in the chat stream) | **also local interactive, also has a chat card** → deserves the SAME per-card revert UX as (a). Requires threadId/run-id correlation (see below).                                                                                                   |
| **(c) Truly remote (other tab / other device / headless)**           | broadcast                                                     | **apply immediately** + (3) coarse **checkpoint** ("restore to before this run", on the existing delta-log/version) + (4) badge / "Agent changed N nodes" undoable toast. **No card in this tab; not in this tab's global undo; no proposal gate.** |

**ACP card correlation**: to give (b) the same revert card as (a), thread the
ACP `threadId` (or a session/run id) through the reachback `/execute`
`originator`, carry it in the broadcast event, and let the frontend attach the
canvas change to the matching ACP chat card (reusing
`snapshotAndExtractChanges` reverse commands). This is an additive enhancement
that can land after the basic refresh works.

Supporting facts from the codebase:

- Global undo is full-state snapshots (`canvasHistoryManager.takeSnapshot`);
  `applyDeltasFromAgent` already takes ONE snapshot per batch.
- AI changes are reverted today via per-message `CanvasCommandCard`
  (Revert / Keep), with reverse commands from `snapshotAndExtractChanges` — NOT
  via the global Ctrl+Z stack.
- `NodeOrigin` (`ai-operate` / `sketch-recognized`) already tags AI nodes →
  cheap basis for badges.
- Delta-log + version already exist → checkpoints are cheap ("restore to
  version N before the run").

Recommended build order for C7: **(3) checkpoint + (4) badges first** (directly
serves broadcast sync, lowest cost, same infra), then **(1) per-run undo
transaction**, then **(2) proposal layer last and only for the local
interactive agent**.

---

## Appendix B — Open questions (still open)

### O1 — Reversibility UX, split by category (a/b/c)

For **(c) truly remote** changes: checkpoint + badge/toast (not global undo).
For **(b) ACP** changes: same per-card revert as the built-in agent, which
requires threadId/run-id correlation through `/execute` → broadcast → card. To
confirm: the correlation id to use (ACP `threadId` vs a dedicated run id) and
whether (b) also joins this tab's global undo or only the chat-card revert.

### O2 — Server-side preprocessing for headless `/execute`

Confirmed in principle (C4: ACP originator = server runs preprocessing).
**Status:** the cost half shipped (dispatcher coalescing — see P1); the
ownership half (receivers skip + server trigger + enriched writeback
broadcast) is **scheduled under P2**, bundled with Plan A because it reuses the
same server-diff → broadcast path. Still to confirm: the exact
"already-preprocessed" writeback tag/marker used to break the re-trigger loop.

### O3 — Plan A vs Plan B sequencing

Confirmed: Plan A first (C6). To confirm whether/when to invest in Plan B
(unified `/execute` write path with optimistic rollback).

### O4 — Proposal layer (C7 item 2) scope and timing

Largest, most divergent piece (today agent edits apply immediately, no staging
overlay). To confirm: do we build a true staging/accept-gate layer for the
local interactive agent, and when? Remote/ACP explicitly bypass it.

### O5 — Per-run undo transaction grouping (C7 item 1)

Currently undo is per-`canvas_commands` batch (one snapshot each). Grouping a
whole multi-tool-call run into one transaction needs run lifecycle hooks
(open at run start, suppress intermediate snapshots, close at run end). To
confirm: do this for interactive runs; for long async runs interleaved with
user edits, defer to checkpoints (C7 item 3) instead.

---

## Appendix C — Original M3 implementation outline (maps to P0 / P1)

1. **Shared types** (`packages/shared/src/types/api/canvas-sync.ts`): zod schema
   - `z.infer` for the broadcast event (`snapshot` baseline + `update`
     carrying `fromVersion` / `toVersion` / `deltas` / `pendingEffects` /
     `originatorClientId`). Web imports as `import type` only.
2. **Server publisher** (`apps/server/.../canvas/canvas-sync.ts`): in-memory
   `listenersByCanvas`, `publishCanvasUpdate`, `subscribeCanvasUpdates` —
   mirror `external-watcher.ts`.
3. **Server hook-in**: emit from `executeOnServer` after
   `appendDeltaLogEntry` (skip the no-op fast path). For Plan A user-edit
   sync, also diff + publish on the autosave PUT path.
4. **Server SSE route** (`GET /:canvasId/sync/stream`): mirror
   `external.route.ts`; send a `snapshot` (current version) on connect, then
   forward published updates.
5. **Web subscribe store** (mirror `externalImportsStore.ts`, using
   `fetch` + `readTypedSSEStream` for auth): on `update`, skip own
   `clientId`; if `fromVersion === localVersion` apply via
   `applyDeltasFromAgent` filtered by `dirtyNodeIds`; else `loadCanvas`
   fallback. Never call `triggerPreprocessing` on received updates.
6. **Web wiring**: `_routes.ts` add `canvasSyncStream`; connect in
   `CanvasPage` after `loadCanvas`, disconnect on unmount / canvas switch.
7. **ACP card correlation (stage 1.5, additive)**: thread ACP `threadId` (or a
   run id) through the reachback `/execute` `originator` and into the broadcast
   event; frontend attaches the canvas change to the matching ACP chat card,
   reusing `snapshotAndExtractChanges` reverse commands. Independent of the
   basic refresh; can land later.
8. **Reversibility (C7 phase 1, category c)**: checkpoint
   (restore-to-version-before-run) + AI-change badges via `NodeOrigin`;
   transient undoable toast for truly-remote changes.

### Testing

- Server: publisher subscribe/unsubscribe/multi-subscriber; no-op batch does
  not publish.
- Integration: after `/execute`, a subscriber receives correct `toVersion` +
  deltas.
- Web: `fromVersion` aligned → incremental; gap → `loadCanvas`; own-echo
  filtered; `dirtyNodeIds` rows skipped; received updates do not preprocess.

### Non-goals / unaffected

- Server persistence, delta-log, `canvas.json` write path unchanged (only a
  trailing in-memory emit added).
- No change to the `/execute` request/response contract.
- No new dependencies. With zero subscribers, emit is a no-op (no perf impact).
