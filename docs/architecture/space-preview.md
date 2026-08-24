# Space Preview and World

> Authoritative contract for view-only Space projection nodes and the preview-based World.
> Last updated: 2026-08-20

## 1. Product model

A `spacePreview` is a normal Canvas node whose persisted data contains only `{ type: 'spacePreview', targetCanvasId }`. It displays the spatial structure of one ordinary Space without mounting that Space's React Flow tree, node components, editors, media, links, Agents, Interactive Views, or mutation paths.

World is a server-managed Canvas containing exactly one `spacePreview` for every ordinary Space in the active workspace. Reconciliation owns membership and target identity while preserving user-owned position and size. New Spaces receive deterministic open-grid placement, deleted targets lose their managed preview, and a legacy canonical `canvasRef` may donate its id and geometry during one-way reconciliation.

Legacy `canvasRef`, `frameRef`, `nodeRef`, and Pin data remain readable for compatibility, but World no longer creates Portals or exposes Pin controls.

## 2. Scene projection boundary

`GET /api/canvas/:canvasId/preview-scene` accepts only an ordinary Space in the active workspace. The server reads the target through the storage ports — `space(canvasId).read()` for topology, `nodes.list()` for node records — and converts the result into the shared zod contract in `packages/shared/src/types/api/space-preview.ts`. Missing targets return `404`; a target whose Space record cannot be produced, or whose topology is not the expected shape, returns `422`. Node records are read the one lenient way the port defines: a record that cannot be produced is omitted and the projection falls back to topology data, and a record broken by hand recovers the same way it does when its own Space is opened. A single damaged sidecar therefore renders leniently rather than failing the whole preview, which is the behaviour of the Space's own view.

The response contains identity, title, Canvas version, absolute node geometry, safe visual kinds, whitespace-normalized labels, bounded plain-text excerpts for Note and Text nodes, bounded Image source references, eligible edges, scene bounds, and explicit truncation flags. Markdown is flattened before projection; inline `data:` and renderer-local `blob:` image sources are excluded. The response never includes complete rich-editor state, prompts, chat and Agent state, Interactive View state, artifact bytes, handles, selection, or mutation metadata.

Projection keeps deterministic source order and is bounded to 250 nodes, 400 edges, and 1 MiB serialized JSON. `spacePreview` and `canvasRef` source nodes become inert `nested-preview` placeholders, so projection has exactly one live scene depth and cannot recurse through self-reference or cycles.

## 3. Web rendering and freshness

The web renderer draws bounded scene geometry, clipped Image thumbnails, and overflow-clamped plain-text Note and Text excerpts through static SVG and `foreignObject` content. Preview text and labels use bounded screen-space typography: local zoom is fully counter-scaled while host Canvas zoom-out compensation is capped at 3×, keeping text readable without letting it overwhelm a deeply zoomed-out node. The preview header title applies the same bounded host zoom-out principle. These visual elements inherit `pointer-events: none`; they never mount the source node component or become an independent interaction target. Cache entries are keyed by target Canvas, share in-flight requests across duplicate previews, remain fresh for ten seconds, revalidate on focus and while a preview is near the browser viewport, and keep the last successful scene with a stale indicator after transient refresh failure. One tab admits at most two target requests concurrently.

An `IntersectionObserver` with a 300 px margin suspends fetch timers and the SVG viewport for distant previews. This makes World the scale acceptance surface without giving each offscreen Space an active renderer or poller.

Preview-local viewport state is versioned local UI data keyed by host `{ canvasId, previewNodeId }`. Pan and zoom therefore dirty neither the host nor target Canvas and are not synchronized across devices.

## 4. Interaction and accessibility

The scene viewport carries React Flow's `nodrag`, `nopan`, and `nowheel` classes and owns a capture-phase non-passive wheel listener. Pointer capture keeps local pan inside the preview; native wheel propagation is stopped before host React Flow handlers. The outer node chrome remains responsible for host-node selection and movement.

The viewport is one labelled keyboard focus stop. Arrow keys pan, `+` and `-` zoom, `0` resets, and Escape releases viewport focus. The SVG scene is `aria-hidden`; title, freshness and failure status, retry, zoom controls, and the explicit Open Space action remain accessible controls.

Explicit Open Space navigation is the only Phase 1 entry transition. Gesture-driven zoom-through remains deferred; responsive layout or preview resize never navigates.

Ordinary Spaces expose Add Space Preview from the Canvas toolbar's Add Content dropdown. World omits this action because its preview membership is server-managed.

## Code entry points

| File                                                                                                                   | Responsibility                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`packages/shared/src/types/canvas/node.ts`](../../packages/shared/src/types/canvas/node.ts)                           | Canonical `spacePreview` node identity and data.                          |
| [`packages/shared/src/types/api/space-preview.ts`](../../packages/shared/src/types/api/space-preview.ts)               | Scene wire schema and hard budgets.                                       |
| [`apps/server/src/modules/canvas/space-preview-scene.ts`](../../apps/server/src/modules/canvas/space-preview-scene.ts) | Authorized, sanitized, bounded scene projection.                          |
| [`apps/server/src/modules/canvas/world-portals.ts`](../../apps/server/src/modules/canvas/world-portals.ts)             | World preview reconciliation and legacy Portal migration.                 |
| [`apps/server/src/modules/canvas/world-portal-policy.ts`](../../apps/server/src/modules/canvas/world-portal-policy.ts) | Managed World preview mutation policy.                                    |
| [`apps/web/src/components/Nodes/spacePreview/`](../../apps/web/src/components/Nodes/spacePreview)                      | Preview shell, static viewport, interaction, and local persistence.       |
| [`apps/web/src/store/spacePreviewSceneCache.ts`](../../apps/web/src/store/spacePreviewSceneCache.ts)                   | Shared freshness cache, request deduplication, and concurrency admission. |
