# Space Preview and World Redesign

> Add a bounded, view-only projection of one Space inside another and rebuild World as the managed collection of those projections.
>
> Status: **Shipped** · Last updated: 2026-08-18 · Tracks: [#109](https://github.com/microsoft/Huabu/issues/109)

---

## 1. Context

Huabu can reference another Space through the shipped World `canvasRef`, but that Portal renders only a title, an empty body, and an explicit navigation action. It does not communicate the target Space's visual structure and was an interim implementation rather than a user-established contract.

The application also assumes one active editable React Flow and one active Canvas store. Mounting a second ordinary Canvas inside a node would duplicate mutation surfaces, gesture routers, sync streams, media and Agent runtimes, and would let embedded content escape the intended view-only boundary.

Issue #109 introduces a separate primitive: a Space Preview is a bounded read projection with its own viewport, no target mutation authority, and an explicit Open Space action. The same primitive becomes the foundation of a redesigned World, making World the first scale and lifecycle acceptance surface rather than a separate Portal implementation.

## 2. Product model

### 2.1 Space Preview

A `spacePreview` is a Canvas node that references one ordinary Space by stable `canvasId`. It renders the target's spatial structure inside an isolated viewport and supports preview-local pan and continuous zoom.

The embedded scene is never an interactive target Canvas. Nodes, edges, links, editors, media controls, Agents, Question conversations, Web Nodes, and Interactive Views inside it cannot receive application input or execute behavior.

Every preview exposes the target title, freshness or failure state, viewport controls, and an explicit Open Space action.

### 2.2 Redesigned World

World is a managed Canvas containing exactly one system-owned `spacePreview` for every ordinary Space in the active workspace.

Membership and target identity are server-owned. Users own each preview's World position, size, and preview-local viewport. Reconciliation creates previews for new Spaces, removes previews for deleted Spaces, updates derived titles through the preview read model, and never rearranges existing user geometry.

World and an ordinary Canvas use the same persisted node type, preview-scene API, renderer, cache, interaction controller, loading states, recursion rule, and rendering budget. World adds no parallel Portal renderer or target projection protocol.

The legacy `canvasRef`, `frameRef`, `nodeRef`, Pin, and Portal implementation may remain readable for compatibility, but it no longer defines the World product model and new World reconciliation does not create those nodes.

## 3. Phase boundaries

### Phase 1: preview infrastructure and World

1. Persist `spacePreview` identity as `{ type: 'spacePreview', targetCanvasId }`.
2. Let users create a preview in an ordinary Canvas and choose another ordinary Space.
3. Serve a versioned, sanitized, bounded scene projection from the target Space.
4. Render the scene through a lightweight non-interactive renderer rather than nested React Flow or ordinary node components.
5. Isolate preview-local pointer, wheel, touch, and keyboard viewport input from the host Canvas.
6. Provide explicit loading, stale, unavailable, unauthorized, deleted, malformed, recursive, and budget-truncated states.
7. Rebuild World reconciliation around one `spacePreview` per ordinary Space.
8. Validate shared caching, concurrency limits, visibility gating, and rendering budgets with World as the scale acceptance surface.

### Phase 2: zoom-through navigation

Zoom-through is deferred until Phase 1 establishes reliable viewport isolation and explicit navigation.

A future gesture may arm only after a preview intentionally occupies most of the host viewport, its local viewport reaches the entry boundary, and the same inward gesture continues. Responsive layout or resize alone must never navigate. The transition needs an affordance, cancellation, reduced-motion behavior, browser-history semantics, preserved return viewport, and the explicit Open Space fallback.

## 4. Persisted model

```ts
interface SpacePreviewNodeData {
  type: 'spacePreview';
  targetCanvasId: string;
}
```

Target title, scene nodes, edges, source revisions, loading state, authorization state, and freshness metadata are derived read data and never copied into Canvas topology.

Preview-local viewport is presentation state rather than target content. It is stored by host `{ canvasId, previewNodeId }` in versioned local UI persistence so moving through the preview never dirties either Canvas document.

On World, canonical preview identity is server-owned. Ordinary users and Agents cannot create, repoint, or delete World-managed previews. Outside World, the ordinary UI may create, repoint, resize, move, or delete a `spacePreview`; Agents do not gain cross-Space preview creation in Phase 1.

## 5. Preview scene contract

The Server projects a target Space into one zod-defined wire contract under `packages/shared/src/types/api/`.

The response contains target identity, title, Canvas version, scene bounds, sanitized nodes, sanitized edges, truncation metadata, and a cache validator. Scene nodes contain only geometry, hierarchy, a safe visual kind, a plain-text label, and bounded presentation hints required by the static renderer.

The scene includes bounded plain-text excerpts for Note and Text nodes and bounded Image source references so the preview communicates authored content rather than only topology. Markdown is flattened and inline `data:` or renderer-local `blob:` image sources are omitted. It excludes complete rich-editor bodies, prompts, chat state, Agent state, Interactive View definitions and state, raw Web content, artifact bytes, executable behavior, selection, drag state, handles, and mutation metadata.

The initial hard limits are 250 scene nodes, 400 scene edges, and a 1 MiB serialized response. Projection preserves deterministic Canvas order and reports truncation instead of silently pretending the complete Space was rendered.

Authorization occurs before projection. The current single-owner product authorizes an authenticated owner only when the target is an ordinary Space in the active workspace. The projection service owns an explicit authorization seam so future Space-level ACLs do not require changing renderer behavior or the wire result vocabulary.

## 6. Freshness and caching

The first visible render fetches the scene. Duplicate previews of the same target share one in-flight request and one cache record.

A visible preview revalidates on window focus and after a ten-second freshness interval. A successful response replaces the cached scene atomically. A transient refresh failure keeps the last known scene with an explicit stale indicator; an initial failure has no success-shaped fallback.

At most two scene requests run concurrently per browser tab. Offscreen previews retain lightweight metadata and the last scene but do not own an active renderer or polling timer.

World is the performance acceptance surface: many previews must share target cache entries, respect the global request queue, and mount expensive scene content only near the visible host viewport.

## 7. Rendering and recursion

The renderer draws inert structural geometry, frames, labels, clipped Image thumbnails, bounded Note and Text excerpts, and edges through lightweight SVG and DOM. It does not mount `ReactFlow`, `NodeWrapper`, source node components, media viewers, editors, iframes, Agent UI, or target sync subscribers.

Preview rendering has one live scene depth. A source `spacePreview` or legacy `canvasRef` inside the projected target becomes a labelled nested-preview placeholder and never starts another scene request. This single-depth rule deterministically handles self-reference, `A → B → A`, and deeper cycles without carrying a recursive render stack.

The renderer applies preview-local semantic detail based on screen-space size. Labels and Note/Text excerpts use bounded screen-space typography: local zoom is fully counter-scaled and host zoom-out compensation is capped, preserving readability without allowing text to overwhelm deeply zoomed-out nodes. Minor edges may be omitted below bounded thresholds, but source geometry remains stable while zooming.

## 8. Interaction ownership

The preview viewport is one explicit nested interaction region. Pointer down inside that region may select or drag the host preview node only through its outer chrome; the scene viewport itself captures its own pan gesture.

Wheel and trackpad pinch inside the viewport update only preview-local zoom. The region consumes the native wheel event before React Flow's d3 handlers. Touch pointers are captured by the preview controller and never enter the host pointer router while the preview owns them.

The preview carries React Flow's `nodrag`, `nopan`, and `nowheel` exclusion classes, but native capture listeners remain authoritative because React synthetic propagation alone cannot beat every host-native gesture listener.

Keyboard focus enters one labelled viewport control. Arrow keys pan, `+` and `-` zoom, `0` resets, and Escape returns focus to the node shell. The static scene is `aria-hidden`; target identity, status, controls, and Open Space remain exposed through native accessible controls.

## 9. World reconciliation and compatibility

World reconciliation computes one desired `spacePreview` per ordinary Space. Existing matching previews retain id, geometry, size, lock state, and World-owned presentation data. Missing previews receive deterministic open-grid placement.

For compatibility, a legacy canonical `canvasRef` may donate its id-compatible geometry to the new preview for the same `targetCanvasId`. Legacy reference descendants are not projected into the new World model. The migration is idempotent and must not produce both a Portal and Preview for one Space.

No new `canvasRef`, `frameRef`, or `nodeRef` is created by World reconciliation after this change. Existing compatibility code and stored nodes may remain available for old files and focused migration tests.

## 10. Failure states

| State                  | Presentation                                                         |
| ---------------------- | -------------------------------------------------------------------- |
| Loading                | Stable preview shell and labelled progress state                     |
| Stale                  | Last successful scene plus visible stale status and retry            |
| Unauthorized           | No scene geometry; access-denied state and disabled Open action      |
| Deleted or unavailable | Missing-target state with retry or retarget affordance outside World |
| Malformed              | Explicit invalid-Space error; no partial unsafe projection           |
| Recursive              | Static nested-preview placeholder; no recursive request              |
| Truncated              | Render bounded scene plus an explicit partial-preview indicator      |

## 11. Validation

Shared tests cover node and scene schemas, deterministic limits, and serialized response shape.

Server tests cover authorization, ordinary target validation, sanitization, geometry and edge projection, malformed targets, limit reporting, World reconciliation, lifecycle add/delete/rename, geometry preservation, and legacy Portal compatibility.

Web tests cover target selection, cache de-duplication, stale revalidation, loading and error states, local viewport math, wheel/pointer isolation, no embedded activation, explicit navigation, keyboard controls, accessible naming, offscreen suspension, and World-scale request limits.

Phase 1 acceptance requires a World populated from multiple ordinary Spaces to render through the same component used by ordinary `spacePreview` nodes while preserving responsive host Canvas interaction.

## 12. Documentation impact

Shipping Phase 1 updates [Canvas storage](../architecture/canvas-storage.md), [Canvas input interactions](../architecture/canvas-input-interactions.md), [Canvas zoom rendering](../architecture/canvas-zoom-rendering.md), [Canvas realtime sync](../architecture/canvas-realtime-sync.md), and [Web architecture](../architecture/web-architecture.md), and adds a dedicated Space Preview architecture reference.

The shipped [World Canvas proposal](./world-canvas.md) remains historical design context. Current architecture documents become authoritative for the redesigned World.
