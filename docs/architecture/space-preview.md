# Space Preview and World

> Authoritative contract for view-only Space projection nodes and the preview-based World.
> Last updated: 2026-09-14

## 1. Product model

A `spacePreview` is a normal Canvas node whose persisted data contains only `{ type: 'spacePreview', targetCanvasId }`. It displays the spatial structure of one ordinary Space without mounting that Space's React Flow tree, node components, editors, media, links, Agents, Interactive Views, or mutation paths.

Space previews do not participate in node preprocessing. The web queue excludes them before scheduling and ingestion-state updates, including edit-settle and unload keepalive paths; moving or resizing a preview therefore does not send a preprocessing POST. Scene fetching remains independent of ingestion.

World is a server-managed Canvas containing exactly one `spacePreview` for every ordinary Space in the active workspace, alongside any ordinary World-owned nodes and edges. `reconcileWorldPreviews()` owns preview membership and target identity while preserving existing preview IDs, position, size, and presentation data. Missing previews receive fresh IDs and deterministic open-grid placement; deleted targets lose their managed preview. Duplicate targets or malformed managed identities are integrity errors. Reconciliation never reuses legacy Portal IDs or geometry.

If a reconciliation command reports that it was not applied, reconciliation re-reads World and membership once. It succeeds only if that fresh plan requires no changes for the same World, allowing a concurrent writer to have already completed a stale-preview deletion. Outstanding work, malformed identities, and executor exceptions remain errors; this does not add automatic retries or a transaction spanning planning and execution.

Legacy `canvasRef`, `frameRef`, and `nodeRef` nodes, Portal/Pin renderers, the `SET_PORTAL_NODE_PINS` command, and `GET /api/canvas/:canvasId/references` are retired, not compatibility APIs. The shared `stripLegacyPortalTopology()` helper ignores those three exact node types and their incident edges at read/load, clipboard, and history-restore boundaries. Ordinary children survive: a child directly parented by an ignored node is detached to the root with its position rebased through the original ancestor chain. This is an in-memory projection with no disk cleanup, sidecar deletion, or legacy-to-preview migration; normal later saves may omit ignored topology. See [canvas-storage.md](./canvas-storage.md) for the storage boundary.

Only system reconciliation creates managed World previews. UI and Agent mutations cannot repoint them, change their type, or delete them while their target remains a live Space, including through ancestor deletion or a reparent-then-delete batch. Missing-target previews remain removable. Users may move, resize, and parent previews under ordinary Frames; a preview is not itself a Container and owns no source-node children.

Write boundaries use the canonical registries, not a retired-type blacklist: every command discriminator must be an own entry in the shared engine's full `COMMAND_META` registry, including UI-only commands. Before persistence, command results, delta replay (including revert), and full-state PUT validate explicitly supplied node `type` and optional `data.type` against `CANVAS_NODE_TYPES`; omitted discriminators remain accepted by the loose full-state contract. Unsupported explicit types are rejected on writes, whereas `stripLegacyPortalTopology()` still preserves unrelated unknown node types on reads/imports rather than silently stripping them. Agent media normalization checks all create-node discriminators before importing bytes; other command payloads retain normal handler rejection/no-op behavior and final topology validation.

World-owned conversations may use `spacePreview.targetCanvasId` from the World outline for explicit read-only tool access. The server requires exactly one matching canonical preview and a readable live ordinary target Space. This does not grant cross-Space writes or source conversation presentation: opening a source Question requires entering its Space, not interacting with the projected scene.

## 2. Scene projection boundary

`GET /api/canvas/:canvasId/preview-scene` accepts only an ordinary Space in the active workspace. The server reads the target through the storage ports — `space(canvasId).read()` for topology, `nodes.list()` for node records — and converts the result into the shared zod contract in `packages/shared/src/types/api/space-preview.ts`. Missing targets return `404`; a target whose Space record cannot be produced, or whose topology is not the expected shape, returns `422`. Node records are read the one lenient way the port defines: a record that cannot be produced is omitted and the projection falls back to topology data, and a record broken by hand recovers the same way it does when its own Space is opened. A single damaged sidecar therefore renders leniently rather than failing the whole preview, which is the behaviour of the Space's own view.

The response contains identity, title, Canvas version, absolute node geometry, safe visual kinds, whitespace-normalized labels, bounded plain-text excerpts for Note and Text nodes, bounded Image source references, eligible edges, scene bounds, and explicit truncation flags. Markdown is flattened before projection; inline `data:` and renderer-local `blob:` image sources are excluded. The response never includes complete rich-editor state, prompts, chat and Agent state, Interactive View state, artifact bytes, handles, selection, or mutation metadata.

Projection keeps deterministic source order and is bounded to 250 nodes, 400 edges, and 1 MiB serialized JSON. Source `spacePreview` nodes become inert `nested-preview` placeholders, so projection has exactly one live scene depth and cannot recurse through self-reference or cycles. Retired Portal/Pin topology is already excluded by the composed Space read.

## 3. Web rendering and freshness

The web renderer draws bounded scene geometry, clipped Image thumbnails, and overflow-clamped plain-text Note and Text excerpts through static SVG and `foreignObject` content. Preview text and labels use bounded screen-space typography: local zoom is fully counter-scaled while host Canvas zoom-out compensation is capped at 3×, keeping text readable without letting it overwhelm a deeply zoomed-out node. The preview header title applies the same bounded host zoom-out principle. These visual elements inherit `pointer-events: none`; they never mount the source node component or become an independent interaction target. Cache entries are keyed by target Canvas, share in-flight requests across duplicate previews, remain fresh for ten seconds, revalidate on focus and while a preview is near the browser viewport, and keep the last successful scene with a stale indicator after transient refresh failure. One tab admits at most two target requests concurrently.

An `IntersectionObserver` with a 300 px margin suspends fetch timers and the SVG viewport for distant previews. This makes World the scale acceptance surface without giving each offscreen Space an active renderer or poller.

Preview-local viewport state is versioned local UI data keyed by host `{ canvasId, previewNodeId }`. Pan and zoom therefore dirty neither the host nor target Canvas and are not synchronized across devices.

## 4. Interaction and accessibility

The scene viewport carries React Flow's `nodrag`, `nopan`, and `nowheel` classes and owns a capture-phase non-passive wheel listener. Pointer capture keeps local pan inside the preview; native wheel propagation is stopped before host React Flow handlers. The outer node chrome remains responsible for host-node selection and movement.

The viewport is one labelled keyboard focus stop. Arrow keys pan, `+` and `-` zoom, `0` resets, and Escape releases viewport focus. The SVG scene is `aria-hidden`; title, freshness and failure status, retry, zoom controls, and the explicit Open Space action remain accessible controls.

Explicit Open Space navigation is the only Phase 1 entry transition. Gesture-driven zoom-through remains deferred; responsive layout or preview resize never navigates.

Ordinary Spaces expose Add Space Preview from the Canvas toolbar's Add Content dropdown. World omits this action because its preview membership is server-managed.

Moving content between Spaces can also create an ordinary source-owned `spacePreview` breadcrumb when the default-enabled Move option remains selected. It occupies the moved set's former absolute top-left and derives its width and height from the authoritative deduplicated transfer bounds, clamped to `480 × 320` minimum and `2400 × 1600` maximum. It is created in the same source executor batch that deletes the moved roots, and a later move to the same target creates another breadcrumb rather than reusing one at a different historical location. Disabling the option leaves no breadcrumb and does not change boundary-edge removal or compensation.

## Code entry points

| File                                                                                                                           | Responsibility                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [`packages/shared/src/types/canvas/node.ts`](../../packages/shared/src/types/canvas/node.ts)                                   | Canonical `spacePreview` node identity and data.                             |
| [`packages/shared/src/types/api/space-preview.ts`](../../packages/shared/src/types/api/space-preview.ts)                       | Scene wire schema and hard budgets.                                          |
| [`apps/server/src/modules/canvas/space-preview-scene.ts`](../../apps/server/src/modules/canvas/space-preview-scene.ts)         | Authorized, sanitized, bounded scene projection.                             |
| [`apps/server/src/modules/canvas/world-previews.ts`](../../apps/server/src/modules/canvas/world-previews.ts)                   | Canonical World preview reconciliation without legacy migration.             |
| [`apps/server/src/modules/canvas/world-preview-policy.ts`](../../apps/server/src/modules/canvas/world-preview-policy.ts)       | Managed World preview policy and canonical command/node registry validation. |
| [`apps/server/src/modules/canvas/world-target-access.ts`](../../apps/server/src/modules/canvas/world-target-access.ts)         | Preview-addressed read-only target authorization.                            |
| [`packages/shared/src/utils/strip-legacy-portal-topology.ts`](../../packages/shared/src/utils/strip-legacy-portal-topology.ts) | Pure legacy topology filtering and surviving-child coordinate rebase.        |
| [`apps/web/src/components/Nodes/spacePreview/`](../../apps/web/src/components/Nodes/spacePreview)                              | Preview shell, static viewport, interaction, and local persistence.          |
| [`apps/web/src/store/spacePreviewSceneCache.ts`](../../apps/web/src/store/spacePreviewSceneCache.ts)                           | Shared freshness cache, request deduplication, and concurrency admission.    |
