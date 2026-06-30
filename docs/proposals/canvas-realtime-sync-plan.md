# Canvas Real-time Sync (M3 Cross-tab Broadcast) — Design Notes

> Working document capturing the decisions made (and still open) for syncing
> out-of-band canvas mutations (ACP agent / other tabs) to live frontends.
> This is the "M3 cross-tab broadcast" repeatedly referenced in
> `canvas-executor.ts` comments.

## 1. Problem Statement

The built-in agent's canvas writes auto-refresh the frontend, but the ACP
agent's writes do not. Root cause:

- **Built-in agent**: `canvas_commands` runs server-side, but its result
  (`deltas` / `toVersion` / `pendingEffects`) is streamed back **inside the
  same agent SSE stream** the frontend is already listening to. The web client
  applies it locally via `applyDeltasFromAgent` → instant refresh. The
  initiating tab is both the sender and the receiver of that stream.
- **ACP agent**: this is ALSO a **user-initiated, interactive** session — the
  user chats with the ACP agent in the frontend (`/api/acp/threads/:threadId`)
  and the chat panel renders its tool cards. The difference is purely the
  **transport of the canvas mutation**: the external agent process writes via a
  **separate, out-of-band HTTP** `POST /api/canvas/:canvasId/execute` issued by
  the spawned reachback CLI (`originator: { source: 'agent' }`, currently with
  **no threadId correlation**). The response (`pendingEffects`) returns to that
  CLI process, **not** the browser. There is **no server→frontend broadcast
  channel**, so the live frontend's canvas store never receives the delta — even
  though a tool card for the write does show in the ACP chat. (ACP's `/execute`
  is issued by the daemon process, not the user's tab, so the user's tab has no
  "self echo" to filter — it legitimately needs the broadcast.)
- The `external-watcher` does not cover this: it only emits `.md` files whose
  `noteId` is **not** already on the canvas; ACP-written nodes are already in
  `canvas.json`, so `buildItem` returns `null`.

`canvas-executor.ts` comments confirm the intended fix is the unshipped
"M3 cross-tab broadcast".

## 2. Chosen Approach — Server-side Broadcast Channel (Plan A / M3)

Reuse the existing publish/subscribe pattern from `external-watcher.ts` +
`external.route.ts`, and reuse the **already-existing** client applier
`applyDeltasFromAgent`. The missing piece is only the server→client broadcast
hop.

Unified data flow (single fan-out point at `executeOnServer`):

```
User edit (optimistic local)  ─┐
Built-in agent /execute        ├─► executeOnServer ─► publishCanvasUpdate ─► SSE ─► all subscribed tabs
ACP /execute                  ─┘                                                   (skip own echo via clientId)
```

### Why this fits

- `executeOnServer` already produces `deltas`, `fromVersion`, `toVersion`,
  `pendingEffects`, and `originator`, and already appends a delta-log entry
  with a monotonic version. Broadcast just emits these.
- The web client already has `applyDeltasFromAgent(deltas, toVersion,
pendingEffects)` which replays an id-keyed structural diff, reconciles the
  local `version`, and is "fail open" (tolerates REPLACE/DELETE against missing
  targets).
- Bonus: cross-tab / multi-window (Electron) sync comes for free.

---

## 3. Confirmed Decisions

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

Adopt the tldraw/Figma/Cursor consensus, but classify by **who initiated the
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

## 4. Open / To-Confirm Decisions

### O1 — Reversibility UX, split by category (a/b/c)

For **(c) truly remote** changes: checkpoint + badge/toast (not global undo).
For **(b) ACP** changes: same per-card revert as the built-in agent, which
requires threadId/run-id correlation through `/execute` → broadcast → card. To
confirm: the correlation id to use (ACP `threadId` vs a dedicated run id) and
whether (b) also joins this tab's global undo or only the chat-card revert.

### O2 — Server-side preprocessing for headless `/execute`

Confirmed in principle (C4: ACP originator = server runs preprocessing). To
confirm: implement server-side preprocessing for `/execute` writes now, and the
exact "already-preprocessed" writeback tag/marker.

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

## 5. Implementation Outline (when greenlit)

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
