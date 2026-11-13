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

Space Shortcut does not open a target Canvas sync stream or fetch preview scenes. It shares workspace Space metadata for titles, target availability, node counts, and update timestamps, refreshed on entry and focus; local moves and renames also invalidate/refetch affected summaries. Inactive target content mutations appear on the next metadata refresh, not through live target subscriptions; see [space-preview.md](./space-preview.md).

World preview reconciliation is a system-originated command batch against World and publishes through World's existing delta stream when topology changes. Portal Pin routing, batched source-reference refreshes, and World `nodeRef` conversation presentation are retired. Opening an Agent conversation from a Space card subscribes to its dedicated owner-state SSE transport without loading or applying the source Canvas document; the server derives these snapshots from the existing Canvas publisher, and passive Space cards still do not subscribe.

`version` (monotonic per canvas) is the concurrency primitive; a **dirty-node**
filter guarantees an incoming agent write never clobbers a node the user is
mid-editing.

> Request ids and read versions on `execute` are shipped; see [reliable save](./canvas-storage.md#42-reliable-save-in-the-write). The browser sends its own structure edits through `execute` too, so they reach every other open page; see [Browser structure edits](#browser-structure-edits). Node content (body, title and the other sidecar fields) is saved per node and reaches the other pages as described under [Node content between pages](#node-content-between-pages). Two pages typing in the same body at once is not supported; the remaining proposal is [canvas-realtime-sync-plan.md](../proposals/canvas-realtime-sync-plan.md), and multi-server fan-out is outside that scope. Which other pages have the Space open, and what they point at, select, drag or edit, is [Space presence](#space-presence).

## Data flow

```
writer (agent / ACP / headless /execute / a browser page's send queue)
  │
  ▼
executeOnServer  ── per-canvas mutex ──► persist .md + space.json
  │                                      append delta-log, bump version
  │                                      (optional) computeChanges → sidecar
  ▼
publishCanvasUpdate(canvasId, { type:'update', fromVersion, toVersion,
                                deltas, pendingEffects, orderEvents?,
                                threadId?, changes?, operationId?, source })
  │  in-memory pub/sub (listenersByCanvas)
  ▼
GET /:canvasId/sync/stream  (SSE, one per tab)
  │
  ▼
canvasSyncStore  ── fromVersion === local? ──► applyDeltasFromAgent (field-level, dirty-filtered)
  │                │                            └ then orderEvents → sibling paint order
  │                └ gap (toVersion > local) ─► loadCanvas  (skipped if a body is dirty,
  │                                             held until the send queue is empty)
  ▼
canvasStore state  +  acpThreadChangesStore.replaceFromBroadcast(threadId, changes)
```

## Broadcast contract

The wire event is defined once in
[canvas-sync.ts](../../packages/shared/src/types/api/canvas-sync.ts) (zod
schema + `z.infer`, web imports as `import type` only):

| Event        | When                                                                         | Payload                                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`   | once, on SSE connect                                                         | `{ version }` — lets a tab that connected _after_ a mutation detect the gap and `loadCanvas`.                                                                                                                                                                 |
| `update`     | after every persisted batch                                                  | `{ fromVersion, toVersion, deltas, pendingEffects, orderEvents?, threadId?, changes?, agentNodeProjection?, operationId?, source? }`                                                                                                                          |
| `invalidate` | ordinary topology/content save, node-sidecar deletion or Space-tree deletion | `{ nodeIds?, originPageId? }` — refresh observed read models for those nodes, or every observed owner in that Space when omitted; not editable Canvas deltas. With `nodeIds`, a Canvas page fetches those nodes' content unless `originPageId` is its own id. |

`canvasSyncSubscription` manages the per-Space Canvas transport, preserving the 45-second inactivity timeout, heartbeat handling, rate-limit-aware 500ms-to-10s reconnect backoff, and version baselines for late subscribers. The final subscriber aborts the transport. Conversation views instead share one dedicated owner-state subscription per conversation address per page: the server listens to this same Canvas publisher, reads canonical ownership, and pushes complete versioned metadata snapshots. The browser applies those snapshots without querying ownership for each change or loading the source Canvas document. Reconnect, focus and visibility restoration obtain a fresh baseline. Canvas rendering never treats `invalidate` as a document replacement or as a reason to reload. An `invalidate` that names nodes makes the page fetch those nodes' content, see [Node content between pages](#node-content-between-pages); one without node ids is ignored by the Canvas page. See [conversation observation](./preview-workspace.md#3-opening-and-target-conversion).

- `deltas` / `pendingEffects.mutatedNodes` are `unknown` on the wire (they mirror
  the loosely-typed `PostCanvasExecuteResponse`; the engine `Delta` / `CanvasNode`
  shapes live in the canvas-engine module, not the API layer). The client casts.
- `threadId` + `changes` are present **only** for thread-attributed batches; they
  feed the originating conversation's review card.
- `orderEvents` is present only when an `executeOnServer` batch changed a parent's direct-child list; see [Sibling paint order](#sibling-paint-order).
- `agentNodeProjection` identifies trusted server binding/lifecycle/association effects for browser undo handling; it is output metadata, not client authorization to submit those writes.
- `operationId` is the request id the writer supplied, when it supplied one; a page uses it to recognise the update for its own batch. `source` is the batch's `originator.source` (`ui`, `agent` or `system`), set on every `executeOnServer` batch and absent on `applyDeltasOnServer` replays; a page uses it to tell another person's edit from an agent's.

## Sibling paint order

Entity `deltas` are keyed by id and cannot express stacking order: a pure `REORDER_NODES` batch commits with `deltas: []`. `executeOnServer` therefore calls `diffSiblingOrderEvents(prestateNodes, finalNodes, toVersion)` for every committed batch and attaches the result as `orderEvents` (`SetSiblingOrderEvent[]`, [contract](./canvas-command-architecture.md#sibling-paint-order-and-isolated-replay)) to the `update` event, to `publishCanvasExecution`, and to the `POST /execute` response. Each event lists one changed parent's complete direct-child ids before and after the commit, so a batch that creates, deletes or reparents nodes carries one too. The field is omitted when no list changed, and when the strict forest check rejects a legacy topology (the batch still commits and broadcasts entity-only). The schema validates each entry with `isSetSiblingOrderEvent`. A consumer that ignores the field behaves as it did before the field existed.

`applyDeltasFromAgent` takes the events as an optional argument. After the entity deltas are replayed and tree-normalized it calls `replaySiblingOrder` ([siblingOrderReplay.ts](../../apps/web/src/store/canvasStore/siblingOrderReplay.ts)), which runs `applySiblingOrderEvents` against the pre-batch local nodes — minus local optimistic copies of nodes the batch inserts — and installs the returned forest. An order-only batch no longer returns early; it takes one undo snapshot like any other editable batch.

If the events do not fit the local forest (`SiblingOrderReplayError`: stale `before` list, membership mismatch, invalid local topology) the store keeps the entity-only result and still adopts `toVersion`; nothing is partially reordered. It then compares each listed parent's local child order with the event's `after` list. Only when one differs, no delta row was withheld by dirty-node protection, and `hasUnsavedCanvasEdits()` is false does it call the caller's `onDiverged`: `canvasSyncStore` runs the same `loadCanvas(…, { resetHistory: true })` as a version gap, and the Question-creation HTTP path in `executeCommands` reloads the Space. With unsaved local edits the local order stays; the update for the page's own queued batch carries the order the server ended with.

Limits: `applyDeltasOnServer` batches (review revert, Agent Node projections, title updates) send no `orderEvents`, so a reverted deletion is still appended by entity replay. The delta log and Review records stay entity-only; the stored response of a request with an `operationId` does include `orderEvents`, so a replay returns what the first call returned. Each event carries two complete id lists, so its size grows with the changed parent's child count. The behaviour is covered by server and store tests, not by a two-browser run.

## One write path, one broadcast

`executeOnServer` normally broadcasts after persisting a non-empty batch. Trusted coordinated lifecycle callers can defer publication with the internal `publish: false` option and publish after their orchestration reaches its declared boundary. `applyDeltasOnServer` persists and returns its result; its caller owns publication. These exceptions do not expose a client-controlled broadcast policy.

- The built-in chat and question-node agents mutate the canvas in-process via
  `executeOnServer`. Their chat SSE tool result is now **UI-only** (tool card +
  the annotated command list); it does **not** apply canvas state. The
  initiating tab is a plain receiver that applies its own change once, from the
  broadcast.
- ACP / headless writers hit `POST /:canvasId/execute`, which calls the same
  `executeOnServer`.
- A browser page's own structure edits are a writer of the same kind: they go through `POST /:canvasId/execute` with a request id. The page is not filtered out of the broadcast; it recognises its own batch by `operationId` and applies it through the same path, see below.

## Browser structure edits

A `ui` command batch (`executeCommands` with the default source: create, delete, move, resize, reparent, reorder, style, connect, …) runs on the page first and is then sent to the server by a send queue. Code is under [canvasStore/sync/](../../apps/web/src/store/canvasStore/sync).

**Sending** ([sendQueue.ts](../../apps/web/src/store/canvasStore/sync/sendQueue.ts)). One serial lane per open Space. Each entry is one `POST /execute` with `originator: { source: 'ui', tabId }` and a fresh `operationId`; no `basis` is sent, so the server runs the batch on its latest state and edits to unrelated nodes from two pages never reject each other. A transport failure, a 5xx (including `operation-outcome-unknown`), 401, 408 or 429 repeats the same request with the same id after a backoff (500 ms doubling to 10 s); any other 4xx fails the entry. Batches made while a request is on the wire are folded into the next entry (up to 200 commands), so a slider drag is not one round trip per tick. `CREATE_NODES` and `CONNECT_NODES` are given explicit node, thread and edge ids before the local run (`withClientIds`), so the server creates the entities the page already shows.

**What is sent** ([serverCommands.ts](../../apps/web/src/store/canvasStore/sync/serverCommands.ts)). `SET_NODE_SELECTION` is not sent, and a created node is sent with `selectOnCreate: false`; selection is a page's own view state and is not in the saved record. A data key a patch clears with `undefined` — which JSON would drop — is named in the patch's `unset` list (a Question ignores `undefined`, so there the key is only left out). Content fields of existing nodes (`NODE_CONTENT_KEYS`: body, label, summary, …) are stripped from `MERGE_NODE_DATA`; they keep their own writer, the per-node content PUT, and reach other pages through it ([Node content between pages](#node-content-between-pages)). A created node is sent whole and the content queue does not write its first sidecar (`prepareServerCreatedNodes`). A batch that leaves nothing to send is not queued.

**Pointer gestures.** Live drag ticks and resize preview ticks (`executeCommands(…, { localOnly: true })`) change the store without sending. `beginGesture` records the nodes at gesture start; the batch that closes the gesture is sent with a prelude of `SET_NODE_GEOMETRY` / `MERGE_NODE_DATA` commands for what changed since then ([localDiffCommands.ts](../../apps/web/src/store/canvasStore/sync/localDiffCommands.ts)). A free drag whose resolver emits no command is sent as that prelude alone from `onNodeDragStop`. The server therefore runs the engine on a geometry command the page applied tick by tick; what the engine adds (a structured Frame named by the command is re-flowed, a hug Frame refits) reaches the page with the update. While the gesture is open, what its ticks have changed so far is held against incoming updates like a queued batch's changes, and the recorded start state is kept in step with every update, so the closing batch sends only what the gesture changed and a cancelled drag returns to where another page has put the node meanwhile. A batch sent while the pointer is still down (a modifier key interrupting a resize) restarts the recorded state from what that batch left; the resize end handlers call `closePointerGesture` so ticks after it are sent too.

**In-flight set** ([inFlight.ts](../../apps/web/src/store/canvasStore/sync/inFlight.ts)). Every queued batch holds the (entity, property unit) pairs it changed, derived from the difference between the state before the batch (before the gesture, for a closing batch) and the state after it — not from the command list, so engine consequences such as a Frame refit are held too. Property units ([propertyUnits.ts](../../apps/web/src/store/canvasStore/sync/propertyUnits.ts)): `position`; `size` (`width`, `height`, top-level `style`); `parent` (`parentId`, `extent`, `expandParent`); each `data.style` leaf; every other `data` key; every other top-level node key; node existence; each edge as a whole; and each parent's direct-child order. Content `data` keys are never held (the content queue's dirty protection covers them), and React Flow runtime fields (`selected`, `dragging`, `measured`, `resizing`) belong to no unit.

**Applying** ([fieldLevelDeltas.ts](../../apps/web/src/store/canvasStore/sync/fieldLevelDeltas.ts)). `applyDeltasFromAgent` rewrites every incoming batch — a person's or an agent's — before replaying it: a `REPLACE_NODE` becomes a replace of the live local node with only the units `prev → next` changed, minus the held ones; an `INSERT_NODE` for a node the page already has (its own optimistic creation) is merged the same way; selection is never taken from another page. So when page A has moved X and page B recolours X, A applies the colour and keeps its position, and B applies A's move when it arrives. A held unit keeps the local value and the remote value is kept back as the unit's last confirmed value.

**Own update.** The update for the page's own batch is recognised by `operationId` and applied through the same path, except that only holds of _later_ queued batches withhold a unit: two moves of one node in a row keep the second position when the first update arrives, and the version still advances. When the update is applied the batch's holds are released. A unit the update did not change is set to its last confirmed value — the remote value kept back meanwhile, or else the value before the batch — because the server did not take that part of the change. The same release happens when the response reports nothing written (`toVersion === fromVersion`). The HTTP response of the request is used as the update when it is the next contiguous version (`fromVersion === local version`); the stream copy that follows is then stale and ignored, and vice versa. Otherwise the page waits for the stream, and reloads if the update has not arrived 8 s after the response.

**Rejected commands.** A command the server reports as not applied with a reason other than `no-op`, or a request refused with a 4xx, shows one warning toast, releases the batch's holds as above and requests a reload of the Space. Other queued batches are still sent. A creation the server did not take removes its optimistic nodes before the next batch is sent.

**Reloads.** `requestCanvasResync` is the only way the sync subscriber reloads (version gap, reconnect snapshot mismatch, paint order that could not be installed, missing update, rejected command). It runs `loadCanvas(…, { resetHistory: true })` at once when the send queue is empty and otherwise as soon as it has drained; a page with unsent changes is never replaced. A paint-order divergence is ignored while the page holds an unconfirmed change to the same parent's children, since the update for that change carries the order the server ended with.

**When a request cannot be sent.** The queue's status for the open Space is mirrored in `useCanvasSyncStatusStore` ([syncStatus.ts](../../apps/web/src/store/canvasStore/sync/syncStatus.ts)) as `synced`, `syncing`, `unsynced` or `error`. After the first failed attempt the page shows a persistent warning toast (`canvasSync.unsynced`) and keeps retrying; the edits stay on screen and nothing is persisted locally, so closing the page loses them. The `online` event retries at once. After 8 consecutive failed attempts, or 60 s since the first of them, the lane stalls: nothing is sent, and a danger toast (`canvasSync.sendFailed`) offers **Keep trying** (`queue.resume`) and **Reload and discard unsent changes** (`discardUnsentCanvasEdits`: drop the lane, then reload the Space). The page never reloads over unsent changes on its own; while stalled a wanted reload stays held and `drainPendingSaves` rejects, so leaving the Space goes through the existing unsaved-changes dialog (whose discard also drops the lane). Renewing a lapsed session resumes the lane.

**Derived reports.** `APPLY_MEASURED_HEIGHT` and `APPLY_MEASURED_SIZE` batches report what the page computed, not what the user did, and are queued as `derived` entries (an entry that also folds in a user's edit is the user's). They are sent, retried and flushed like any other entry, but they are not unsent work: `syncStateOf` reports `synced` while only derived entries wait, so neither the unsynced nor the error toast is shown for them; `hasUnsavedCanvasEdits` and the page-close confirmation ignore them; and `drainPendingSaves` waits for a derived entry only while it is not failing. A lane that reaches the retry limit holding only derived entries gives them up instead of stalling (the page keeps what it measured, values withheld for them are installed, and the height or box is no longer marked as reported, so the next measurement of that content is sent). A user's edit queued behind a failing report is unsent work as usual.

**Page close.** With unanswered batches the `beforeunload` handler ([unloadFlush.ts](../../apps/web/src/store/canvasStore/save/unloadFlush.ts)) sends each of them with `keepalive` — the one on the wire with the request id it already has, so it cannot run twice — and, when at least one of them is a user's edit, asks the browser for its leave confirmation. Derived reports alone are flushed without asking. The desktop app does not ask; it closes through its own save boundary, which drains the queue via `drainPendingSaves`. A keepalive request is best effort and limited in size by the browser.

**Writers that do not start from a command.** These read their result back as commands ([localDiffCommands.ts](../../apps/web/src/store/canvasStore/sync/localDiffCommands.ts)) and send them through the same queue.

- `patchNodeSilent`: structure fields are sent as `MERGE_NODE_DATA` (the proposal is run through the engine first, `commandsReproducing`, and sent only if it reproduces the patch); during a pointer gesture the patch is left to the closing batch. A patch of content fields only is saved by the content queue. The read-model hints the server derives when it reads a node (`contentMissing`, `contentDuplicate`, `duplicateFiles`) and the stored renderer box (`measuredSize`) are shown, never sent.
- Undo and redo (`restoreFromHistory`, planned by [restorePlan.ts](../../apps/web/src/store/canvasStore/sync/restorePlan.ts)). Each undo entry records the in-flight keys its edit changed. While no other page's edit has been applied since the entry was taken, the snapshot is restored whole. Once one has (`markRemoteChange`), only the recorded keys are restored ([historyRestore.ts](../../apps/web/src/store/canvasStore/sync/historyRestore.ts)), so the other page's edit stays; a later edit by another page to the very property being undone is still overwritten. The resulting state is sent as:
  1. per-property commands where they exist: moves, resizes, data keys set or removed (`MERGE_NODE_DATA` with `unset`), reparenting, deletions, removed edges;
  2. `RESTORE_NODES` for a node that comes back — with its id, its place in the tree and its content, which the server writes to the sidecar in the same batch (`prepareServerCreatedNodes` keeps the content queue from creating it a second time) — and for an edge that comes back, handles included;
  3. after the engine has run that proposal, `RESTORE_NODES` with `replace` for a surviving node that still differs (a type change, a lock, another top-level field), keeping its content fields (`keepDataKeys`), then `REORDER_NODES` and edge repairs.

  The whole list is then run once more as the one batch the server will execute. If it reproduces the snapshot, the page shows the snapshot. If it does not — the engine fits a Frame or routes an edge its own way at the end of a batch — the page shows what the commands give instead, so page and server hold the same state; no whole-Space write is used to force the snapshot. A node's restore waits for its earlier sidecar `DELETE` (the batch is gated on it), content saves and preprocessing for the node wait until the restore is answered, and a refused restore (the id exists again, the parent is gone) is handled like any rejected command: one notice, then the server's Space.

  A returning Agent Node is not part of that batch. Its identity is re-established by the association endpoint once the batch is answered, its content is held by the content queue until the association is confirmed, and its edges and place in the sibling order follow in a second batch gated on the association.

- Measured heights (`applyMeasuredHeights`): a measurement of an auto-height note is applied on the page at once, as `system`. It is reported to the server as a `ui` `APPLY_MEASURED_HEIGHT` batch when the stored hint is current, the node's content save is not pending (the report then waits for it, because the server checks the measurement key against its own copy of the body), and no non-provisional measurement under the same key is known to be on the server — from another page's update, from this page's own confirmed report, or from the load. Two pages that render one body a pixel apart therefore do not keep rewriting each other's size; the later one shows its own measurement locally. The report's holds do not put back the previous height when the server refuses it. Load-time warm-up measurements are reported the same way.
- Renderer-measured boxes (`reportMeasuredSizes`): `text`, `question` and `spacePreview` nodes have no authored height. When React Flow reports a changed box for one, the page lays its own Frames out around it at once (`onNodesChange`, and the deferred relayout after a batch) without sending that layout, and reports the box as `APPLY_MEASURED_SIZE`. The server stores it (`data.measuredSize`, mirrored to `measured`) and lays the same Frames out with the same engine pass; the update brings the result to every page. The key (`measuredSizeKey`: content revision and authored width) lets the server ignore a box measured before the content changed, so a report waits for the node's content save. A page does not report when the server already holds the same box (within a pixel) for the key, and does not answer another page's report for the same key with its own slightly different rendering — it reports a different box under an unchanged key only when its own earlier measurement of that content changed (a font size, say). Reports are therefore triggered by local measurement changes only, never by an incoming update. A batch that changes what a box is measured against (a width resize) is followed by one check after the renderer has reflowed. Pages without write access report nothing.
- The legacy Frame-header migration on load: the coordinate change is sent as `SET_NODE_GEOMETRY` commands before the Space is shown, and the Space is then loaded again; one attempt per load, and a Space whose migration is refused (no write access, a failed request) is shown as stored.
- The Space title (`tryRename('canvas')`): sent to `PATCH /api/canvas/:id/title` with the title the page last saw. The rename publishes the `update` from the previous version to the new one with no deltas and the new `title`, so every open page — including the renaming one — advances its version and shows the title without loading the Space again.

**No whole-Space save.** The browser no longer sends `PUT /api/canvas/:id` in the editing lifecycle: there is no structure autosave, no dirty detector, no version-conflict state and no page-close PUT. A store write that is not a command batch (or one of the writers above) changes this page only. The page-close flush is the queue's keepalive flush. `drainPendingSaves` — leaving the Space, submitting a prompt, signing out — waits for the queue, then for pending Agent Node associations, then for content saves; a request that was failing is retried at once (`queue.retryNow`, which cuts the backoff short but keeps the failure count and the time of the first failure) and one more failure rejects the drain instead of sitting out the retry schedule, while a stalled queue rejects immediately. An attempt made by a drain therefore counts towards the retry limit, and repeated drains end in the stalled state. Only **Keep trying**, the `online` event and a renewed session start the count again (`queue.resume`). The action-log event buffer is flushed whenever the queue drains. The `putCanvas` API client and the server route remain for other callers; nothing in the store calls them. `apps/web/e2e/no-whole-space-save.spec.ts` exercises every former PUT path with two browser contexts and asserts the other page never loads the Space again and keeps its undo history; its second test does the same for a body and a move arriving together, and for the receiving page's undo afterwards.

### Known gaps of browser structure edits

- An undo whose snapshot the engine would not reproduce exactly is shown as the commands leave it, not as the snapshot (see above). The cases are Frame fits and edge routes that differ from what the snapshot recorded, typically around children whose rendered box changed since.
- The sibling order of a returning Agent Node and its edges are sent in a follow-up batch; until it is answered other pages show the node without them.
- A preview tick committed outside a pointer gesture (`localOnly` with no gesture baseline) is not sent by anything; no caller does this today.
- A renderer box is reported for the content the server holds. While a body edit is unsaved the page lays out around its own measurement and the stored box lags; with two pages that render one body differently by more than a pixel, the stored box is the first page's and each page keeps its own local Frame layout until its next measurement change.
- Body, label and other content fields are not sent through the queue; they reach other pages by a fetch after the save ([Node content between pages](#node-content-between-pages)), so for a moment a page measures and lays out against the body it had.
- The unsynced and error states are toasts; there is no separate indicator, and unsent edits are held in memory only.
- Restricted undo relies on the keys recorded for the entry; changes that reached the store without a command batch between two snapshots (a deferred relayout, a locally shown measurement) are not in them and are not undone once another page's edit has been applied.
- Covered by unit tests with a simulated second page and by `apps/web/e2e/multi-page-sync-baseline.spec.ts` with two real browser contexts (moves, create, delete, style, layer order, two writers, one page offline, undo after the other page's edit, a height measured on load); the error state, its two choices and the page-close flush are covered by unit tests only, except the page-close confirmation for a derived report versus a user's edit, which `apps/web/e2e/sync-convergence.spec.ts` checks in a real browser. Not covered: edges and Frames in a two-browser run, two pages saving at the same instant, the SQLite backend, and a run across two devices.

## Node content between pages

A node's sidecar fields (`NODE_CONTENT_KEYS`: `content`, `label`, `labelSource`, `src`, `summary`, `keywords`, `provenance`) are saved by `PUT /api/canvas/:id/nodes/:nodeId/content` from the per-node content queue ([nodeContentQueue.ts](../../apps/web/src/store/canvasStore/save/nodeContentQueue.ts)). That request does not change the Space `version` and produces no `update`. This covers note and text bodies, the Question prompt, and the label of every node type that has a sidecar, including labels and summaries that preprocessing derived on the saving page.

```
page A edits a body / title           page B (not editing that node)
   │ content queue (debounced)
   ▼
PUT …/nodes/:id/content { …, expectRev, pageId: A }
   │ server: rev check, write sidecar
   ▼
invalidate { nodeIds: [id], originPageId: A } ──► canvasSyncStore
                                                    │ originPageId ≠ B
                                                    ▼
                                    GET …/nodes/:id/content → { content, label, …, rev }
                                                    ▼
                                    adoptRemoteContent: store + baseline rev
```

**Sending.** The queue adds this page's id (`CANVAS_PAGE_ID`) to the request as `pageId`. The server copies it to the event as `originPageId` and does not store it. It is routing information, not a credential.

**Receiving** (`canvasSyncStore` → `adoptRemoteNodeContent` → `NodeContentQueue.adoptRemoteContent`). A page ignores an event whose `originPageId` is its own, so it does not fetch what it just wrote; an event without `originPageId` (another client) is fetched. For each named node that the page has and that has a sidecar, the page fetches `GET …/nodes/:nodeId/content` and:

- writes the fields that differ into the node through `_setStateNoAutosave`, replacing only that node's object. A field the response does not carry is left alone, a body is given only to a node type that has one, and a response reporting a missing sidecar is not adopted (the deletion arrives as a structure update);
- sets the node's baseline revision to the returned `rev` in the same step, so the page's next save of that node sends the fetched revision as `expectRev` and is not refused;
- puts the same fields into every undo and redo entry of the Space (`rebaseRemoteContent`), so undoing an earlier local edit cannot restore the previous body and save it over the other page's.

One fetch runs per node at a time; saves that arrive during it are read by one further fetch. An event that arrives while the Space is loading is fetched when the load ends. The response carries `provenance` for this purpose.

**What it does not do on the receiving page.** No content save, structure save or preprocessing request is sent, the Space is not marked as having unsaved changes, no undo entry is added, and selection, viewport and focus are not touched. An open preview of that node shows the new body and title through the editor's existing external-content path; a text node that is not being edited re-syncs its draft.

**A node with unsaved content on this page** — a queued or in-flight save, a failed save, a node frozen by a content conflict, or a body held for an undo restore — is not fetched and not changed. If the other page's save changed the body, this page's save is refused with `NODE_CONTENT_CONFLICT` and the existing **Keep mine / Load latest** toast decides, exactly as before. Once this page's save has been acknowledged the node is fetched, which picks up fields the other save changed besides it. Text typed while a fetch is under way is kept the same way.

**A conflict stays the user's to answer.** A node frozen by `NODE_CONTENT_CONFLICT` counts as having unsaved content for as long as the choice is open (`pendingNodeIds` includes it), so no `update` replaces its text, re-seeds its baseline or reloads the Space under it: an update to another node, a move of the node itself and a wanted reload all leave it frozen with its toast. An `update` that carries new server content for the frozen node (an agent's write, say) is skipped like any write to a node being edited, and the user is told their version was kept, but it does not resolve the conflict: `rebaseConflict` only moves the revision **Keep mine** will overwrite on to the one the update brought. Only **Keep mine**, **Load latest**, deleting the node or a confirmed discard ends the freeze. (An update that happens to bring exactly the text the page shows also leaves it frozen; the first **Keep mine** may then be refused once more and asked again.)

**Measured height and box.** The receiving page re-measures the node against the new body and shows the result at once: the height of an auto-height note, the rendered box of a `text` or `question` node (and its own Frames around it). Whether it reports the measurement is decided by the existing rules for `APPLY_MEASURED_HEIGHT` and `APPLY_MEASURED_SIZE` ([Browser structure edits](#browser-structure-edits)): at most once per page and measurement key, and not at all when another page's report under the same key has already arrived. The receiving page has no content save pending for the node, so its report does not wait; when it and the saving page both report before either has seen the other's update, the server receives two reports under one key and neither page answers the other's. A report changes the Space through `execute`, never through a content save, so it cannot cause another content event.

### Known gaps of node content between pages

- Only `content` and `src` are covered by `expectRev`. When two pages have unsaved changes to the same node and one of them changed only the label, summary or keywords, the later save replaces those fields without a conflict (a Question saves only the fields it changed and is not affected).
- A content event missed while the stream was down is not replayed: reconnecting compares the Space version, which a content save does not change. The page keeps the body it had until it reloads, and a save from it is refused with `NODE_CONTENT_CONFLICT`.
- A failed fetch is not retried; the next save of that node by another page fetches again.
- Each save costs one extra request per other open page. Bodies are not sent in the event.
- Covered by unit tests and by two real browser contexts in `apps/web/e2e/multi-page-sync-baseline.spec.ts` (case f) and `apps/web/e2e/content-sync.spec.ts` (title, open preview, measured height). Text nodes and Question prompts use the same path and are covered by the queue's unit tests only.

## Conflict model — version + dirty-node protection

Loading a Space may attempt to persist a legacy Hug Frame header adjustment before displaying the adjusted geometry. This optional layout write is not a prerequisite for reading the Space: if it fails (including version conflicts or Agent execution-record validation), loading completes with the original loaded geometry, content, edges, and snapshot version. The failure is logged without a blocking or persistent toast, and neither the rejected geometry nor its warmup hints are automatically resubmitted by the load path. Normal save validation and SSE reconciliation remain in force; this fallback does not repair missing execution records or force an overwrite.

`applyDeltasFromAgent` filters incoming deltas against nodes with un-persisted local content edits (`nodeContentQueue.pendingNodeIds()` — debounced-but-unsaved plus in-flight PUTs). The queue also exposes the exact pending sidecar fields for Question reconciliation:

```
INSERT_NODE (new id)     → apply unless a local pending Question creation was undone/deleted
REPLACE_NODE changing a pending Question field → keep that local field, apply independent remote fields, report the overlap
REPLACE_NODE changing content on another dirty node / DELETE_NODE on a dirty id → SKIP (keep the human's unsaved edit)
REPLACE_NODE changing only non-content fields on a dirty id → apply while preserving local content fields
otherwise                → apply
```

- Resolution is deterministic **local-first**: a skipped field or node keeps the human's value, and skipped node post-effects (preprocessing / fit) are skipped too. `version` still advances to `toVersion`, so the next update is contiguous.
- Question sidecar reconciliation is field-aware. A pending body edit no longer blocks an independent generated label, and a pending manual label no longer blocks the server-seeded first prompt or lifecycle metadata. The eventual Question PUT contains only locally pending fields, so it cannot write an old label back while saving a body edit. Same-field overlap remains local-first, is reported through the existing amber skipped-write surface, and adopts the remote authored-content revision before retrying the local value.
- Coarse `REPLACE_NODE` deltas include the server's full node even when only a lifecycle field such as Question `status` or `viewed` changed. Markdown-sidecar fields are compared by value, including nested `keywords` and `provenance` metadata, rather than object identity or object property order after JSON transport. When the remote delta leaves every markdown-sidecar field unchanged, the applier overlays the locally pending content fields onto the incoming node and applies the remaining update. This avoids treating the initiating tab's own lifecycle broadcast as an edit conflict without allowing stale server content to overwrite the local edit.
- **Baseline rebase (no false conflict):** for a skipped `REPLACE_NODE`, the
  applier adopts the agent's just-written revision as that node's content-CAS
  baseline (`nodeContentQueue.seedBaselines` on the delta's `next`) **without**
  touching the human's in-memory content. The human's next autosave then carries
  `expectRev = agent's rev`, matches the agent's on-disk write, and cleanly
  overwrites it — so local-first "the human wins" is delivered as a silent rebase
  instead of a `NODE_CONTENT_CONFLICT` red toast. The amber "your version was
  kept" notice + change-review card remain the record of the agent's dropped edit.
- **Untouched dirty nodes keep their baseline.** After a batch is applied the content-CAS baselines of the Space's nodes are re-seeded from what the page now shows. A node with unsaved content that the batch did not touch is left out: its baseline stays the revision the server holds, so a body being typed while another page's (or this page's own) structure update arrives is saved normally instead of being refused with `NODE_CONTENT_CONFLICT`.
- On a **version gap** (`toVersion > local`), the tab catches up with
  `loadCanvas` — but **only when there are no dirty nodes**. With local dirty
  state a blind `loadCanvas` would lose the edit, so the gap is left alone; the
  body is saved by its own request, and a later gap or reconnect snapshot reloads
  once nothing is dirty. The reload is also held until the send queue is empty,
  see [Browser structure edits](#browser-structure-edits).
- **Scope:** this dirty-node filter covers content only. Structure is protected per property unit by the in-flight set described under [Browser structure edits](#browser-structure-edits).
- **Mixed Question content/FSM deltas:** when a pending field rejects an overlapping remote authored value, authoritative binding, invocation, attention, association metadata, and independent sidecar fields still apply. The local overlapping value, existing amber conflict notice, skipped change-card state, and content-CAS baseline rebase remain intact. Geometry and deletion conflict policy is unchanged; this field-level exception is specific to Question sidecar reconciliation, not general structure merging.

Skipped ids flow back through `canvasSyncStore` into `acpThreadChangesStore`
(`conflictedByThread`) and surface as:

- a persistent, dismissible **warning toast** at the moment of the skip;
- the review row rendered as a **conflict** (`· skipped`, warning icon, revert
  disabled);
- a **`ConflictBadge`** count on the question node's "done" badge, so a
  partially-applied run is never silently reported as fully done.

## Change records & the review card

The Review records of an agent batch are saved in the same write as the batch (see [reliable save](./canvas-storage.md#42-reliable-save-in-the-write)); a request answered from a stored result appends none. The card, the accept/revert routes and the broadcast shape below are unchanged, and this does not make inverses safe for concurrent Revert.

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

Records are persisted per thread in a mutable sidecar (`<threadId>.changes.json`, coalesced on read) and reach the frontend two ways: `load()` on thread open, and `replaceFromBroadcast()` (the broadcast carries the thread's full coalesced list, so the client replaces rather than appends). The global Settings → General preference **Automatically accept Agent Space changes** suppresses computation and persistence of new records for successful Agent batches when enabled; existing records remain available, and Canvas delta broadcast and current-session undo snapshots are unchanged.

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
- **ACP agent:** the daemon injects `HUABU_THREAD_ID` into the external agent's
  env ([`reachback-env.ts`](../../apps/server/src/modules/agent/acp/reachback-env.ts)).
  The agent forwards it on the reachback `POST /api/rfs/:canvasId/execute` call
  via the `X-Huabu-Host-Thread-Id` header; the route
  ([`rfs.route.ts`](../../apps/server/src/modules/remote_fs/rfs.route.ts) →
  [`space-execute.ts`](../../apps/server/src/modules/remote_fs/space-execute.ts))
  reads it and sets `originator.threadId` + `computeChanges`. This is
  **best-effort**: a missing/malformed header applies the write unattributed. The
  header is distinct from the thread ID in `/agent/:threadId/prompt` (which continues an
  internal built-in-agent turn — a different thread space).

`executeOnServer` computes review records only when `computeChanges` is set (i.e. thread-attributed batches) and the global Agent Change Review configuration does not auto-accept Agent writes, so untagged and auto-accepted writers pay no extraction cost. When a `threadId` is present and explicit review is enabled, the batch's records are folded into the thread's coalesced sidecar and that full list is broadcast as `changes`.

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

## Navigation save boundary

Each new drain retries retained non-conflict content failures once through the serialized content queue, only while the requested Space's nodes are fully loaded, and retries a failing send-queue request at once. Label-collision failures also retry the current node state: `tryRename` restores the previous label after a server rejection, and the retry saves that reverted label together with any pending body edits before navigation. Writes already scheduled or in flight are reused; failures created by that drain are reported rather than retried in a loop. Version/content conflicts and duplicate-sidecar failures still require explicit resolution. Direct `switchCanvas` keeps the outgoing Space loaded until the drain succeeds, so staying and switching again can recover without requiring another edit. Authoritative baseline updates retire both failure toasts and their notification guards, allowing a later failed save to surface its own error and Retry action.

`drainPendingSaves(canvasId)` is the shared save boundary for route navigation, `switchCanvas`, Space operations, and Agent submission. It waits for the send queue, content, and deletion work and rejects unresolved ordinary content failures, a send queue that cannot send, content conflicts, and held restored bodies. Submission wraps these failures as `CanvasSubmissionSaveError`. Offscreen submissions remain scoped to their captured Space; content-failure filtering uses live node membership only when that Space is not loading, so a returning Space cannot accidentally use the previous Space's nodes as evidence that failed edits were deleted.

The always-mounted `SpaceNavigationGuard` in the router root blocks pathname changes out of a Canvas route. Saving failure retains the current route and presents Common `Modal` with **Stay in this Space** (initial focus, also Escape/backdrop dismissal) and **Discard and leave**. Staying preserves the in-memory edits and failure records for retry. Explicit discard cancels unsent save/preprocess timers and suspends the Space's content-write admission before waiting for admitted writes/deletions to settle. Structure acknowledgements cannot release held restored bodies during this interval; queued content writes and rebase retries cannot issue a new PUT. Failure records and held bodies remain until settlement, then discard forgets that Space's content queue and save failures, clears its undo history, and releases its in-memory Canvas before allowing navigation. Returning therefore reloads server state rather than recovering discarded bodies. Discard never issues compensating deletes or reverses writes already accepted by the server, and it needs no successful reload/network request. A discard failure restores content-write admission and leaves navigation blocked with visible feedback.

On desktop, the same guard first diverts cross-Space/Home navigation through `DesktopTabs.open`, preserving the existing renderer and its edits without draining or discarding. Desktop close/reload/quit use the acknowledged [desktop lifecycle boundary](./desktop-tabs.md#3-saving-and-lifetime); browser reload/window close remain best-effort unload paths rather than this in-app confirmation flow.

An in-app navigation drain lasting over 150ms displays Common `Loading` with the brand animation and “Saving…” inside a full-viewport native modal dialog, outside the page's flex layout. It uses the same `md` indicator and centered text row as Space loading. The underlying Canvas and chat geometry stay unchanged; native modal inertness blocks pointer and keyboard interaction with the editor and its portals while saving. There is no cancel button, and Escape does not dismiss the saving state. Settlement closes the dialog before proceeding or showing the existing unsaved-changes decision.

The saving dialog explicitly carries `role="dialog"` for the shared Canvas interaction guard. This excludes its keyboard events from window-capture shortcuts such as Delete and Undo, which run before the dialog's bubbling handler.

## Undo interaction

Editable broadcast batches from an agent take **one** undo snapshot (via `applyDeltasFromAgent`), including a batch that only changes sibling paint order. A batch written by a person (`source: 'ui'`) — the page's own or another page's — takes none: the page's own edit already has its entry, and another person's edit is not this page's to undo. Undo and redo themselves are described under [Browser structure edits](#browser-structure-edits). Trusted Agent Node projection batches and FSM-only replacements do not create ordinary undo entries. The server's first-submitted-content effect rebases matching empty Question content in existing snapshots, so undoing an earlier drag cannot erase that submitted intent.

**Restore persistence is ordered, not delay-dependent.** A node that an undo or redo brings back is restored by one `RESTORE_NODES` batch that carries its content, so its sidecar is written by the server with the topology rather than by a later content PUT. Deleted-node content bookkeeping is forgotten immediately, while the preprocessing queue remembers interrupted work for history resurrection. Already-issued content and preprocessing requests settle before the history manager sends DELETE; DELETE promises are tracked to completion rather than aborted, because aborting fetch does not cancel an admitted server mutation, and the restoring batch is gated on the node's tracked DELETE. Until that batch is answered, content saves for the node wait (as they do for a creation) and preprocessing for it is blocked; both resume when it is. A later redo that removes the node again is the next batch in the queue, so the two are executed in order. Ordinary content edits retain their independent debounce and revision baseline.

A returning Agent Node keeps the earlier barrier: the content queue holds its sidecar behind a generation token, and releases it only when the association endpoint has confirmed the node; a later undo/redo invalidates the token.

History reports node changes to the existing preprocessing queue rather than independently cancelling or resuming tasks. The queue owns selective input reconciliation, waiting demand, and client callback validity under the authoritative [client responsibility boundary](./node-preprocessing.md#client-responsibility-boundary). These client guarantees do not establish server-side freshness of derived-content writes.

A restore that cannot be sent keeps the page's edits and follows the send queue's unsynced and error states; a refused one converges the page to the server's Space. The exception is a returning node the user edited before the refusal: its unsaved content holds the reload back, its content save fails (it waits for the restore) and shows the failed-save toast. **Retry** on that toast, and the next `drainPendingSaves`, send the restore again (`retryFailedRestores`: a `RESTORE_NODES` batch for every node of the Space whose restoring batch failed, as the page shows them now, content included) and then the content save, which waits for it. A restore that is refused again shows the toast again. A content failure or content conflict stays dirty until saved or explicitly resolved. Route navigation, `switchCanvas`, and explicit Canvas loads drain the same queues and refuse to silently discard an unresolved body; Retry, explicitly removing the node, or the navigation boundary's confirmed discard lets the user continue. A snapshot with `contentMissing` or without a text-bearing node's string body never invents a body. Unload remains best-effort: the restoring batch is flushed with keepalive like any other.

Host-side refinements keep undo coherent with sync:

- **Transient-field parity.** `diff.ts` and the web snapshotter share one
  canonical `TRANSIENT_NODE_FIELDS` / `TRANSIENT_EDGE_FIELDS` list
  (`selected` / `dragging` / `measured` / `resizing`) so a pure selection flip
  never diffs into a phantom REPLACE, and undo/redo re-applies the live
  transient fields instead of clearing selection.
- **Question-node ownership preservation.** Undo/redo restores editable geometry/content/presentation while preserving live FSM fields and Bound preparation. Server change-card inverse replay applies only the editable data fields changed by that recorded effect, not an old complete Node. Undo reinsertion awaits deletion, and the batch that restores the rest of the same undo, then confirms the restored thread through the association endpoint; a failed confirmation removes the optimistic node and does not silently create a fresh binding.
- **Pending Question removal.** Undo/deletion removes optimistic Questions immediately, filters their late creation inserts (and incident inserted edges) from both HTTP and SSE reconciliation, and delays the tracked server DELETE until creation settles. Failed creation/fork/restore rolls back its optimistic Question and history references on this page only; the server never took the node, so nothing is sent for the rollback.

Question restoration preserves main's immediate local undo/redo behavior and content-queue restore barriers. The server association waits for the batch that restores the rest of the same undo and for the node's tracked DELETE; `drainPendingSaves` waits for pending associations before it flushes content.

- **Retired topology filtering.** Undo/redo applies the shared `stripLegacyPortalTopology()` helper before restoring a snapshot, so old Portal/Pin nodes and their incident edges cannot reappear and ordinary children retain rebased positions. The former Portal-specific history invalidation path is removed; this filtering does not migrate or clean up stored files.

The auto-accept preference still suppresses new Agent review records only. It does not suppress broadcasts or editable undo snapshots, and it does not weaken FSM ownership during manual revert or undo.

## Space presence

When a Space is open on several pages (tabs or devices), each page shows the others: a coloured cursor where the other page's mouse, pen or finger is, and an outline in the same colour around the nodes that page has selected, is dragging or is editing. There is one account, so a marker stands for a page, not a person: the server gives each page a colour and the page supplies a short device label such as `Chrome · Mac`.

Presence is ephemeral. It is held in server memory and in a browser store of its own; it is not part of the Space record, its `version`, the delta log, change records, undo/redo or anything an Agent reads, and reporting it neither marks the Space dirty nor schedules a save. A drag is reported only as "these nodes are being dragged": positions are not streamed, and the moved node arrives on drop through [browser structure edits](#browser-structure-edits).

```
page A pointer / selection / drag / focus
   │  useReportCanvasPresence → presenceReporter (≤1 request / 80 ms)
   ▼
POST /api/canvas/:id/presence ──► canvas-presence hub (memory, per Space, by page id)
                                        │  relay to every other subscriber
                                        ▼
GET /api/canvas/:id/sync/stream?pageId=B ──► event: presence
   ▼
canvasSyncSubscription → canvasPresenceStore → RemoteCursors / RemoteNodeOutlines
```

### Wire contract

Schemas and limits live in [canvas-presence.ts](../../packages/shared/src/types/api/canvas-presence.ts) and [canvas-presence-limits.ts](../../packages/shared/src/types/api/canvas-presence-limits.ts).

| Endpoint                                    | Body                                                                                                                | Result                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /api/canvas/:canvasId/presence`       | `{ pageId, label?, displayName?, pointer?: { x, y } \| null, selectedNodeIds?, draggingNodeIds?, editingNodeIds? }` | 204; 400 invalid; 413 over 128 KiB; 429 `PRESENCE_RATE_LIMITED` / `PRESENCE_SPACE_FULL` with `Retry-After` |
| `POST /api/canvas/:canvasId/presence/leave` | `{ pageId }`                                                                                                        | 204; 400 invalid                                                                                           |
| `GET /api/canvas/:canvasId/sync/stream`     | query `pageId?`                                                                                                     | adds `presence` events to the stream; 400 for a malformed `pageId`                                         |

The report body is strict (unknown fields are rejected). An absent field leaves that part of the page's presence unchanged, so a pointer tick does not resend the selection. `pageId` is the page's `originator.tabId` (`CANVAS_PAGE_ID`); `pointer` is in canvas (flow) coordinates so it lands on the same canvas point under any pan and zoom, and is `null` when the pointer is not over the canvas. `displayName` is reserved for a person's name and is preferred over `label` when present.

A `presence` event's data is one of `{ op: 'snapshot', pages }` (sent once on connect: every other page present), `{ op: 'update', page }` (a page appeared or changed anything besides its pointer), `{ op: 'pointer', pageId, pointer }` and `{ op: 'leave', pageId }`. A page is `{ pageId, colorIndex, label, displayName?, pointer, selectedNodeIds, draggingNodeIds, editingNodeIds }`. A stream opened with `pageId` is never sent that page's own presence.

Both POST routes need only read access to the Space (`spaceAccess: 'read'`), the same as the stream, and go through the same host, origin, identity and Space-access guards as every Canvas route. The page id is chosen by the page and is not a credential: any caller that may read the Space may report or withdraw presence under any page id in it.

| Limit                    | Value                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Node ids per list        | 200, each at most 128 characters                                                       |
| `label` / `displayName`  | 40 / 80 characters                                                                     |
| Coordinates              | finite, magnitude at most 10,000,000                                                   |
| Pages per Space          | 32; a further page is refused with 429 `PRESENCE_SPACE_FULL`                           |
| Reports per page         | 30 per second on the server; the browser sends at most one per 80 ms and one at a time |
| Reports per network peer | 3,000 per minute, counted apart from the application-wide request budget               |
| Colours                  | 6 colour indices; the lowest unused one, kept while the page stays present             |
| Heartbeat / expiry       | the page repeats its whole state every 20 s; a page silent for 75 s is dropped         |

### Server

[canvas-presence.ts](../../apps/server/src/modules/canvas/canvas-presence.ts) keeps a map of pages per Space, keyed by Workspace id and Space id, and its own subscriber list; it does not use `publishCanvasUpdate`, so conversation observers and other server-side listeners of Canvas Sync never see presence. A page is removed, and the others are sent `leave`, when it posts `leave`, when the last stream opened with its `pageId` closes, or when it has not reported for the expiry time (a sweep runs while any page is present), so a crashed page or a dropped connection leaves no marker behind. The expiry is longer than a minute because a background tab's heartbeat timer may fire only once a minute. Pointer events are skipped for a stream whose unsent backlog exceeds 256 KiB.

### Browser

[canvasSyncSubscription.ts](../../apps/web/src/store/canvasSyncSubscription.ts) opens the Space's one stream with this page's id and hands `presence` events to presence listeners only; a listener that subscribes late is given the current set as a snapshot, and every listener is told when the stream drops. [canvasPresenceStore.ts](../../apps/web/src/store/canvasPresence/canvasPresenceStore.ts) holds the other pages in two maps, `pages` and `pointers`, and clears them when the stream drops. `pages` keeps its identity across pointer events, so only the cursor layer re-renders for a pointer tick; neither map is in `canvasStore`, and the React Flow node list is not touched.

[useReportCanvasPresence.ts](../../apps/web/src/components/Panels/Canvas/presence/useReportCanvasPresence.ts) reads this page's state without writing any: the pointer over the canvas (mouse, pen or finger as described under [Pointer](#pointer), converted to flow coordinates once per frame; `null` when it leaves, the window loses focus or the tab is hidden), `selected` / `dragging` flags of `canvasStore.nodes`, and the node being edited, which [editingTracker.ts](../../apps/web/src/store/canvasPresence/editingTracker.ts) derives from the focused text control, on the canvas or in the preview panel (see [One editor at a time](#one-editor-at-a-time)). [presenceReporter.ts](../../apps/web/src/store/canvasPresence/presenceReporter.ts) sends at most one request at a time and one per 80 ms, each carrying only the latest values of what changed; it sends the whole state on every stream (re)connect and as the heartbeat, waits out a 429, and posts `leave` (`keepalive`) when the canvas unmounts or the page is hidden for unload. Report failures are silent.

[CanvasPresenceLayer.tsx](../../apps/web/src/components/Panels/Canvas/presence/CanvasPresenceLayer.tsx), mounted inside `<ReactFlow>`, draws the cursors and outlines as a screen-space layer in the `.react-flow` container, like `SelectionOutlines`. A remote outline reuses `SelectionOutline` and the measured node geometry, drawn 3 px outside the node (a further 3 px per additional page) so it stays visible beside this page's own selection outline. Every node being edited or dragged carries the page's label with `· editing` / `· moving`; of a plain selection only the first node is labelled. A node this page does not have is not outlined.

### Colours

The server hands out a colour index; the browser maps it to the node accent palette in [presencePaint.ts](../../apps/web/src/components/Panels/Canvas/presence/presencePaint.ts) (`PRESENCE_COLOR_TOKENS`), so there are no presence-specific colour tokens. The six are teal, orange, purple, green, red and amber, in that order of index so that the first pages to arrive get unlike hues. White and grey are left out because they do not read as a colour, and blue because it is this page's own selection colour.

A marker is a thin outline, a 16 px arrow and a 10 px label whose text is `--fg-inverse` on the marker colour, so each entry uses the accent's existing foreground token rather than a tint: `--accent-<name>-text-fg`, except amber, which uses the darker `--accent-amber-fg` because `--accent-amber-text-fg` is too light under white label text in the light theme (3.6:1). In the dark theme the two tokens have the same value.

| Token                     | Light: label text / on canvas | Dark: label text / on canvas |
| ------------------------- | ----------------------------- | ---------------------------- |
| `--accent-teal-text-fg`   | 5.0 / 4.6                     | 11.0 / 12.4                  |
| `--accent-orange-text-fg` | 4.8 / 4.4                     | 12.4 / 14.0                  |
| `--accent-purple-text-fg` | 5.1 / 4.6                     | 10.2 / 11.5                  |
| `--accent-green-text-fg`  | 4.9 / 4.5                     | 11.2 / 12.6                  |
| `--accent-red-text-fg`    | 4.9 / 4.5                     | 11.4 / 12.8                  |
| `--accent-amber-fg`       | 7.1 / 6.5                     | 14.1 / 15.9                  |

The figures are WCAG contrast ratios computed from the token values: label text (`--fg-inverse`) against the marker colour, and the marker colour against the canvas background (`--bg-default`, `#f5f5f5` light and about `#0a0a0a` dark). A unit test recomputes them from `index.css` and requires more than 4.5 for the label and more than 4.3 for the outline. They are computed, not measured on a display.

### Pointer

[pointerTracker.ts](../../apps/web/src/store/canvasPresence/pointerTracker.ts) decides which position is shown as this page's cursor. The events are heard on the window, because the canvas pointer router stops touch and pen events before they reach the canvas element.

| Input  | Reported                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mouse  | Wherever it moves over the canvas, until it leaves the canvas.                                                                                                                                                                                                           |
| Pen    | Wherever it is over the canvas, hovering (where the device reports hover) or in contact; after lifting it stays while the pen remains in range, and clears on `pointerleave` (out of range or off the canvas).                                                           |
| Finger | The contact point of a single touch that began on the canvas, from 80 ms after it lands (`TOUCH_REPORT_DELAY_MS`) and wherever it moves; it stays for 1.5 s after the finger lifts (`TOUCH_LINGER_MS`), then clears. A tap shorter than the delay shows where it landed. |

Two or more fingers are this page's own pan or pinch and are not reported: the delay keeps the first finger of a pinch from flashing, a point already shown is withdrawn when a second finger lands, and nothing is reported until every finger of that gesture has lifted. Touches made while a pen is in range are treated as the resting hand and ignored. The position is reported whatever the input mode, including a mode in which the canvas itself ignores that pointer.

### One editor at a time

Two pages do not edit the same node's body or title at once. `editingNodeIds` is used as an advisory lock ([editLock.ts](../../apps/web/src/store/canvasPresence/editLock.ts)): while another page reports node N as being edited, this page cannot start editing N. Nothing is stored and the server enforces nothing; a page that edits anyway is still checked by the content revision, so the worst case is the existing `NODE_CONTENT_CONFLICT` choice.

| Surface on the locked-out page                                              | Behaviour while another page edits N                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preview of N (Note editor, raw Markdown, every other preview type)          | Read-only; a notice under the header names the other page (`canvasPresence.editLocked`), and a mouse press in the body shows the same text as a toast. |
| Title in the preview header, and the rename request from the tab (F2, menu) | Does not enter editing; toast.                                                                                                                         |
| Text node edited in place (double-click)                                    | Does not enter editing; toast.                                                                                                                         |
| Frame title, Question title on the card                                     | Does not enter editing; toast.                                                                                                                         |
| Any other rename (layer panel, chat header)                                 | `tryRename('node', …)` refuses when the name is committed and shows the toast; this is the check every rename surface passes through.                  |
| Dropping a block or card onto Note N to append it                           | Not accepted by the Note; the drop falls through to the canvas and creates a node.                                                                     |
| Move, resize, colour, layer order, connect, delete                          | Unchanged. They are structure edits and are not locked.                                                                                                |

The toast is shown at most once per 1.5 s. The outline with `· editing` is drawn as before.

**What holds the lock** ([editingTracker.ts](../../apps/web/src/store/canvasPresence/editingTracker.ts)). A page reports N while a text control of N has focus — on the canvas, or in the preview of N — and the page itself has focus and is visible. A read-only field does not count. Opening a Note's preview focuses its editor, so the lock starts there, before the first key press.

**What releases it.**

- The control loses focus or the editor closes. The page first saves N's queued content and reports the release after the server has answered, at most 5 s later (`EDIT_RELEASE_CAP_MS`), so the page that edits next has already been sent that text ([Node content between pages](#node-content-between-pages)).
- The window loses focus or the tab is hidden, even with the caret still in the editor.
- No key press, pointer press or input on the page for 2 minutes (`EDIT_IDLE_RELEASE_MS`). The next input takes the lock again.
- The page closes or navigates away (`leave`), its stream closes, or it stops reporting for 75 s (presence expiry).
- The locked-out page's own stream drops: presence is cleared there, so it is not locked while it cannot know. Its saves are then checked by revision only.

When a page returns (window focus, tab shown, input after the idle release) to a control of a node another page has started editing meanwhile, the control is blurred and the toast is shown instead of the lock being taken back.

**A page that is itself editing N is never locked out of N.** If two pages start in the same instant, both keep their editor and the revision check decides between their saves. This also means a notice cannot remove a caret from under someone who is typing.

Limits: the lock is per node, not per field. Typing in a Question's chat composer and renaming from the layer panel or the chat header do not report editing, so they hold no lock (they are refused by one). The release can reach another page slightly before the saved content does; a person who starts typing in that gap gets the content-conflict choice.

### Not covered

- Text carets and selections inside a note body, live drag positions and viewport following.
- More than one server process: presence is in the memory of the process that received the report.
- Pen and finger reporting is exercised with synthesized pointer events (unit tests, and Chromium touch and pen events in `apps/web/e2e/space-presence.spec.ts`), not with pen hardware or on a touch device; whether a given pen reports hover, and when it reports leaving range, is the device's and browser's behaviour.
- Two pages in the same browser on the same system have the same label and differ only by colour; with more than six pages colours repeat.
- A sketch stroke selection, an edge selection and a marquee in progress are not presence.

## Stream reliability

The sync route subscribes before reading the initial Canvas version, buffers updates committed during that read, sends the snapshot first, and then flushes the buffered updates. This closes the snapshot/subscribe loss window while preserving snapshot-before-update ordering.

The server emits a heartbeat comment every 15 seconds. Canvas Sync applies a 45-second byte-activity watchdog to the shared SSE reader; every received chunk, including a heartbeat comment that does not produce an application event, resets the timeout. Three missed heartbeat windows terminate a silently stalled or half-open stream so the existing retry loop can recover without a manual page refresh. The timeout is opt-in and does not affect other SSE consumers.

`canvasSyncSubscription` treats inactivity timeouts, non-OK responses, stream read errors and unexpected EOF as failures and reconnects with exponential backoff capped at 10 seconds. Unknown event kinds are ignored. An intentional Canvas switch releases the renderer's subscription; the current request and pending delay are aborted only when no subscribers remain. Successful recognized events reset the backoff. The reconnect snapshot/version handshake remains the convergence mechanism. The server installs disconnect cleanup before reading the baseline, so a view closed during that read cannot leak a subscription or heartbeat; baseline failures are logged and close the transport for retry.

## Known reliability gap

- **Revert-route TOCTOU.** The revert handler reads the record and removes it outside the per-canvas mutex (only `applyDeltasOnServer` is inside), so two concurrent reverts of the same change could double-apply. Negligible on single-user desktop; folded away by P3's unified write path.

## Code entry points

| File / dir                                                                                                                                                                                                                                                       | Responsibility                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [types/api/canvas-sync.ts](../../packages/shared/src/types/api/canvas-sync.ts)                                                                                                                                                                                   | Wire schema for `snapshot` / `update` / `invalidate` events + thread-changes responses.           |
| [canvas-engine/change.ts](../../packages/shared/src/canvas-engine/change.ts)                                                                                                                                                                                     | `extractCanvasChanges`, `coalesceChanges`, inverse deltas, staleness fingerprint.                 |
| [canvas-engine/diff.ts](../../packages/shared/src/canvas-engine/diff.ts)                                                                                                                                                                                         | `diffCanvasState` + shared transient-field stripping.                                             |
| [canvas/canvas-sync.ts](../../apps/server/src/modules/canvas/canvas-sync.ts)                                                                                                                                                                                     | In-memory pub/sub (`publishCanvasUpdate` / `subscribeCanvasUpdates`).                             |
| [canvas/sync.route.ts](../../apps/server/src/modules/canvas/sync.route.ts)                                                                                                                                                                                       | `GET /:canvasId/sync/stream` SSE (snapshot handshake + forward updates and presence).             |
| [canvas/canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)                                                                                                                                                                             | `executeOnServer` (always broadcasts, optional `computeChanges`); `applyDeltasOnServer` (revert). |
| [canvas/canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts)                                                                                                                                                                                   | `/execute`; `GET`/`DELETE` `…/threads/:threadId/changes[/:changeId]`; `…/:changeId/revert`.       |
| [storage/canvas-store.ts](../../apps/server/src/modules/storage/canvas-store.ts)                                                                                                                                                                                 | Change-record sidecar (`readChanges` / `writeChanges` / `appendChanges` / `removeChange`).        |
| [storage/paths.ts](../../apps/server/src/modules/storage/paths.ts)                                                                                                                                                                                               | `changesPath` (`<threadId>.changes.json`).                                                        |
| [preprocessing/coalesce.ts](../../apps/server/src/modules/preprocessing/coalesce.ts) · [dispatcher.ts](../../apps/server/src/modules/preprocessing/dispatcher.ts)                                                                                                | In-flight request coalescing.                                                                     |
| [reachback/reachback-env.ts](../../apps/server/src/modules/agent/acp/reachback-env.ts) · [remote_fs/rfs.route.ts](../../apps/server/src/modules/remote_fs/rfs.route.ts) · [remote_fs/space-execute.ts](../../apps/server/src/modules/remote_fs/space-execute.ts) | `HUABU_THREAD_ID` → `X-Huabu-Host-Thread-Id` → `originator.threadId` on `/execute`.               |
| [store/canvasSyncStore.ts](../../apps/web/src/store/canvasSyncStore.ts)                                                                                                                                                                                          | SSE subscriber: reconcile, apply, dirty-gap guard, conflict toast, thread attribution.            |
| [canvasStore/save/nodeContentQueue.ts](../../apps/web/src/store/canvasStore/save/nodeContentQueue.ts)                                                                                                                                                            | Per-node content saves, revision baselines, conflicts, `adoptRemoteContent`.                      |
| [store/canvasSyncSubscription.ts](../../apps/web/src/store/canvasSyncSubscription.ts)                                                                                                                                                                            | Reference-counted source-Space transports, retry, late-subscriber baseline, presence listeners.   |
| [store/remoteConversationOwner.ts](../../apps/web/src/store/remoteConversationOwner.ts)                                                                                                                                                                          | Shared local/remote snapshot observation, stale-result fencing and recovery calibration.          |
| [store/acpThreadChangesStore.ts](../../apps/web/src/store/acpThreadChangesStore.ts)                                                                                                                                                                              | Per-thread change records + staleness (`isChangeStale`), Keep / Revert.                           |
| [store/canvasStore.ts](../../apps/web/src/store/canvasStore.ts)                                                                                                                                                                                                  | `applyDeltasFromAgent` (dirty filter, order replay), `pendingContentNodeIds`.                     |
| [store/canvasStore/sync/](../../apps/web/src/store/canvasStore/sync)                                                                                                                                                                                             | Send queue, in-flight set, property units, field-level deltas, gesture diff commands.             |
| [ChangeReviewCard.tsx](../../apps/web/src/components/Panels/ChatPanel/ChangeReviewCard.tsx)                                                                                                                                                                      | Above-input Keep / Revert / preview card.                                                         |
| [pages/CanvasPage/CanvasPage.tsx](../../apps/web/src/pages/CanvasPage/CanvasPage.tsx)                                                                                                                                                                            | Connects / disconnects the sync stream on canvas load / switch.                                   |
| [types/api/canvas-presence.ts](../../packages/shared/src/types/api/canvas-presence.ts) · [canvas-presence-limits.ts](../../packages/shared/src/types/api/canvas-presence-limits.ts)                                                                              | Presence report / leave bodies, `presence` event, limits and timings.                             |
| [canvas/canvas-presence.ts](../../apps/server/src/modules/canvas/canvas-presence.ts) · [presence.route.ts](../../apps/server/src/modules/canvas/presence.route.ts)                                                                                               | In-memory presence per Space (relay, colours, rate, expiry); report and leave routes.             |
| [store/canvasPresence/](../../apps/web/src/store/canvasPresence)                                                                                                                                                                                                 | Other pages' presence store, throttled reporter, device label, edit lock and editing tracker.     |
| [Canvas/presence/](../../apps/web/src/components/Panels/Canvas/presence)                                                                                                                                                                                         | Reporting hook, remote cursors and remote node outlines.                                          |
