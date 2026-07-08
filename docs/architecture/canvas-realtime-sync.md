# Canvas Real-Time Sync

## Overview

Out-of-band and in-process canvas mutations propagate to **every open tab** of
the same canvas over a Server-Sent Events (SSE) stream, without a manual
reload. This is the **multi-agent** substrate: any mix of the built-in chat
agent, question-node agents, ACP agents, and headless `/execute` callers can
write concurrently and all live tabs converge.

Two channels cooperate:

- **Structure** — server-authoritative op-log. Every persisted batch produces a
  coarse `Delta[]` diff that is broadcast and replayed id-keyed on each client.
- **Change review** — per-conversation records (label + inverse deltas +
  staleness fingerprint) attributed to a `threadId`, rendered as a Keep/Revert
  card above the chat input.

`version` (monotonic per canvas) is the concurrency primitive; a **dirty-node**
filter guarantees an incoming agent write never clobbers a node the user is
mid-editing.

> Roadmap for what is **not** yet built (cross-tab user-edit sync, `clientId`
> echo filter, field-level deltas, presence, Yjs content co-editing, cloud
> fan-out) lives in the proposal
> [canvas-realtime-sync-plan.md](../proposals/canvas-realtime-sync-plan.md).

## Data flow

```
writer (agent / ACP / headless /execute)
  │
  ▼
executeOnServer  ── per-canvas mutex ──► persist .md + canvas.json
  │                                      append delta-log, bump version
  │                                      (optional) computeChanges → sidecar
  ▼
publishCanvasUpdate(canvasId, { type:'update', fromVersion, toVersion,
                                deltas, pendingEffects, threadId?, changes? })
  │  in-memory pub/sub (listenersByCanvas)
  ▼
GET /:canvasId/sync/stream  (SSE, one per tab)
  │
  ▼
canvasSyncStore  ── fromVersion === local? ──► applyDeltasFromAgent (dirty-filtered)
  │                └ gap (toVersion > local) ─► loadCanvas  (skipped if local dirty)
  ▼
canvasStore state  +  acpThreadChangesStore.replaceFromBroadcast(threadId, changes)
```

## Broadcast contract

The wire event is defined once in
[canvas-sync.ts](../../packages/shared/src/types/api/canvas-sync.ts) (zod
schema + `z.infer`, web imports as `import type` only):

| Event      | When                        | Payload                                                                                       |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `snapshot` | once, on SSE connect        | `{ version }` — lets a tab that connected _after_ a mutation detect the gap and `loadCanvas`. |
| `update`   | after every persisted batch | `{ fromVersion, toVersion, deltas, pendingEffects, threadId?, changes? }`                     |

- `deltas` / `pendingEffects.mutatedNodes` are `unknown` on the wire (they mirror
  the loosely-typed `PostCanvasExecuteResponse`; the engine `Delta` / `CanvasNode`
  shapes live in the canvas-engine module, not the API layer). The client casts.
- `threadId` + `changes` are present **only** for thread-attributed batches; they
  feed the originating conversation's review card.

## One write path, one broadcast

`executeOnServer` broadcasts **unconditionally** after persisting a non-empty
batch — there is no per-caller broadcast flag. This unifies all writers:

- The built-in chat and question-node agents mutate the canvas in-process via
  `executeOnServer`. Their chat SSE tool result is now **UI-only** (tool card +
  the annotated command list); it does **not** apply canvas state. The
  initiating tab is a plain receiver that applies its own change once, from the
  broadcast.
- ACP / headless writers hit `POST /:canvasId/execute`, which calls the same
  `executeOnServer`.
- Sketch recognition is now a normal server-applied writer too: it runs the
  agent through `executeOnServer` under a synthetic per-recognition `threadId`,
  so the mutation is broadcast + produces change records like any other agent
  batch. The on-canvas sketch overlay drives Keep / Revert / Preview off those
  records (same as the chat `ChangeReviewCard`) — there is no longer a
  client-side apply carve-out.
- There is **no per-client echo filter** yet: correctness relies on the single
  apply path + id-keyed `applyDeltas`. A `clientId` filter is only needed once
  user hand-edits also broadcast (deferred — see the plan).

## Conflict model — version + dirty-node protection

`applyDeltasFromAgent` filters incoming deltas against the set of nodes with
un-persisted local content edits (`nodeContentQueue.pendingNodeIds()` —
debounced-but-unsaved plus in-flight PUTs):

```
INSERT_NODE (new id)     → always apply (fresh ids never collide)
REPLACE_NODE / DELETE_NODE on a dirty id → SKIP (keep the human's unsaved edit)
otherwise                → apply
```

- Resolution is deterministic **local-first**: a skipped node keeps the human's
  value, and its post-effects (preprocessing / fit) are skipped too. `version`
  still advances to `toVersion` so the next autosave doesn't 409.
- On a **version gap** (`toVersion > local`), the tab catches up with
  `loadCanvas` — but **only when there are no dirty nodes**. With local dirty
  state a blind `loadCanvas` would lose the edit, so the tab defers to autosave's
  409 path (existing sticky "modified elsewhere" toast + Reload) instead.
- **Scope:** content only. Same-node _structure_ conflicts (geometry / parent)
  stay coarse — there is no per-node structure-dirty tracking yet.

Skipped ids flow back through `canvasSyncStore` into `acpThreadChangesStore`
(`conflictedByThread`) and surface as:

- a persistent, dismissible **warning toast** at the moment of the skip;
- the review row rendered as a **conflict** (`· skipped`, warning icon, revert
  disabled);
- a **`ConflictBadge`** count on the question node's "done" badge, so a
  partially-applied run is never silently reported as fully done.

## Change records & the review card

Change records are derived **purely from a batch's `Delta[]`**, so revert is a
generic operation — no per-command inverse logic:

- [change.ts](../../packages/shared/src/canvas-engine/change.ts) —
  `extractCanvasChanges` builds one `CanvasChangeRecord` per node/edge delta,
  carrying the **inverse delta** (`applyDeltas(state, revertDeltas)` undoes it,
  content included). `coalesceChanges` folds every record targeting the same
  entity into one **net** record (a create+delete nets to nothing and drops out).
- **Staleness:** UPDATE / CREATE records carry a `fingerprintKeys` +
  `appliedFingerprint` over only the fields the edit actually changed. Before
  reverting, the client recomputes the current node's fingerprint over the same
  keys; a mismatch means a field this edit changed was modified again since, so
  revert is blocked. Later system rewrites of untouched fields (preprocessing
  regenerating `label` / `summary`, a re-measure) therefore never falsely block
  revert. Structural (create/delete/connect/…) records are existence-based.

Records are persisted per thread in a mutable sidecar
(`<threadId>.changes.json`, coalesced on read) and reach the frontend two ways:
`load()` on thread open, and `replaceFromBroadcast()` (the broadcast carries the
thread's full coalesced list, so the client replaces rather than appends).

The [ChangeReviewCard](../../apps/web/src/components/Panels/ChatPanel/ChangeReviewCard.tsx)
above the chat input renders the thread's records with per-item and bulk
Keep / Revert, plus press-and-hold **preview** (temporarily applies the inverse
deltas without autosave). It renders for the built-in chat, question-node, and
ACP threads alike. The per-message
[CanvasCommandCard](../../apps/web/src/components/Messages/AIMessage/Tool/CanvasCommandCard.tsx)
is now **display-only**.

**Revert path:** `POST /:canvasId/threads/:threadId/changes/:changeId/revert`
applies the record's inverse deltas server-side via `applyDeltasOnServer`
(persist → delta-log → bump version → broadcast), then drops the record. So a
revert propagates to every tab through the same broadcast as any other write.
`Keep` (`DELETE …/changes/:changeId`) just discards the record.

## Thread attribution

To attach a canvas change to the right conversation's card, the initiating
`threadId` rides the write:

- **Built-in / question-node agent:** `agent.route.ts` passes `threadId` →
  `runAgent` → tool build context → `handleCanvasCommands` sets
  `originator.threadId` and `computeChanges: true`.
- **ACP agent:** the daemon injects `HUABU_THREAD_ID`; the reachback tool puts
  it on the `/execute` `originator` (and forwards `hostThreadId` to the
  reachback `askAgent` route).

`executeOnServer` computes review records only when `computeChanges` is set
(i.e. thread-attributed batches), so untagged writers pay no cost. When a
`threadId` is present the batch's records are folded into the thread's coalesced
sidecar and that full list is broadcast as `changes`.

## Preprocessing cost dedup

When N tabs replay the same broadcast delta they each schedule an identical
`preprocess` request. [PreprocessDispatcher](../../apps/server/src/modules/preprocessing/dispatcher.ts)
**coalesces concurrent identical requests** via
[coalesceInFlight](../../apps/server/src/modules/preprocessing/coalesce.ts):
requests keyed the same (`dedupeKey` over canvasId / nodeId / type / trigger /
hashed snapshots / options) share one in-flight promise; the entry evicts on
settle. The expensive pipeline (extract + LLM enrich) therefore runs **once**
regardless of tab count. The remaining _ownership_ cleanup (receivers not
triggering at all, plus a server-owned trigger + enriched writeback broadcast)
is deferred — see the plan.

## Undo interaction

Broadcast applies take **one** undo snapshot per batch (via
`applyDeltasFromAgent`). Two host-side refinements keep undo coherent with sync:

- **Transient-field parity.** `diff.ts` and the web snapshotter share one
  canonical `TRANSIENT_NODE_FIELDS` / `TRANSIENT_EDGE_FIELDS` list
  (`selected` / `dragging` / `measured` / `resizing`) so a pure selection flip
  never diffs into a phantom REPLACE, and undo/redo re-applies the live
  transient fields instead of clearing selection.
- **Question-node data preservation.** Undo/redo restores a question node's
  geometry but keeps its **live** `data` (thread binding, answer) — that payload
  is system-driven, so rewinding a move must not wipe it.

## Known reliability gaps

Consistent with the sibling `external.route.ts`, and acceptable for the
single-process, `127.0.0.1` desktop topology — but tracked:

- **No SSE heartbeat.** The stream sends `: ok` once on connect and then only on
  updates; there is no periodic ping. Behind an idle-timeout proxy the
  connection could be dropped.
- **No client auto-reconnect.** `canvasSyncStore.connect()` uses `fetch` +
  `readTypedSSEStream` (not native `EventSource`), so a dropped stream is not
  re-established until the canvas is switched / reloaded. Reconnect would piggy-
  back on the existing snapshot-on-connect reconcile to heal the gap.
- **Revert-route TOCTOU.** The revert handler reads the record and removes it
  outside the per-canvas mutex (only `applyDeltasOnServer` is inside), so two
  concurrent reverts of the same change could double-apply. Negligible on
  single-user desktop; folded away by P3's unified write path.

## Code entry points

| File / dir                                                                                                                                                                | Responsibility                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [types/api/canvas-sync.ts](../../packages/shared/src/types/api/canvas-sync.ts)                                                                                            | Wire schema for `snapshot` / `update` events + thread-changes responses.                          |
| [canvas-engine/change.ts](../../packages/shared/src/canvas-engine/change.ts)                                                                                              | `extractCanvasChanges`, `coalesceChanges`, inverse deltas, staleness fingerprint.                 |
| [canvas-engine/diff.ts](../../packages/shared/src/canvas-engine/diff.ts)                                                                                                  | `diffCanvasState` + shared transient-field stripping.                                             |
| [canvas/canvas-sync.ts](../../apps/server/src/modules/canvas/canvas-sync.ts)                                                                                              | In-memory pub/sub (`publishCanvasUpdate` / `subscribeCanvasUpdates`).                             |
| [canvas/sync.route.ts](../../apps/server/src/modules/canvas/sync.route.ts)                                                                                                | `GET /:canvasId/sync/stream` SSE (snapshot handshake + forward updates).                          |
| [canvas/canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)                                                                                      | `executeOnServer` (always broadcasts, optional `computeChanges`); `applyDeltasOnServer` (revert). |
| [canvas/canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts)                                                                                            | `/execute`; `GET`/`DELETE` `…/threads/:threadId/changes[/:changeId]`; `…/:changeId/revert`.       |
| [storage/canvas-store.ts](../../apps/server/src/modules/storage/canvas-store.ts)                                                                                          | Change-record sidecar (`readChanges` / `writeChanges` / `appendChanges` / `removeChange`).        |
| [storage/paths.ts](../../apps/server/src/modules/storage/paths.ts)                                                                                                        | `changesPath` (`<threadId>.changes.json`).                                                        |
| [preprocessing/coalesce.ts](../../apps/server/src/modules/preprocessing/coalesce.ts) · [dispatcher.ts](../../apps/server/src/modules/preprocessing/dispatcher.ts)         | In-flight request coalescing.                                                                     |
| [reachback/huabu-reachback-tool.mjs](../../apps/server/src/reachback/huabu-reachback-tool.mjs) · [reachback.route.ts](../../apps/server/src/reachback/reachback.route.ts) | `HUABU_THREAD_ID` → `originator.threadId` / `hostThreadId`.                                       |
| [store/canvasSyncStore.ts](../../apps/web/src/store/canvasSyncStore.ts)                                                                                                   | SSE subscriber: reconcile, apply, dirty-gap guard, conflict toast, thread attribution.            |
| [store/acpThreadChangesStore.ts](../../apps/web/src/store/acpThreadChangesStore.ts)                                                                                       | Per-thread change records + staleness (`isChangeStale`), Keep / Revert.                           |
| [store/canvasStore.ts](../../apps/web/src/store/canvasStore.ts)                                                                                                           | `applyDeltasFromAgent` (dirty filter), `pendingContentNodeIds`.                                   |
| [ChangeReviewCard.tsx](../../apps/web/src/components/Panels/ChatPanel/ChangeReviewCard.tsx)                                                                               | Above-input Keep / Revert / preview card.                                                         |
| [pages/CanvasPage/CanvasPage.tsx](../../apps/web/src/pages/CanvasPage/CanvasPage.tsx)                                                                                     | Connects / disconnects the sync stream on canvas load / switch.                                   |
