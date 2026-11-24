# Unified node order and placement

Status: Implemented on `feature/unified-node-order`, not merged — direction A ("everything on the node") confirmed by the owner on 2026-11-20. Shipped behaviour is described in `docs/architecture/`; this record keeps the design and where the implementation departed from it.
Last updated: 2026-11-24

> Prerequisite, merged as #450: the server starts preprocessing where a write is committed, and only for a node whose preprocessing input the write changed ([node-preprocessing.md](../architecture/node-preprocessing.md#who-starts-preprocessing)), so writing order data on a node starts none. An earlier form of that branch made pages compare the request input instead; it was replaced.

## Implementation notes

What was built differs from the sections below in these points; where they disagree, this list and `docs/architecture/` are current.

- **Commands were not rewritten one by one (§5).** They still say where a node goes by where they put it in the array. One pass, `settlePaintOrder`, turns that into keys at the end of a batch: a node without a key, or one that changed parent and still carries its old key, is keyed for the place it stands in. `REORDER_NODES` strips the moved nodes' keys and settles. Create, group, dissolve, reparent and restore needed no order code of their own, and keep their previous array behaviour (a reparented node keeps its slot; it does not jump to the front).
- **`applyDeltas` orders by key.** Every consumer of a delta batch gets the writer's order, including the server's second write path (`applyDeltasOnServer`), which previously sent no order at all and now also keys the nodes it inserts.
- **`reorderCommands` was kept (§8)** for `restorePlan.ts`: it verifies the result of an undo plan and places a returning Agent Node. It is no longer part of `commandsForStateDiff`; an undone reorder is sent as the node's previous `paintKey`.
- **Import still remaps the ids in a stored `layoutOrder` (§7, §8).** An archive exported before this change holds the list; the remap lets the read that follows convert it. The handling of `SET_SIBLING_ORDER` rows in imported history was removed: no production writer ever produced one.
- **Frames with no stored reading order are migrated too (not in §7).** `layoutOrder` was introduced (#386) without a migration and written only by a Frame's next relayout, so a Column / Row Frame that was never laid out again had no stored order: its children read by coordinate, ties by array order. `seedNodeOrder` records that order as track keys when the Space is read, using the layout solver's own reading order and leaving geometry alone. A locked Frame is not solved and keeps its implicit order.
- **Existing Spaces are converted once, not only when read (§7 recommended against it).** A conversion that happens only on read has no end and its result depends on the code at the time of the read: if the solver or key generation changed, a Space still in the old format would read in a different order. So the keys are stored once: by a Workspace preparation step on Disk, each time a folder is opened, and by a data-only schema version 5 on SQLite and Postgres, whose migration runners gained a data step for it. The read keeps `seedNodeOrder` for a Space that arrives in the old format later (an imported archive, a folder written by an older build). See [canvas-storage.md](../architecture/canvas-storage.md#order-keys-on-load).
- **One rule for when a track key stops meaning anything (not in §5).** `settleTrackKeys` drops the key of a child a write moved to another parent or track, or whose Frame it switched to another mode, when the child still carries the key it had; and of a node created into a Frame that already existed. The executor applies it after every command; commands that place a child declare it (`placedTrackKeyIds`). It replaced eight separate places that each dropped the key themselves (`CREATE_NODES`, `MERGE_NODE_DATA`, `SET_FRAME_LAYOUT` twice, the reparenting and unframing helpers, the page's drop projection); three defects found on this branch were one of those places missing the rule.
- **A copy keeps the reading order of its children.** Children of one track that share a key are read in id order, and a copy or a cross-Space move replaces the ids, so `withDistinctTrackKeys` writes that order into the keys first (`resolvePasteClipboard.ts`, `space-move-plan.ts`). Children created together with their Frame keep their keys (see the rule above).
- **A placement that changes nothing writes nothing.** `SET_FRAME_LAYOUT.placements` gives a new key only to a placed child that ends up in another track or between other neighbours (`movedInOrder`).
- **The second write path settles keys before it diffs.** `applyDeltasOnServer` keys inserted and reparented nodes before computing the rows it announces, journals and returns, so pages receive the keys that are stored.
- **A page re-sorts when a withheld paint key is installed.** Releasing a hold whose command changed nothing on the server installs the server's `data.paintKey`; the array is then ordered by the keys (`orderByPaintKeys`), since no update follows a no-op.
- **`materializeForestOrder` is gone (§5, §8 name it).** `settlePaintOrder` and `applyDeltas` return the rendered forest themselves, so nothing called it any more. `REORDER_NODES` also no longer seeds track keys before it reorders: the read conversion keys every Column / Row child, so there was never one left to seed.
- **Paint keys inside one batch.** `REORDER_NODES` settles against the batch's starting state (`batchPrestate`), so a sibling an earlier command of the batch moved in is read by where it stands, not by the key it had elsewhere. A command that names a paint key (`RESTORE_NODES`, a `MERGE_NODE_DATA` patch that carries one) declares it (`placedPaintKeyIds`) and the end-of-batch settlement keeps it even where it equals the key the node had under another parent.
- **A locked Frame stored without a reading order is keyed too.** The read conversion reads its order as if it were unlocked and leaves the Frame as stored; a lock refuses layout changes, and recording the order the Frame already reads in is not one.
- **Long keys are not re-spread (§3).** No rule for keys longer than 64 characters was added; appending or prepending stays under five characters after thousands of operations, and repeated insertion into one gap grows about one character per six insertions.
- **Verified:** engine, server and store unit suites; browser suites `multi-page-frames` (20), `multi-page-sync-baseline` (12), `structured-drop` (34), `preprocess-lifecycle` (7). **Not verified:** Postgres (no Docker on the development machine; the change adds no SQL), two real devices, and a Space migrated from production data rather than fixtures.

## 1. Problem

"Where a node sits among its siblings" is stored in three different ways, with three different conflict and undo behaviours.

| What                       | Where it is stored today                                                                                                                                                       | Unit a page holds, undoes and sends                                                   | Code                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paint (layer) order        | Not stored as a value: the node's index in `state.nodes`                                                                                                                       | The complete child list of one parent (`SET_SIBLING_ORDER` with `before` and `after`) | `packages/shared/src/canvas-engine/siblingOrder.ts:12`, `commands/reorderNodes.ts`, `container/zorder.ts:45,85`                                           |
| Column / Row reading order | Two places: the track index on the node (`data.frameColumn` for Column, `data.frameRow` for Row) and the order inside each track on the Frame (`data.layoutOrder: string[][]`) | The Frame's whole `layoutOrder` array, one `data.<key>` unit                          | `packages/shared/src/types/api/frame-layout.ts:7`, `autoLayout/layoutOrder.ts`, `autoLayout/gridLayout.ts:2252-2419`, `commands/setFrameLayout.ts:95-122` |
| Grid cell                  | On the node: `data.frameColumn` + `data.frameRow`                                                                                                                              | One node's two keys                                                                   | `autoLayout/gridLayout.ts:275,290,1043`, `commands/setFrameLayout.ts:175-209`                                                                             |

Consequences of the first two:

- A layer change sends, holds and replays a whole parent's child list. `orderEvents` exist only because entity deltas cannot express array order; a page that cannot replay them reloads (`apps/web/src/store/canvasStore/siblingOrderReplay.ts:29`, `canvasStore.ts:4293,4387`).
- The page holds order per parent (`orderKey(parentId)`, `apps/web/src/store/canvasStore/sync/inFlight.ts:51`), so two people changing the layer of different nodes in one container contend for one unit.
- `layoutOrder` is one last-writer-wins value. Undoing one move restores the whole list as it was, including the positions of nodes other people moved since.
- Column / Row placement already lives half on the node and half on the Frame, so "which track" and "where in the track" can disagree and every relayout rewrites the list to repair it (`gridLayout.ts:2361-2366`).

Not verified by running: the two-page contention cases above are read from the code (`deriveHeldKeys`, `inFlight.ts:225`), not reproduced.

## 2. Two directions

|                                             | A. Everything on the node (recommended)                                                 | B. Everything on the container                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape                                       | Each node carries its own paint key, its track + key inside the track, or its Grid cell | Each Frame carries the paint list, the track lists and a cell map of its children; the root needs a new Space-level record because it has no Frame |
| One move writes                             | One node                                                                                | The whole list of one container; a move between containers writes two containers and the node's `parentId`                                         |
| Two people, different nodes, same container | Independent; both survive                                                               | One list value wins, or the page withholds the other change                                                                                        |
| Undo of one move                            | Restores one node's value                                                               | Restores a whole list, undoing other people's moves in it                                                                                          |
| Membership                                  | `parentId` only                                                                         | `parentId` and the lists: two sources that must be kept equal (ids missing from or extra to a list)                                                |
| Possible bad state                          | Two nodes with the same key or the same cell                                            | Dangling or missing ids; never a duplicate position                                                                                                |
| Size of a change on the wire                | Constant                                                                                | Grows with the container                                                                                                                           |
| Change from today                           | Paint order and Column / Row order move to the node; Grid unchanged                     | Grid moves to the Frame; root order needs new storage; existing whole-list problems stay                                                           |

Recommendation: A. It removes the whole-list unit, it is already how Grid works and how every other node property syncs (`data.<key>` is merged per key, `apps/web/src/store/canvasStore/sync/propertyUnits.ts:7-17`), and its one new failure mode (equal keys or equal cells) is resolved deterministically without a repair pass (§6). B keeps the conflict and undo behaviour that prompted this work and adds a second membership source.

## 3. Target model

All three are plain keys in the node's `data`, so storage, sync, the in-flight hold, undo and the delta format need no new mechanism.

| Key on the node                              | Meaning                                               | Scope                                     |
| -------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `data.paintKey: string`                      | Paint order among siblings, ascending = further front | The node's current parent (root included) |
| `data.frameColumn` / `data.frameRow: number` | Track index in Column / Row; cell in Grid (unchanged) | The parent Frame                          |
| `data.trackKey: string`                      | Reading order inside the track (Column / Row only)    | The node's track in the parent Frame      |

`FrameNodeData.layoutOrder` is removed. `gridCount`, `gridRowCount`, `layoutMode` and `sizing` stay on the Frame: they describe the container, not a child.

Because a key is scoped to the parent, a key is rewritten in the same command that changes `parentId`. `data.paintKey` therefore joins the units a page holds together with placement (`PLACEMENT_UNITS`, `propertyUnits.ts`).

Agents cannot write these keys through `MERGE_NODE_DATA`: its patch schema is strict (`packages/shared/src/types/api/space-operations.ts`) and stays unchanged.

### Order key format

A fractional index: a string over `0-9A-Za-z` compared as plain code units, for which a new key can always be generated strictly between any two keys, before the first, or after the last. Generating `n` keys between two bounds is deterministic and evenly spread.

- New module `packages/shared/src/canvas-engine/orderKey.ts` exporting `keyBetween(a, b)`, `keysBetween(a, b, n)` and `compareOrder(a, b)` (key first, node id as the tie-break). No such utility or dependency exists in the repository today.
- Recommended implementation: the `fractional-indexing` algorithm (base 62, variable-length integer part, CC0). Either add the zero-dependency package to `packages/shared` or port its ~100 lines; the choice does not change the stored format.
- Keys grow by about one character per ~6 repeated insertions at the same spot. No rebalancing pass is planned; a command that would produce a key longer than 64 characters re-keys that parent's siblings evenly in the same batch.

## 4. Array order and the contiguity rule

`state.nodes` stays an array and keeps its two existing guarantees, but they become derived from the keys instead of being the stored truth.

- Parent before child (React Flow requires it; `container/tree.ts:66` `normalizeTreeOrder`).
- A Frame's subtree is contiguous in paint order (`container/zorder.ts:45` `assignNodeZIndices` walks the forest depth-first, siblings in array order).

Change: the depth-first walk orders siblings by `compareOrder` instead of by array index, and `materializeForestOrder` (`zorder.ts:85`) writes the array in that order. Since a key only ranks a node among the children of its own parent, a node can never be painted between another Frame's children: contiguity holds by construction and no command can break it. Rendering (`apps/web/src/components/Panels/Canvas/selectionZOrder.ts:19`), edge z, the layers panel and server snapshots already go through `assignNodeZIndices` and need no change of their own.

The array is re-materialized where it is normalised today: at the end of an engine batch (`executor.ts:423-432`) and after a page applies deltas (`canvasStore.ts:4285`). The second replaces `replaySiblingOrder` and cannot fail, so the "diverged, reload" path goes away.

## 5. Commands

| Command / gesture                                                                    | Today                                                                                                                | After                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REORDER_NODES` `top` / `bottom` (bring to front, send to back)                      | Rewrites the array; seeds `layoutOrder`                                                                              | Sets the node's `paintKey` after the last / before the first sibling. No relayout, no Frame write                                                                                                                                          |
| `REORDER_NODES` `before` / `after` (layers panel drag)                               | Rewrites the array                                                                                                   | Sets `paintKey` between the anchor and its neighbour                                                                                                                                                                                       |
| One step forward / backward                                                          | Does not exist (`uiIntent.ts` emits only `top`, `bottom`, `before`, `after`)                                         | Out of scope; trivial to add later as `before` / `after` the neighbour                                                                                                                                                                     |
| `SET_NODE_PARENT` (drag into or out of a Frame)                                      | Keeps the array slot; relayout rewrites `layoutOrder` and cells                                                      | Assigns a `paintKey` at the front of the new parent; clears `trackKey`, `frameColumn`, `frameRow` on leaving a structured Frame; the end-of-batch relayout assigns the new track / cell as today                                           |
| `CREATE_NODES`, paste, duplicate                                                     | Appended to the array; paste remaps `layoutOrder`                                                                    | New node gets a `paintKey` at the front of its parent. Paste keeps the copied nodes' relative paint order and their cells; the `layoutOrder` remap in `resolvePasteClipboard.ts:114-117` is deleted because the keys travel with the nodes |
| `RESTORE_NODES`, undo, redo                                                          | Restores `data` verbatim; order restored by `reorderCommands` (`localDiffCommands.ts:247`) and a whole `layoutOrder` | Order comes back as the restored node's own keys through the existing data diff; `reorderCommands` is deleted                                                                                                                              |
| `SET_FRAME_LAYOUT` `placements` (Column / Row)                                       | Edits the Frame's list, writes track indices                                                                         | Writes `frameColumn` / `frameRow` and a `trackKey` on each placed node only                                                                                                                                                                |
| `SET_FRAME_LAYOUT` `cells` (Grid)                                                    | Writes cells on nodes                                                                                                | Unchanged                                                                                                                                                                                                                                  |
| `SET_FRAME_LAYOUT` mode change                                                       | Deletes `layoutOrder`, cells, `gridCount`                                                                            | Clears `trackKey` and cells on the children; the solver re-seeds from geometry as today                                                                                                                                                    |
| Structured relayout (`applyStructuredFrameRelayout`)                                 | Rewrites the complete list each time                                                                                 | Reads tracks by sorting each track's children by `trackKey`; writes a key only for a child that has none (an incoming node, placed by its coordinate as today). It no longer writes to the Frame                                           |
| `DELETE_NODES`, `DISSOLVE_FRAME`                                                     | Relayout drops the ids from the list                                                                                 | Nothing to clean on the Frame. Dissolve gives the released children `paintKey`s at the dissolved Frame's position in its parent, in their former order                                                                                     |
| Drag-drop inside a structured Frame (`planStructuredDrop`, `resolveNodeDragStop.ts`) | Cell patches, or `SET_FRAME_LAYOUT`                                                                                  | Same commands; Column / Row drops use `placements` and so write only the moved node                                                                                                                                                        |

Not verified: whether `unframe` (`frame/mutation.ts`) clears a released child's `frameColumn` / `frameRow` today. The implementation must read it before changing dissolve.

## 6. Equal keys and equal cells

The server executes commands one after another, so a command always sees the result of the previous one: a collision is resolved when the second command runs, not by a merge. The rules below cover what remains.

- **Equal `paintKey` or `trackKey`.** Possible when two pages generate a key for the same gap before either is answered. Order is `compareOrder`: key, then node id. Every page and the server compute the same order, so nothing diverges and no repair is needed. A later command that must insert between two equal keys re-keys the upper one as part of its own batch.
- **Two nodes in one Grid cell.** Unchanged from today: `assignGridRows` (`gridLayout.ts:1043`) sorts by requested row, y, id and moves the later node to the next free row; the relayout writes the resolved cell back to that node. A drop on an occupied cell is still planned as a swap (`planStructuredDrop`, `gridLayout.ts:1728`).
- **A child without a key or a cell.** Treated as incoming and placed by geometry, as an id missing from `layoutOrder` is today.

## 7. Existing Spaces and storage

Read from the code: none of the three backends has an order column. Order is the array order of `state.nodes` inside the Space record — `space.json` on Disk (`storage/backends/disk/space-write.ts`), `spaces.state_json` in SQLite (`backends/sqlite/schema.ts:52`) and in Postgres (`backends/postgres/schema.ts:23`). The new keys are node `data`, which already lives in that record.

Therefore no schema change is needed, and Disk has no format version for `space.json`. This PR performs one database upgrade, and it is data-only: SQLite and Postgres schema version 5 changes no table and stores the keys of existing Spaces once, so that their order does not depend on the code that reads them later; a Disk Workspace does the same when it is opened ([canvas-storage.md](../architecture/canvas-storage.md#order-keys-on-load)).

What existing Spaces need is their keys. One pure, deterministic function `seedOrder(nodes)` in `packages/shared`:

- Per parent, siblings in their current array order receive `keysBetween(null, null, n)`.
- Per Column / Row Frame, each track of `layoutOrder` gives its ids `keysBetween(null, null, n)`; the track index is already on the node. `layoutOrder` is then removed from the Frame.
- Nodes that already carry keys are left alone, so the function is idempotent.

Recommended place: where a Space record is decoded (the read path all three backends share), next to the existing load-time topology repair (`docs/architecture/canvas-storage.md` "Retired Portal/Pin topology on load"). The seeded state is what the executor and `GET /api/canvas/:id` see; it is stored the next time that Space commits, since a commit writes the whole `state.nodes`. Because the function is deterministic, a Space read twice before its first write yields the same keys. Seeding is applied to the state a batch starts from, so it produces no deltas and no undo entry.

This also covers Spaces that arrive later in the old shape: imports (`import-space-identity.ts:366` remaps `layoutOrder` today), cross-Space moves (`space-move-plan.ts:218`) and checkpoint restores.

Alternative considered: a one-shot rewrite of every Space at boot. Disk has such a mechanism (`apps/server/src/modules/workspace/migrations/*`); SQLite and Postgres migrations are DDL-only and never rewrite records, so this would add a new data-migration facility, make boot time grow with the number of Spaces, and still not cover imports. Not recommended.

Stored request outcomes (`space_save_results.response_json`, kept about two weeks) may contain `orderEvents` from before the upgrade. A replayed response then carries a field no page reads; nothing is done about it.

## 8. Removing `orderEvents`

Deleted together with the paint-key change, in one commit, so no state exists where both mechanisms are live:

- Engine: `siblingOrder.ts` (events, `diffSiblingOrderEvents`, `applySiblingOrderEvents`, `collectSiblingOrders`; `admitSiblingReorder` is kept and returns a key), `OrderedDelta` and `applyOrderedDeltas` (`delta.ts:261,285`), the `orderVersion` mode of `diffCanvasState` (`diff.ts:59-142`), `withMasonryLayoutOrder` (`gridLayout.ts:2445`).
- Server: `siblingOrderEventsFor` and the `orderChanged` special case (`canvas-executor.ts:149,2034-2068,2184,2281`), the field in `execute-outcome.ts:90,187,328,371`.
- Wire: `orderEvents` in `packages/shared/src/types/api/canvas-sync.ts:103` and `canvas.ts:656`. A pure reorder now produces an ordinary node delta.
- Web: `siblingOrderReplay.ts`, the `orderEvents` parameter of `applyServerDeltas` (`canvasStore.ts:4157-4387`, `canvasSyncStore.ts:433,1831`), the per-parent order hold (`orderKey`, `orderHeld`, `inFlight.ts:51,203`, `browserSync.ts:192,594`), `reorderCommands` (`localDiffCommands.ts:247`).
- To check during implementation: `import-space-contracts.ts:190-200` validates `SET_SIBLING_ORDER` rows inside historical `deltas` / `revertDeltas`. The delta log is documented as entity-only; if exported Spaces can still contain such rows, import drops them instead of remapping.

## 9. Agents

No change to what an Agent sends or reads.

- `REORDER_NODES` keeps `top` / `bottom` / `before` / `after` (`space-operations.ts:317-331`). `SET_FRAME_LAYOUT` keeps `placements`, `cells`, counts and modes (`:383-443`).
- `INSPECT_NODES` `layout` keeps `{ mode, tracks }` for Column / Row and `{ mode: 'grid', cells }` for Grid; `describeFrameLayout` (`gridLayout.ts:2468`) builds `tracks` from the keys instead of the list. Paint position is not exposed today and stays unexposed.
- Guides (`apps/server/src/prompt/skills/space/references/layout-recipes.md`, `prompt/external-agent/*/access-huabu.md`) describe reading order versus paint order in terms that remain true. They are re-read during implementation; no edit is expected.

## 10. Commits and verification

One PR, one branch (`feature/unified-node-order`), no database upgrade.

1. `orderKey` utility with unit and property tests (random insertions stay strictly ordered; `keysBetween` is deterministic).
2. Paint order: key-ordered `materializeForestOrder`, `REORDER_NODES`, key assignment in create / parent / dissolve / restore, `seedOrder` for paint keys at Space decode, removal of `orderEvents` end to end (§8). Docs: `canvas-realtime-sync.md` "Sibling paint order", `canvas-command-architecture.md` "Sibling paint order and isolated replay", `api-design.md:156`.
3. Column / Row order: solver reads `trackKey`, `placements` and relayout write per node, `seedOrder` for tracks, removal of `layoutOrder` (type, schema, paste remap, import and cross-Space remaps). Docs: `canvas-command-architecture.md` "Structured placement and reading order" (which currently states there is no ordering key).
4. Web cleanup: order hold, `reorderCommands`, layers panel reading keys.
5. `canvas-storage.md`: the stored shape and load-time seeding; this proposal's status.

Verification, each written to fail first:

- Engine: two replicas applying the same reorders in different interleavings end with the same order; contiguity and parent-before-child hold after random reorder / reparent sequences; equal keys order by id; Grid collision resolution unchanged (existing tests keep passing untouched).
- Seeding: fixtures of a pre-change Space (nested Frames, a Column and a Row Frame with `layoutOrder`, a Grid) decode to the same paint order, tracks and cells as before, on Disk and SQLite locally. Postgres can only run in CI: this machine has no Docker.
- Sync (`canvasStore.browserSync.test.ts` harness): two pages change the layer of different nodes in one container and both survive; undo of one Column move does not move a node another page moved; a pure reorder arrives as a node delta and no reload path exists.
- Browser: `multi-page-frames.spec.ts`, `multi-page-sync-baseline.spec.ts`, `structured-drop.spec.ts`, layers panel reorder, and the preprocessing case from the prerequisite (a layer change and a Column move send no `/preprocess`).
- Agent: existing RFS execute tests for `REORDER_NODES` and `SET_FRAME_LAYOUT`, and `INSPECT_NODES` `layout` output unchanged for the seeded fixtures.

## 11. Open points

- Direction A versus B: recommended A, not yet confirmed by the owner.
- Whether to add one-step forward / backward while here: recommended no (separate, small).
- Facts in this document come from reading the code at `origin/main` `091cd4185`; none of the proposed behaviour has been run.
