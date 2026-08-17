# World Canvas

> Explore a workspace-level semantic canvas above project Spaces without dissolving their storage and execution boundaries.
>
> Status: **Shipped** · Last updated: 2026-08-08 · Tracks: [#346](https://github.com/hai-team/Huabu/issues/346)

---

## 1. Purpose

Huabu currently exposes each Space as both a top-level navigation unit and an independently persisted canvas. This works within a project but fragments cross-project thinking across separate surfaces.

This proposal records the shipped first-version design for a workspace-level **World Canvas**.

The desired product hierarchy is:

```text
Workspace
  └─ World Canvas
       ├─ native World nodes and edges
       └─ canvasRef node
            └─ semantic projection of one project Space
```

## 2. Shipped contract

### Agreed baseline

1. Each workspace has one World Canvas.
2. The World is a normal canvas scope rather than a derived dashboard. It may own native nodes, edges, and regions.
3. A project appears in the World as a special `canvasRef` node that references an independently persisted Space.
4. **Project Portal** is the product and rendering concept represented by a `canvasRef`; it is not a second persisted entity.
5. A `canvasRef` is a distinct node type with container semantics shared with Frame: it may own real World child nodes using `parentId` and parent-local coordinates, without inheriting every Frame-specific layout and interaction policy.
6. A `nodeRef` is a World-owned symbolic reference to one canonical non-Frame node in another canvas. A `frameRef` is the corresponding World-owned Container reference for a source Frame; it may own `nodeRef` and nested `frameRef` children.
7. The first version materializes references only after an explicit pin. Pinning a source Frame atomically snapshots its current recursive subtree into one `frameRef` hierarchy; re-pinning an existing `frameRef` is an idempotent no-op and does not reconcile later source additions, deletion, reparenting, geometry, or layout changes.
8. Explicit Portal pin state is controlled by one shared executable `SET_PORTAL_NODE_PINS` command. UI intents may resolve selection into explicit operands, while UI and agents use the same command handler and execution semantics.
9. Entering a project should feel like a continuous camera transition while technically switching between independently rendered canvas scopes and coordinate systems.
10. The World is stored at `<workspace>/.world/space.json`. Its `canvasId` is generated once and remains stable; it is exposed through `WorkspaceInfo.worldCanvasId` but omitted from ordinary Space listings.
11. `canvasRef` remains a distinct node type and implements a minimum Container protocol shared with Frame; it does not reuse the `frame` type or inherit Frame-specific policy.
12. `canvasRef`, `frameRef`, and `nodeRef` persist reference identity only. Source titles, node types, labels, previews, revisions, and missing states are resolved in batches as non-persistent read data; the persisted node type itself records the minimum structural distinction that `frameRef` is a Container.
13. A pinned `frameRef` or `nodeRef` is a real entry in the World `state.nodes` array, not renderer-private `canvasRef.data`. Each inherits ordinary node properties and behavior such as selection, dragging, locking, geometry history, delta/SSE, and future edge compatibility; `frameRef` additionally inherits the minimum generic Container behavior required for hierarchy, movement, locking, fit, and recursive deletion without inheriting ordinary Frame layout, dissolve, overlap-capture, or source reconciliation.
14. Newly pinned references receive one-time placement derived from the source hierarchy and geometry. Existing World references adopted by a later Frame Pin are reparented while preserving their absolute World positions; no existing World geometry, style, lock state, or edge follows later source changes.
15. In the first version every reference remains inside its matching `canvasRef`: direct pins are Portal children, while recursively pinned descendants may be nested under `frameRef` ancestors. Top-level promotion is deferred.
16. Portal and `frameRef` content-hug geometry are authoritative. Each Container wraps its direct children after Pin, Unpin, and child movement and is not manually resizable in the first version.
17. All edges persist in the World `state.edges` array. An edge is Portal-local when both endpoints descend from the same `canvasRef`; nested `frameRef` ancestry does not create another edge persistence scope.
18. Source-Space edges are neither displayed nor mirrored in the first version. Portal-local edges exist only when explicitly created in the World.
19. References use symbolic-link failure semantics. Deleting a source Space or node leaves an explicit broken `canvasRef`, `frameRef`, or `nodeRef`; source deletion is neither blocked nor cascaded into the World.
20. First-version Portal activation is explicit through double-click, Enter on a selected Portal, or an Open action. It uses ordinary scope switching and breadcrumb return; a one-way camera push follows as a separate increment, while gesture-driven zoom-through is deferred.
21. Undo/redo history is partitioned by `canvasId` and restored on scope switch. Cmd/Ctrl+Z applies only to the currently active World or Space and never forms a cross-scope global timeline.
22. World Canvas and Space List are sibling workspace pages. Every live ordinary Space has exactly one canonical `canvasRef` in the World; a Portal may be empty when no source nodes have been pinned.
23. Existing and newly created Spaces are reconciled into the World automatically. The system assigns an initial position only to a newly materialized Portal; once placed, its World geometry is user-owned and is never automatically rearranged because another Space appears or the World reopens.
24. Cross-scope command routing lives in a server host layer above `executeOnServer()`. A routed execution still mutates exactly one Canvas, and one batch may not mix commands whose mutation scopes differ.
25. First-version Pin and Unpin do not enter snapshot-based undo history in either scope because protected reference topology cannot be recreated through the legacy full-state restore boundary. Any mutation that changes `frameRef` or `nodeRef` membership, including recursive subtree adoption or removal, invalidates the World history manager because its snapshots may retain obsolete identities, while an active source Space retains its independent history. The user restores desired pin state through the inverse Pin/Unpin operation.
26. A `nodeRef` that targets a source agent/question node may act as a World presentation shortcut for that source-owned conversation. The visible UI anchor belongs to the World `nodeRef`, while thread history, agent binding, tools, context, and mutations remain owned by the target agent node and source Space.
27. Source-owned conversations may execute headlessly while their Space is not rendered. The World does not load the source React Flow state; it presents the conversation through a resolved read model and addresses backend work by the source `{ canvasId, nodeId, threadId }`.
28. A global user setting controls whether the World entry is visible and whether workspace navigation lands on World or Space List. Disabling the setting never deletes or resets World data.
29. A live canonical Portal cannot be hidden or deleted independently of its Space. Only a broken Portal whose source Space is missing may be removed.
30. `SET_PORTAL_NODE_PINS` accepts grouped desired-state updates keyed by source Canvas and source node IDs. It does not require callers to discover `portalId`; the host resolves each source Canvas to its unique canonical Portal and expands source Frames recursively inside the same World mutation.
31. World conversations reuse existing query/read operations with an explicit target Canvas obtained from `canvasRef.targetCanvasId`. No separate public `PortalQuery` protocol is introduced, and cross-Space writes are not added to ordinary World conversation tools.
32. Conversation and source agent-node ground truth remain server-owned. Every valid source agent node owns a thread from creation, including an idle thread with no messages yet. A `nodeRef` never creates a thread or persists copied lifecycle state; it only presents the source-owned thread.
33. First-version resolved-reference freshness is boundary-driven: resolve on World load, shortcut open, window focus, headless turn boundaries, and Pin/Unpin completion. A general realtime cross-canvas invalidation bus is deferred until all server mutation surfaces emit unified notifications.
34. A headless shortcut preserves the source conversation's existing Ask/Operate mode. World shows command results and an Open Space action; full Change Review remains in the source Space in the first version.

## 3. Terminology

| Term           | Working meaning                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace      | The selected Home folder that contains user settings and canvases.                                                                              |
| World Canvas   | The workspace-owned top-level canvas used for cross-project thinking and navigation.                                                            |
| Space          | An independently persisted project canvas with its own content, version, execution, and agent scope.                                            |
| `canvasRef`    | A special World container node that canonically references one Space.                                                                           |
| Project Portal | The visual and interaction experience rendered by a `canvasRef`.                                                                                |
| `frameRef`     | A persistent World Container that symbolically references a source Frame and owns a snapshot projection of its pinned subtree.                  |
| `nodeRef`      | A persistent World node that symbolically references one canonical non-Frame source node in another canvas.                                     |
| Pin            | Explicitly create or retain a source reference; a Frame Pin recursively snapshots its current subtree.                                          |
| Unpin          | Remove a World-owned reference without deleting or editing its canonical source node; unpinning a `frameRef` removes its current World subtree. |

## 4. Scope model

The World should reuse the normal canvas persistence and execution model wherever possible. It should have its own stable canvas identity, state, version, viewport, selection, undo history, and realtime-sync stream.

The World is a Canvas, not a parallel application mode. Unless cross-Canvas reference ownership or routing requires an explicit difference, it inherits ordinary Canvas behavior for selection, ChatPanel focus, concurrent agent runs, streaming, permissions, stopping, history, navigation-away behavior, and error presentation. This proposal must not introduce a World-specific scheduler, task model, multi-panel chat system, notification center, or other general Canvas capability.

Each project Space remains a separate scope with its existing `CanvasStore`, node sidecars, command execution, revision/CAS rules, agent context, and runtime namespace.

The current architectural preference is that one mutation belongs to one canonical canvas scope:

- Moving a `canvasRef`, creating a World note, or changing a cross-project relationship mutates the World.
- Pinning or unpinning mutates the World because it creates or removes a World-owned `nodeRef`; it does not mutate the source node.
- Editing through a `nodeRef` routes the authored-content operation to its source Space using a canonical reference such as `{ canvasId, nodeId, rev }`.
- A World interaction may initiate a source-Space command, but one `CanvasExecution` should not atomically mutate both scopes.
- Undo, version progression, CAS, and SSE delivery remain owned by the scope that was mutated.

This is the first-version implementation contract. It preserves the current single-canvas transaction boundary and avoids introducing cross-canvas transactions.

### World discovery and lifecycle

Workspace preparation should run an idempotent `ensureWorldCanvasOnDisk(workspacePath)` after existing migrations. A workspace without `.world/space.json` receives an empty World with a newly generated stable `canvasId`; subsequent activations reuse the persisted identity.

The hidden directory is deliberately outside the ordinary Space index. The current scanner in [`canvas-dirs.ts`](../../apps/server/src/modules/storage/backends/disk/canvas-dirs.ts) already skips dot-prefixed entries; it should read `.world/space.json` into a separate World entry without returning it from `listCanvasDirEntries()`. `canvasDirName(worldCanvasId)` should resolve that entry to `.world`, allowing the existing `getCanvasStore(worldCanvasId)` and all canvas-relative path helpers to continue operating unchanged.

The World must use a generated ID rather than a fixed `canvasId = "world"`. Frontend viewport persistence is keyed only by canvas ID, and Agenetes uses canvas ID as its namespace name; a generated ID prevents different workspaces from sharing those identities.

When configured, `WorkspaceInfo` resolves `worldCanvasId` through `StructuredStore.catalog().worldId()`. This is the frontend's discovery mechanism; `catalog().list()` must not return the World alongside ordinary Spaces.

Several normal-Space behaviors require explicit World guards:

- [`CanvasStore.read()`](../../apps/server/src/modules/storage/canvas-store.ts) must not interpret the reserved `.world` basename as a Finder-side rename and rewrite the World title to `.world`.
- Delete, directory rename, import replacement, and any conversion between World and ordinary Space must reject the World identity.
- A missing or malformed `.world/space.json` after the directory has been established must surface an integrity error rather than silently creating a second identity.

### Canonical Portal reconciliation

The World and the existing Space List are sibling workspace pages. A global user setting hides the World entry and keeps Space List as the workspace landing page when disabled; when enabled, both sibling pages are available and World is the landing page. This setting never deletes `.world/space.json` or changes its stable identity.

The World is not a replacement storage index for the list, but its persisted topology automatically maintains one canonical `canvasRef` for every live ordinary Space.

When the World capability is first used, reconciliation creates missing Portals for existing Spaces and gives only those new Portals deterministic initial positions. Creating another Space later creates its missing Portal on the next reconciliation without moving any existing Portal. Reloading the World likewise preserves every user-owned position. The implemented reconciliation runs before a World read and before a Portal Pin whose source Space has no Portal yet, serializes concurrent reconciliation attempts, and rejects duplicate or malformed persisted Portal identities. Pin therefore never requires the user to visit the World first, while still creating no topology of its own: it can only restore the standing `live Space ⇔ one live canonical Portal` invariant.

A canonical Portal may be empty. Empty means that the Space exists but no source nodes currently have persistent `frameRef` or `nodeRef` descendants; derived Portal chrome may still show the resolved project title, summary, and bounded statistics.

Source deletion retains the already agreed symbolic-link behavior: its canonical Portal becomes broken rather than disappearing silently. A live canonical Portal cannot be hidden or removed independently of its Space; only a broken Portal may be removed explicitly. This keeps `live Space ⇔ one live canonical Portal` as a stable reconciliation invariant without hidden-state or suppression tombstones.

The first implementation exposes `/spaces` as the explicit Space List sibling and keeps `/canvas/:canvasId` as the route for both World and ordinary Spaces. `/` redirects to World when the global setting is enabled and to `/spaces` otherwise. The setting defaults to disabled so existing users continue landing on the Space List until they opt into World.

## 5. Reference-node working model

A `canvasRef` and its pinned `frameRef` / `nodeRef` descendants are ordinary persisted World canvas nodes. Their conceptual data shapes are:

```typescript
interface CanvasRefData {
  targetCanvasId: string;
}

interface FrameRefData {
  type: 'frameRef';
  target: {
    canvasId: string;
    nodeId: string;
  };
}

interface NodeRefData {
  type: 'nodeRef';
  target: {
    canvasId: string;
    nodeId: string;
  };
}
```

These are the shipped reference payloads. Source identity is `{ canvasId, nodeId }`; a revision may accompany resolved read data or a write as a freshness/CAS token but does not become part of reference identity. Ordinary World-owned node metadata such as lock state and visual style may coexist with the payload, but copied source-owned labels, previews, content, layout modes, revisions, and lifecycle state may not. `frameRef` is a persisted node type because Container capability is durable World structure rather than resolved display data.

Pinned references use the existing React Flow node structure:

```text
canvasRef
  ├─ nodeRef
  │    parentId = canvasRef.id
  └─ frameRef
       parentId = canvasRef.id
       ├─ nodeRef
       └─ frameRef
            └─ nodeRef
```

The source Space owns each referenced node's authored content. The World owns reference identity, parentage, geometry, World relationships, and any World-specific presentation settings.

Project summary and ephemeral agent activity need not become child nodes. They may remain derived renderer content until a stable persisted use case is established.

Although `canvasRef` is a generic name, the first implementation should consider allowing it only on the World and allowing references only to ordinary project Spaces. Arbitrary nesting, references back to the World, and reference cycles should not be enabled implicitly.

### Reference read resolution

No reference node creates a markdown sidecar in the first version. Renderer-visible source data must be batch-resolved from the target Canvas stores.

This separation is required by the current persistence path: the canvas structure PUT strips `label`, `src`, `summary`, and related content keys from every node before writing `space.json`, while normal nodes recover those fields from sidecars in the same canvas. Copying source display fields into World reference data would either be stripped with no World sidecar to restore them or persist under parallel field names and become stale duplicate state.

The persistent World topology therefore carries only reference identity and World-owned presentation state. `GET /api/canvas/:worldCanvasId/references` returns a separate non-persistent batch read model with source Canvas title or source node type, label, summary, preview, revision, and `ok | canvas-missing | node-missing` status.

Every `frameRef.target` and `nodeRef.target` retains both `canvasId` and `nodeId` regardless of parentage. A future promoted reference must remain independently resolvable without deriving source identity from its former parent.

### Broken references

Directory rename and source-node rename do not break references because Canvas and node identity use stable IDs. Source-node geometry changes likewise do not affect the World-owned `nodeRef.position`.

The reference resolver distinguishes:

- `ok` — target Canvas and node exist.
- `canvas-missing` — `canvasRef.targetCanvasId` or a source reference's `target.canvasId` cannot be resolved.
- `node-missing` — the target Canvas exists but the target node ID does not.

Filesystem or parsing failures must surface as errors rather than being collapsed into a missing-target state.

Deleting a source Space or source node does not mutate the World. Broken `canvasRef`, `frameRef`, and `nodeRef` entries retain their World IDs, geometry, selection behavior, descendants, and incident World edges; they remain removable through normal Portal/Unpin actions. Restoring a source object with the same stable ID automatically heals the resolved view.

The first version does not persist a last-known label or preview. Broken renderers show an explicit type-specific placeholder and may include a shortened stable ID when space permits. Source deletion UI may warn that World references will become unavailable, but it must not block or silently cascade the deletion.

### Container semantics

The parent/child forest, parent-local coordinates, cycle protection, tree ordering, and subtree z-order now live under the shared [`container`](../../packages/shared/src/canvas-engine/container) module. Frame delegates generic hierarchy, reparenting, z-order, and content-hug geometry to that module while retaining its own interaction and layout policies.

The shared Container protocol includes:

- A child may persist `parentId` pointing to a valid Container.
- Child `position` is parent-local, and move-in/move-out preserves absolute placement.
- Parent cycles are rejected or defensively repaired.
- Parents precede descendants in the node array.
- Each subtree occupies a contiguous render z-order band.

The engine exposes explicit `isContainerNode()` / `canParentNode(parent, child)` policy and generic `moveNodeIntoContainer()` / `moveNodeOutOfContainer()` operations. `SET_NODE_PARENT` requires a valid Container parent rather than accepting any existing node.

Frame-only policy remains:

- Overlap-driven automatic capture and release.
- Arbitrary ordinary-node children.
- Hug sizing and column/row layout.
- Frame label preprocessing.
- Dissolve/unframe semantics.
- Cascade resize behavior.

Portal-only policy is:

- Direct children are `frameRef` or `nodeRef` nodes whose source canvas matches `canvasRef.targetCanvasId`.
- `SET_PORTAL_NODE_PINS` is the entry point for adding and removing children.
- Portal-local initial placement uses a Portal-specific deterministic policy.
- A Portal never releases a child because it was dragged beyond the previous boundary.
- Portal content-hug uses the shared Container bounding-box primitive with Portal-specific header inset, padding, minimum size, and eligibility rules.
- A Portal does not enter Frame label-preprocessing, structured-layout, dissolve, overlap-capture, or manual-resize effects.

`frameRef`-only policy is:

- Children are `frameRef` or `nodeRef` nodes targeting the same source Canvas.
- Its persisted hierarchy is a World-owned snapshot of source Frame containment at explicit Pin time.
- It uses generic Container movement, lock propagation, z-order, content-hug, and recursive deletion.
- It does not inherit source Frame layout settings, label persistence, dissolve, overlap-capture, cascade resize, or later source reconciliation.

## 6. Portal node pin command

Pinning and unpinning are two desired states of one domain operation in the shared `CanvasCommand` layer, not UI-only composition over generic create and delete commands.

The command uses the product concept **Portal** rather than the implementation type `canvasRef`. Its conceptual shape is:

```typescript
interface SetPortalNodePinsCommand {
  type: 'SET_PORTAL_NODE_PINS';
  updates: Array<{
    sourceCanvasId: string;
    sourceNodeIds: string[];
    pinned: boolean;
  }>;
}
```

The shared zod-first agent schema now implements this shape with canonical `canvas-*` and `node-*` identifiers. The server injects resolved Portal IDs, fresh `nodeRef` IDs, and source-position hints only after public validation; those fields are not accepted on the wire or returned to callers.

Each update identifies one source Space and a batch of canonical source nodes. The host resolves `sourceCanvasId` to the unique World `canvasRef` whose `targetCanvasId` matches it. For a non-Frame source, `pinned: true` ensures one persistent `nodeRef` exists under the nearest already-pinned source-ancestor `frameRef`, falling back to the Portal without creating a missing ancestor implicitly. For a source Frame, `pinned: true` atomically snapshots its current complete subtree as a hierarchy of `frameRef` and `nodeRef` nodes. `pinned: false` removes the matching reference; removing a `frameRef` recursively removes its current World descendants without consulting the source hierarchy again.

The grouped shape can update several canonical Portals in one command while still producing one World mutation. Exact duplicate desired states are deduplicated. If the same `{ sourceCanvasId, sourceNodeId }` appears with both `pinned: true` and `pinned: false`, the entire command is rejected before mutation.

Pin state is explicit and durable: source references either exist or do not exist in their Portal projection. A recursive Frame snapshot is not a subscription, reconciliation declaration, or live mirror.

The `NODE` segment in `SET_PORTAL_NODE_PINS` identifies what is pinned and avoids implying that the Portal itself is position-pinned. The command description exposed to agents should state: "Add or remove symbolic references to source Space nodes inside a Project Portal. This never modifies or deletes the source nodes."

The shared handler enforces World-local invariants:

- Every `sourceCanvasId` resolves to exactly one canonical `canvasRef`.
- A missing canonical `canvasRef` triggers the standard World reconciliation once; the command is rejected only when the source Canvas is still not a live Space afterwards. Pin never invents Portal topology of its own.
- Every pinned `sourceNodeId` exists in that source Canvas.
- Pinning a source Frame traverses its current descendants recursively, creates `frameRef` for Frame nodes and `nodeRef` for other nodes, preserves source hierarchy among newly materialized references, and adopts already-pinned descendants into that hierarchy while preserving their absolute World positions.
- Pinning a non-Frame source under an already-pinned source ancestor uses the nearest matching `frameRef`; it never creates an ancestor reference implicitly.
- Unpin may target a missing source Canvas or node when a matching broken `frameRef` or `nodeRef` remains in the World.
- At most one pinned reference exists per source node inside one Portal subtree.
- `pinned: true` is idempotent when the reference already exists.
- `pinned: false` is a no-op when the reference is already absent.
- `pinned: false` removes only World references, never canonical source nodes; removing a `frameRef` cascades through its current World subtree, including descendants adopted from earlier direct pins.
- Newly pinned references receive deterministic Portal-local placement; callers and agents do not submit coordinates.

The minimal UI toolbar reads the current selection and submits the same explicit command operands through `POST /api/canvas/:canvasId/execute`; it does not create or delete references locally. Agents submit the identical command through `space_commands`.

Because pin state is explicit and durable, a source Space can derive it: while the World setting is enabled, an active Space resolves the World's references and keeps the subset targeting its own nodes. The selection toolbar therefore presents Pin as one stateful toggle rather than two competing actions, so the current pin state is visible before acting. A mixed multi-selection keeps separate Pin-all and Unpin-all actions because no single toggle state describes it.

The command executes against the World canvas because the durable mutation is the creation or removal of World nodes. Source-node existence and authorization are resolved by the server host router before the pure shared engine runs, and UI and agent callers converge at that routing boundary.

Public invocation may originate from a source Space or the World. [`canvas-command-router.ts`](../../apps/server/src/modules/canvas/canvas-command-router.ts) sits above `executeOnServer()`, resolves the workspace World and existing canonical Portals, validates source operands, prepares non-agent-facing placement hints, rejects mixed-scope batches, and returns the actual mutated World canvas identity. Its only World-topology repair is delegating to the shared idempotent Portal reconciliation when a pinned source Space has no Portal; it never fabricates Portals, references, or parentage outside that invariant.

The router rejects a batch that mixes source-local commands with World-mutating Portal Pin commands. The existing execution response, version transition, mutex, delta log, and SSE stream each describe one mutated Canvas and must not be widened into a cross-canvas transaction.

Because every live Space has exactly one canonical Portal, callers never discover or choose among Portal IDs. The host may inject resolved Portal IDs into an internal prepared representation before the pure World engine runs; they are not part of the public command contract.

### Initial pinned-reference placement

Placement uses source geometry as a one-time hint rather than copying the source Canvas coordinate system:

1. The first pinned source node is placed at a deterministic default Portal anchor.
2. A later source node selects the nearest already pinned source node by absolute source position.
3. The source-space delta preserves relative direction while its distance is compressed into a bounded Portal-local offset.
4. The corresponding existing `nodeRef` position becomes the Portal anchor for the candidate.
5. A deterministic nearby-slot search resolves collisions without moving existing children.
6. During a batch on an empty Portal, the first stable input becomes the initial anchor and each newly placed reference joins the anchor set for subsequent items.

The server host resolves source hierarchy and geometry and supplies internal placement hints before the pure World handler executes. These hints are not agent-facing operands and are not persisted after reference geometry and parentage are written.

After creation, the World owns reference geometry. Moving the source node, changing source Frame membership, pinning another node, or reloading resolved read data must not reposition an existing reference. Reparenting an existing reference during explicit recursive Frame Pin preserves its absolute World position. Manual World placement otherwise always wins.

### Portal content-hug boundary

Every first-version source reference remains within its matching Portal subtree. Dragging a direct Portal child or a `frameRef` descendant changes only World-owned parent-local geometry; it must not invoke ordinary Frame overlap-based auto-unframe behavior.

After Pin, Unpin, or child geometry changes, a Portal-specific fit pass computes the direct children's local bounding box, applies a larger top inset for Portal chrome plus fixed side and bottom padding, and updates the `canvasRef` position and size. If the fitted origin shifts, all child local positions are offset inversely so their absolute World positions remain unchanged.

The shared Container fit primitive provides the required pure geometry for bounding children, shifting a parent origin, and preserving child absolute positions. Frame, Portal, and `frameRef` retain separate eligibility and sizing policies.

Portal content-hug is the sole size authority in the first version:

- `canvasRef` has no manual resize affordance.
- Moving a child outward expands the Portal after commit.
- Moving children closer together or Unpinning shrinks the Portal.
- An empty Portal returns to a deterministic default minimum size.
- During a drag the child may render beyond the old boundary; a fit preview may show the pending boundary, and the committed boundary always encloses every child.

### World and Portal-local edges

`canvasRef` is not a separate Canvas state and does not own an independent edge array, version, executor, or undo history. Every edge between World nodes therefore uses the existing World `state.edges` representation and `CONNECT_NODES` / `DISCONNECT_EDGES` commands.

Edge scope is derived from endpoint parentage:

- When both endpoints descend from the same `canvasRef`, including through nested `frameRef` nodes, the edge is Portal-local.
- When endpoints belong to different Portals, or either endpoint is a World-native node, the edge is World-global.

No `portalId` is persisted on the edge. Such a field would duplicate the endpoints' current parent relationship and could drift if later versions allow reparenting. Deleting a `canvasRef` already cascades through descendants, and existing node deletion semantics remove every incident edge by endpoint ID.

Portal-local describes semantic and rendering scope only; durable ownership, undo, versioning, delta/SSE, and deletion remain World responsibilities.

Source-Space edges do not participate in the first version. Pinning both endpoints of a source edge does not create, persist, or render a Portal-local edge. A later read-only projected-edge layer may be explored independently without changing World edge ownership, but it is not part of the initial contract.

## 7. Navigation and rendering

World and project Spaces should use independent coordinate systems. A project's internal layout must not determine the size or geometry of its `canvasRef` in the World.

The first version uses explicit activation: single click keeps normal selection semantics, while double-click, Enter on a selected `canvasRef`, or an Open action enters the target Space. Navigation switches to the target `/canvas/:canvasId`, activates its renderer, viewport, selection, undo stack, and sync stream, and exposes a `World > Project` breadcrumb for return. Persisted `frameRef` and `nodeRef` entries render as selectable, draggable World nodes whose source labels and missing states come from the validated batch reference resolver.

A subsequent increment adds a one-way camera push: before navigation, the World viewport animates the Portal bounds toward full-screen, then the existing route save blocker drains pending writes and performs the normal canvas switch. Returning restores the World viewport without requiring a reverse animation in that increment.

Automatic zoom-through is deferred until the application can preload or concurrently stage both scopes. The current single `canvasStore`, route mismatch loading screen, and save blocker cannot deliver a genuinely continuous gesture-driven transition without threshold/hysteresis, cancellation, failure recovery, and a dedicated transition layer.

The transition remains a navigation affordance, not evidence that World and project Spaces share one coordinate plane.

### Undo across navigation

The web history manager is registered by canvas ID, so World/Space transitions retain the independent scope being left while an authoritative reload of the already-active Canvas clears only that Canvas's stale history.

Each scope retains an independent undo and redo stack:

- Portal geometry, reference movement and locking, and World edge changes enter the World history through ordinary Canvas snapshots.
- First-version Pin and Unpin do not enter undo history. Any actual `frameRef` or `nodeRef` membership, type, or parentage change clears the World history manager whether active or inactive because its snapshots may retain protected identities that no longer exist.
- Source-node authored edits enter the source Space history after that Space is active.
- Switching scope saves the current manager and restores the destination manager.
- Cmd/Ctrl+Z and redo affect only the active scope.
- No global ordering or atomic undo is defined across Canvas boundaries.

When Pin or Unpin is invoked while a source Space remains active, the server-authoritative World mutation does not enter or clear that Space's undo stack. Cmd/Ctrl+Z continues to affect only the active Space. The UI reports the result and updates derived pin indicators; restoring the desired state uses the inverse Pin/Unpin operation rather than pretending to restore an exact World snapshot. General multi-client history ordering and exact protected-node deletion restore are separate Canvas-history concerns outside this proposal.

The same rule applies to source-Space agent invocation in the first version. Routed Portal Pin changes remain visible in the `space_commands` result but do not create source-scoped generic change-review records, because preview, staleness, and revert would otherwise be evaluated against the wrong Canvas.

## 8. Agent model

The World supports two conversation presentations with distinct ownership.

```text
World canvas conversation
  → UI, history, context, tools, and writes are World-owned
  → reuse existing query/read operations against a validated targetCanvasId

World nodeRef shortcut to a source agent node
  → UI anchor is the World nodeRef
  → conversation owner is source { canvasId, nodeId, threadId }
  → source tools and commands execute headlessly without rendering the Space
```

A normal World conversation treats the World as an ordinary Huabu Canvas whose additional node types are `canvasRef`, `frameRef`, and `nodeRef`. Its existing outline, inspection, filesystem, and command tools remain implicitly World-scoped by default.

For cross-Space reads, `canvasRef.targetCanvasId` provides the explicit target address and the existing query/read plane is reused rather than wrapped in a new public `PortalQuery` protocol. Read-only tools may accept an optional target Canvas when their conversation owner is World; the server verifies that the target is referenced by a canonical `canvasRef` in that World. RFS callers that already hold the target Canvas ID continue to use the existing `/api/rfs/:canvasId/query` and download surfaces directly. This permission does not extend ordinary World `space_commands` into arbitrary source writes.

When a `nodeRef` targets a source agent/question node, opening it keeps the user visually in the World while presenting that source-owned conversation. Every valid source agent node owns a thread from creation. An idle source agent node whose thread has no messages is therefore immediately eligible: the user may compose and send its first turn from the World, with the prompt, binding, mode, and lifecycle persisted to the source node exactly as they would be from the source Space. The `nodeRef` never creates a thread and does not copy `threadId`, agent binding, mode, status, viewed state, error, or messages. The resolver supplies those fields as non-persistent target data, and backend agent requests use the source canvas and source node as the conversation and neighbourhood scope. A resolved agent node without a thread is surfaced as an integrity error.

The UI represents this as a dual-owned view:

```typescript
interface AgentConversationView {
  presentationAnchor: {
    canvasId: string; // World
    nodeId: string; // nodeRef
  };
  conversationOwner: {
    canvasId: string; // source Space
    nodeId: string; // source agent/question node
    threadId: string;
  };
}
```

This is a headless conversation mode, not a second conversation. RFS, `executeSpaceQuery()`, `executeOnServer()`, the agent route's explicit `canvasId` and `anchorNodeId`, and request-scoped tool binding already establish that source data and commands do not require an open React Flow view.

All durable conversation truth is server-owned. Thread history and active runs remain in the server agent runtime; lifecycle fields remain on the source agent node and are written through the source Canvas server executor when a headless turn starts or finishes. World UI may show temporary pending feedback, but it cannot persist or author source status through the active World `canvasStore`.

Resolved `nodeRef` display data is refreshed from the server on World load, shortcut open, window focus, headless turn start/end, and Pin/Unpin completion. The first version does not add cross-canvas realtime invalidation because current Canvas SSE covers only `executeOnServer()` and revert paths, not every structure PUT, node-content PUT, preprocessing write, or external-file mutation.

World selection is not passed into a source-owned conversation because World node IDs are not source Space node IDs. The source agent node is the anchor, and the first version sends an empty `selectedNodes` list because no additional mapping exists.

A headless shortcut preserves the existing source conversation mode, including Operate. Source commands execute and persist normally, their tool results remain visible in the World conversation, and their review records remain stored with the source Canvas. To minimize first-version changes, World does not attempt to preview or revert source deltas against an unloaded Canvas; it presents an Open Space action, and the existing full Change Review becomes available after entering the source Space.

### Headless conversation as a foundation

Headless conversation is implemented as a reusable ownership indirection rather than a `nodeRef`-specific exception. A source-owned thread can receive its first or a subsequent turn while continuing to own its Canvas scope, anchor node, tools, lifecycle, and mutations without requiring that Canvas to be the currently rendered React Flow surface.

The first World use case presents one source-owned conversation through a World `nodeRef`. Multiple such conversations may run concurrently while the user remains in the World, but this is not a new World-specific task model: ordinary Canvas agent nodes already use independent threads, per-thread turn leases, and per-canvas write mutexes. World only changes where those existing conversations are presented.

Any future global limits, prioritization, or provider resource policy belong to the generic agent runtime/Agenetes layer and apply equally to ordinary Canvas and headless conversations. They are not part of the World Canvas domain.

### User case: concurrent work in two project Spaces

Assume the World contains canonical Portals for Project A and Project B. Each Portal contains a pinned `nodeRef` targeting a valid source Agent Node. Each source Agent Node owns its thread from creation; either thread may be idle with no messages or may already contain conversation history.

1. The user opens Agent Node A through its World `nodeRef`. The World remains the rendered Canvas, the ordinary single ChatPanel presents A's source-owned thread, and no conversation state is copied into the `nodeRef`.
2. The user sends an Operate turn. The request uses A's source `{ canvasId, nodeId, threadId }`; context, tools, lifecycle writes, authored mutations, history, and Change Review remain owned by Project A.
3. While A is running, the user opens Agent Node B through its `nodeRef`. ChatPanel focus switches to B exactly as it switches between two Agent Nodes in an ordinary Canvas. A continues running because changing selection or foreground conversation does not stop a thread.
4. The user sends a turn to B. A and B run concurrently under the existing agent runtime. Their different threads have independent turn leases, and their different source Canvases have independent executor mutexes. World adds no scheduler or queue.
5. Each `nodeRef` renders the corresponding source Agent Node's resolved lifecycle and conversation affordances. Opening A or B switches the same ChatPanel between their source-owned threads. Permission requests, explicit Stop, errors, unread state, and other conversation behavior follow the ordinary Agent Node model.
6. Navigating from World into a Space or refreshing the page does not stop either run. The server continues the runs; reconnect and persisted history restore conversation presentation when the relevant thread is opened again. Only an explicit Stop cancels a run.
7. Completion or failure in A does not alter B. Source commands and Change Review remain in their respective Spaces. The World changes only if an operation explicitly mutates World-owned state such as Pin, Portal geometry, `nodeRef` geometry, or World edges.

This flow adds only the cross-Canvas indirection between the World presentation anchor and each source conversation owner. Every other interaction and concurrency rule is inherited from ordinary Canvas Agent Nodes.

## 9. Implementation details

No product or architecture decision remains blocking for the shipped first version.

Implementation-level choices such as exact zod schema names, batch/output limits, initial-layout spacing constants, resolved-cache representation, UI copy, and the concrete settings key should be decided alongside their owning modules and tests without changing the contracts above.

## 10. Shipped implementation sequence

The first version shipped in this sequence:

1. Create and discover one hidden `.world/space.json` per workspace while routing it through the existing `CanvasStore`.
2. Extract the agreed minimum Container protocol and separate Frame-only policy.
3. Reconcile one canonical `canvasRef` per live Space, assign initial positions only to new Portals, and add explicit enter/return navigation.
4. Add `frameRef` / `nodeRef` plus the shared, idempotent `SET_PORTAL_NODE_PINS` command used by UI and agents, including recursive source Frame snapshots.
5. Add deterministic Portal-local placement and broken-reference rendering.
6. Add validated target-Canvas addressing to the existing World read/query tools and reference resolver.
7. Add headless source-agent conversation presentation through agent-node `nodeRef` shortcuts.

## 11. Non-goals for the initial exploration

- Merging all project nodes into one persistence file.
- Sharing one coordinate system between the World and every Space.
- Loading every Space into agent context or the browser at once.
- Enabling arbitrary recursive canvas nesting.
- Automatically pinning nodes based on recency, activity, unresolved status, or agent choice.
- Automatically mirroring source-Space edges into the World.
- Introducing cross-canvas atomic transactions without a demonstrated requirement.
- Allowing agents to assign unrestricted World coordinates.

## 12. Architecture areas affected

If this proposal advances, implementation will require coordinated changes across canvas discovery and storage, routing and navigation, node rendering, command addressing, realtime sync, agent context, and reference validity.

The authoritative current-system documents remain:

- [Canvas storage](../architecture/canvas-storage.md)
- [Canvas command architecture](../architecture/canvas-command-architecture.md)
- [Canvas zoom rendering](../architecture/canvas-zoom-rendering.md)
- [Canvas realtime sync](../architecture/canvas-realtime-sync.md)
- [Agent context](../architecture/agent-context.md)
- [Web architecture](../architecture/web-architecture.md)

The shipped implementation is folded into the architecture documents above; this proposal remains the design record for issue #346.
