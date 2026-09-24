# Node Auto Height

> Authoritative model for who owns a node's height, how a content height is measured, and how a derived height reaches geometry.
> Last updated: 2026-09-20

## 1. Scope and the invariant

A node's layout height is what every geometry consumer reads: frame fitting, the grid solver, snapping, edge routing, selection bounds, and the headless engine. This document covers how a `note` obtains that number when its height is content-driven.

The governing rule is that **rendering never causes a geometry change**. Zoom, pan, level-of-detail transitions, and virtualization mount/unmount leave [`getNodeSize`](../../packages/shared/src/canvas-engine/utils/nodeSizes.ts) output untouched. The store holds the height and the DOM consumes it; a measurement is a _proposal_, never a size.

`style.height` is therefore always a number for a `note`, including before the node has ever rendered.

## 2. The three heights

| Concept              | Definition                                                                                                        | Where it lives                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Intrinsic height** | Note content height at its actual inner width in canvas units, including host padding but excluding shell chrome. | `data.autoHeight.intrinsicHeight` — persisted measurement. |
| **Layout height**    | The number every geometry consumer uses.                                                                          | `style.height` — materialized from the intrinsic height.   |
| **Rendered height**  | The DOM's actual box.                                                                                             | `measured.height`, a mirror; and the source of a proposal. |

Intrinsic → layout is one pure function, [`intrinsicToLayoutHeight`](../../packages/shared/src/canvas-engine/height/compute.ts): clamp Note content to its 50px minimum, add the 6px shell chrome, and round upward to a 4px step. Note has no reference-width scale: fonts and all four 16px host insets stay fixed in canvas units when width changes. Canvas viewport zoom still scales the entire document naturally.

[`autoHeightContentWidth`](../../packages/shared/src/canvas-engine/height/compute.ts) resolves the measurement host width from finite authored `style.width`, then the measured-width fallback, then the type's creation default, subtracting the 6px shell inset and bounding the result to at least 1px. This width includes host padding. Authored width wins over a lagging DOM mirror. Resizing changes wrapping, not font size, so a measurement from another width is stale. PDF/Web overview spacing retains its independent 400px reference scale through `nodeCardContentScale`, but its typography is fixed in canvas units. Office uses an untransformed actual-size body with fixed typography as well. Those rendering policies do not determine Note geometry.

## 3. Ownership

`data.heightMode` records who owns `style.height`. It is authored state: toggling it is a user intent, it participates in the structure diff, and it is undoable.

[`getHeightPolicy`](../../packages/shared/src/canvas-engine/height/policy.ts) decides whether the field is even consulted:

| `kind`       | Types                              | Ownership                                                                                                                                                                                                     |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`    | `text`, `question`, `spacePreview` | Always the renderer. Text/Question use [`useTextAutoSize`](../../apps/web/src/hooks/useTextAutoSize.ts); Space Shortcut uses intrinsic title and metadata layout. Not governed by the Note measurement model. |
| `toggleable` | `note`                             | `data.heightMode`; the only type whose owner changes at runtime.                                                                                                                                              |
| `manual`     | everything else                    | Always the user.                                                                                                                                                                                              |

[`resolveHeightMode`](../../packages/shared/src/canvas-engine/height/policy.ts) is the single judgement; no consumer re-derives it. Nodes predating the field fall back to the legacy encoding — "auto is the absence of a height" — which is consulted once and then written out explicitly by creation or load normalization. The fallback deliberately does **not** read the measurement hint: a pinned note can carry one too.

A resize gesture on an auto note pins it to `fixed`. That flip is implicit, so the toolbar's auto indicator reflects it at gesture end.

The `fixed → auto` flip is reachable **only** from the node toolbar (and the multi-select toolbar). A sole-selected, full-LOD fixed Note permits native vertical wheel/trackpad scrolling without changing height mode or node geometry. Other Notes leave wheel input canvas-owned. There is no truncation footer or `Show more` button; the existing toolbar opens the expanded preview. A noninteractive bottom fade indicates content remaining below the viewport. The natural padded measurement host sits inside a separate fixed-capacity scroll viewport, both in actual-width canvas coordinates. Truncation and the auto-height invariant compare intrinsic content against that viewport, never against the growing document host, and scroll offsets do not affect intrinsic measurements.

## 4. Freshness

A stored height is meaningless without proof of what it measured. `data.autoHeight.measuredFor` carries an [`AutoHeightKey`](../../packages/shared/src/canvas-engine/height/freshness.ts): `` `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content, src })}:${autoHeightContentWidth(node)}` ``. The key remains one opaque string; no wire-schema migration is required.

- **Content revision** proves the height still describes the node's content. Without it, a note rewritten by an agent while offscreen would keep a silently wrong height.
- **`HEIGHT_LAYOUT_VERSION`** is bumped whenever a change alters the rendered height of unchanged content — typography, note padding, the measurement rule itself. Hints live in user workspaces and cannot be cleared retroactively; one integer buys global invalidation.

The actual inner width is part of the key because it determines wrapping. Width changes invalidate current hints and in-flight proposals even when Markdown is unchanged; height, position, selection, and viewport zoom do not. Version 11 invalidates the former reference-scaled measurements. Version 12 also invalidates persisted offscreen measurements made without the shared typography custom properties: those incorrect heights could otherwise remain current under version 11. Type conversion still drops the hint outright.

[`readAutoHeightHint`](../../packages/shared/src/canvas-engine/height/freshness.ts) returns `current | stale | missing`. Current hints materialize normally. Stale or missing hints preserve an existing positive finite `style.height` as a temporary footprint without claiming freshness; if no numeric seed exists, materialization uses a stored intrinsic value or the policy minimum. Width-only auto geometry edits preserve that seed until a new measurement commits, rather than scaling the old height or collapsing the Note.

**Freshness is never fabricated.** A hint may only claim a key that a measurement produced it under. No path synthesizes one — which is why the legacy `data.measuredHeight` was retired rather than carried forward.

## 5. Two commands, split by authorship

| Change                        | Frequency | Authored | Undoable | Command                      |
| ----------------------------- | --------- | -------- | -------- | ---------------------------- |
| User drags a note to a height | low       | yes      | yes      | `SET_NODE_GEOMETRY` number   |
| User switches a note to auto  | low       | yes      | yes      | `SET_NODE_GEOMETRY` `'auto'` |
| Content changed, re-measured  | high      | no       | no       | `APPLY_MEASURED_HEIGHT`      |

[`SET_NODE_GEOMETRY`](../../packages/shared/src/canvas-engine/commands/setNodeGeometry.ts) accepts `height: 'auto'`, the explicit spelling of renderer ownership. It records `heightMode` and materializes a concrete number immediately, so the node never passes through an undefined height. `'auto'` is the only height intent an agent can express; the zod schema in [`space-operations.ts`](../../packages/shared/src/types/api/space-operations.ts) widens with it.

[`APPLY_MEASURED_HEIGHT`](../../packages/shared/src/canvas-engine/commands/applyMeasuredHeight.ts) carries the derived correction. It is `snapshot: 'no'`, so a measurement never creates an undo entry; it writes the hint and the geometry together so provenance and geometry cannot disagree; it ignores nodes the user has since pinned; and it declares `affectedFrameIds` rather than fitting frames itself, so a bulk commit produces one refit. It is excluded from the agent schema — only a renderer can produce its input — and it reuses node references for unchanged items, because it runs far more often than any authored command.

## 6. Measurement

Two paths produce an intrinsic height, and both go through the same box and the same reader ([`noteContentHost.ts`](../../apps/web/src/components/Nodes/note/noteContentHost.ts)) so they cannot silently disagree.

**In place** — a mounted Note observes its natural content host, editor subtree, and separate viewport. Its effect captures the current content-and-width key, ignores callbacks when the live key has changed, and waits until the host's unscaled `clientWidth` matches the expected inner width within half a pixel (integer DOM rounding). It never measures a placeholder without `.ProseMirror`. Measurement requires mounting and hydration, which [`onlyRenderVisibleElements`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx) and the minimal-LOD hydration gate both deny.

Fixed-height Notes skip the mounted measurement-key calculation and detach measurement observers while their document is hidden by minimal LOD, including when an already-hydrated editor remains mounted. Returning to overview or reading, or switching to auto height, restores the normal key calculation and measurement effect. Overview and reading still measure fixed Notes for truncation; auto Notes retain their existing measurement policy. This gate does not change stored geometry, persist a hint, or introduce a loading cache.

**Offscreen** — one hidden Milkdown instance reused as a measuring tape ([`offscreenMeasurer.ts`](../../apps/web/src/components/Nodes/shared/height/measure/offscreenMeasurer.ts)). Requests capture Markdown, inner width, and canvas ID; the serialized measurer sets each request's host width before replacing Markdown and sampling height. Host construction applies `NOTE_CONTENT_HOST_STYLE` once, using `style.setProperty` with string values for every `--` custom property because JavaScript property assignment does not register CSS variables. One editor build amortized across queued Notes keeps measurement affordable and guarantees a single CSS context. The host is positioned off-screen with `visibility: hidden` — `display: none` would measure zero.

Both resolve under a bounded protocol ([`stability.ts`](../../apps/web/src/components/Nodes/shared/height/measure/stability.ts)): wait for fonts, accept a value only once two consecutive samples agree, resolve _provisionally_ rather than waiting on an undecoded image, and always meet a deadline. A queue that cannot drain is worse than a wrong number. A provisional hint reads as `stale` on the next load, so it is never trusted indefinitely.

An offscreen editor build or measurement failure emits a `[height] offscreen note measurement failed; retrying` console warning with the node id, measurement key, attempt number, retry delay, and original error, then retries with capped exponential backoff. The singleton host clears a rejected build promise before the retry, so one transient chunk-load or Milkdown mount failure cannot strand every later agent-created note at the policy minimum for the rest of the app session. A successful measurement is not considered complete until the live node carries its current hint; if a proposal is silently dropped before that write, prewarming uses the same backoff path instead of suppressing that node for the rest of the session. The confirmation window starts only after interaction suspension settles, so a legitimately held proposal is never reported or re-measured as a failure.

Measurement reads `.ProseMirror` rather than the host, whose `scrollHeight` Crepe's absolutely positioned block handle inflates. `.ProseMirror` is `display: flow-root` so a leading child's margin cannot collapse out of the box being measured.

## 7. Commit gating

Proposals go to a singleton queue ([`commitQueue.ts`](../../apps/web/src/components/Nodes/shared/height/commitQueue.ts)). It rejects missing nodes, fixed ownership, and content/width-stale keys **at flush time against the live store**, before these two gates. The shared executor repeats the freshness check, so load warmup and direct batched commands receive the same protection.

1. **No-op suppression.** Discard when the proposal resolves to the height the node already has _and_ the stored hint already carries the proposal's key. The comparison is exact, because quantization has already collapsed anything smaller than one step. The provenance half is not optional: content that changes without changing its height would otherwise leave the hint pointing at old content and be re-measured on every load forever.
2. **Interaction suspension.** Pan, zoom, node drag, and resize hold commits until they settle. Real interactions use named, idempotent holds, so duplicate start notifications cannot leak a counter. The normal end event releases its hold; `pointercancel`, window blur, document hiding, and Canvas unmount explicitly cancel named holds when React Flow cannot deliver an end event. No elapsed-time heuristic releases an active gesture, so a user may pause while holding the pointer without geometry changing underneath it. The hold state lives in its own dependency-free module ([`commitSuspension.ts`](../../apps/web/src/components/Nodes/shared/height/commitSuspension.ts)) because the gesture handlers live in `canvasStore` and the queue reads `canvasStore`.

Proposals are keyed by node, so a burst collapses to one command and therefore one end-of-batch frame refit.

## 8. Lifecycle

```text
create ─────────▶ heightMode + materialized minimum   (CREATE_NODES)
load ───────────▶ normalize → warm unmeasured → materialize
measure ────────▶ propose → gate → APPLY_MEASURED_HEIGHT → style.height
                                        │
                                   affectedFrameIds → one fitFrames pass
```

**Creation** records `heightMode` and materializes immediately, so the same batch's `fitFrames` and grid solver see a real footprint rather than zero.

**Load** runs [`normalizeNodeHeights`](../../apps/web/src/store/canvasStore/load/normalizeNodeHeights.ts) — write the inferred owner explicitly, then materialize — and then [`warmupNodeHeights`](../../apps/web/src/store/canvasStore/load/warmupNodeHeights.ts), which measures never-measured notes _before_ the canvas is shown, nearest to the restored viewport first, under a wall-clock budget. Warmup applies the completed measurements to the fetched snapshot through the pure canvas executor, so `APPLY_MEASURED_HEIGHT` performs the same freshness checks and parent Frame relayout as an interactive measurement without dispatching through the web store or creating load-time history. Normalization never writes a hint; a canvas saved before this model existed would otherwise paint a wall of collapsed cards and expand them one by one.

**Prewarming** ([`prewarmQueue.ts`](../../apps/web/src/components/Nodes/shared/height/measure/prewarmQueue.ts)) then measures the rest on idle, ordered by distance from the viewport with never-measured notes ahead of stale ones. Each candidate captures the actual inner width and content-and-width key before async work starts. A width-stale result is dropped and the new key is eligible for another attempt; the attempt cache cannot suppress remeasurement after resizing.

**Toggling to auto** measures offscreen first when no current hint exists, and lands the measurement and the geometry change in one executor batch. The on-demand path rejects results after content, width, canvas, or node identity availability changes. The store also abandons a pending toggle for a resized node, rather than replaying its captured old width; navigation cancels the pending batch. If measurement fails, the prior numeric height remains a stale seed. Fixed Notes do not submit mounted auto-height proposals.

## 9. Persistence

The hint and materialized height ride the ordinary structure save. Load recomputes geometry from current hints; stale hints retain the persisted numeric footprint only as a seed until measurement corrects it. No path rewrites an old key to make a seed appear fresh.

Derived geometry is **not yet isolated from the sync path** — see §11.

## 10. The invariant, and how it is checked

An auto note that does not fit its content is a defect report, not a cosmetic complaint: the box was derived from the measurement, so content that overflows means the two disagree. Truncation on a _pinned_ note is normal — the user chose a smaller box.

Two layers assert it. [`useAutoHeightInvariant`](../../apps/web/src/components/Nodes/note/useAutoHeightInvariant.ts) warns in dev only for a current measured hint when interaction commits are not suspended, re-reading the DOM after a delay rather than treating a stale seed awaiting correction as a defect. [`note-auto-height.spec.ts`](../../apps/web/e2e/note-auto-height.spec.ts) drives a real browser with fixtures chosen for the shapes that have broken it — a leading heading whose margin can escape the measured box, a heading mid-document whose margin cannot, wrapping prose, a list — and asserts both the geometry and that the dev hook stayed silent.

Unit tests cannot cover this class: the failures live in CSS layout, and happy-dom computes none.

## 11. Known limits

Text nodes use 8px horizontal and 3px vertical padding per side at the default 16px font size. Both insets scale proportionally with the font through the shared `nodeFontConfig` values used by rendering and measurement; Note and Question spacing are independent.

- **`text` / `question` are not on this model.** They size themselves synchronously through [`useTextAutoSize`](../../apps/web/src/hooks/useTextAutoSize.ts) and never write `style.height`, so `getNodeSize` returns `0` for one that has not rendered.
  Both opt into `fontSizing: 'proportional'`: a finite positive `data.style.fontSize` supplies the font, otherwise Text defaults to 16px and Question to `NODE_TYPOGRAPHY.cardTitle.size` (currently 28px). Measurement and rendering use the same effective padding: base padding multiplied by `fontSize / baseFontSize`, so the text width is `width - 2 × effectivePaddingX`. The shell border is absorbed by [`resolveTextBodyBox`](../../apps/web/src/components/Nodes/shared/TextNodeBody.tsx), so it never narrows measured text. Question's title, avatar, alias, status, gaps, and card padding share this scale. Width-only side gestures preserve the captured font and reflow height; aspect-locked corner gestures use `scale` mode, multiplying the starting font by the new/start outer-width ratio without best-fit measurement or rounding. Hug Frame child scaling and multi-selection scaling use that same proportional rule for both types, including descendants in a selected Frame. Height remains content-driven in every mode. Existing Question font values are respected; neither type's proportional policy performs an automatic persisted-data migration or derives a font from legacy height. See [canvas-input-interactions.md](./canvas-input-interactions.md#3-direct-manipulation) for resize ownership. Guarded by [`TextNodeBody.test.tsx`](../../apps/web/src/components/Nodes/shared/TextNodeBody.test.tsx), [`fontFit.test.ts`](../../apps/web/src/utils/node/__tests__/fontFit.test.ts), and [`useTextAutoSize.test.tsx`](../../apps/web/src/hooks/useTextAutoSize.test.tsx).
- **Mixed selections are not strict whole-scene scaling.** Text/Question or media force uniform group geometry, but Note typography and padding stay fixed in canvas units. A resized Note container reflows or scrolls its document under its existing height policy; it does not scale the document font with the group. Direct Manual Frame resize still changes only the Frame box, not its children.
- **No sync isolation.** A derived height currently bumps `canvas.version` and broadcasts like any other structural write. [`node-height-ownership-model.md`](../proposals/node-height-ownership-model.md) §D9 specifies the value-aware structure diff, the per-batch derived marker, and the dedicated write channel that close this; they are a prerequisite for multi-user co-editing on canvases containing auto notes.
- **Late-decoding media.** A note whose image has not decoded cannot reach its final height; it commits provisionally and re-measures on the next load.
- **Hug frame geometry** is stored as authored geometry but is in practice derived from its children. See [derived-frame-geometry.md](../backlog/derived-frame-geometry.md).

## Frame Measurement Notifications

Frame dimensions remain engine-owned: idle React Flow measurements normalize to numeric authored `style.width` and `style.height`, including fractional values. When both measured dimensions already equal those authored values, `onNodesChange` discards the idle Frame notification before allocating or broadcasting a new nodes array. Browser integer rounding and intermediate CSS-transition measurements therefore cannot repeatedly invalidate the canvas and Layers tree during viewport navigation. Explicit resize-state notifications, active snap sessions, initial measurements, and non-Frame measurements retain their existing processing.

## Code entry points

| File                                                                                                                          | Responsibility                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`height/policy.ts`](../../packages/shared/src/canvas-engine/height/policy.ts)                                                | Per-type policy, node shell inset, `resolveHeightMode` — the only ownership judgement.                   |
| [`height/compute.ts`](../../packages/shared/src/canvas-engine/height/compute.ts)                                              | `autoHeightContentWidth`, manual content scaling, intrinsic-to-layout conversion, quantization.          |
| [`height/freshness.ts`](../../packages/shared/src/canvas-engine/height/freshness.ts)                                          | `AutoHeightKey`, `HEIGHT_LAYOUT_VERSION`, `readAutoHeightHint`.                                          |
| [`height/materialize.ts`](../../packages/shared/src/canvas-engine/height/materialize.ts)                                      | Hint → `style.height`; shared by web load and headless hydration.                                        |
| [`commands/setNodeGeometry.ts`](../../packages/shared/src/canvas-engine/commands/setNodeGeometry.ts)                          | Authored geometry; the `'auto'` branch.                                                                  |
| [`commands/applyMeasuredHeight.ts`](../../packages/shared/src/canvas-engine/commands/applyMeasuredHeight.ts)                  | Derived correction; non-undoable; collects frame ancestors.                                              |
| [`commands/changeNodeType.ts`](../../packages/shared/src/canvas-engine/commands/changeNodeType.ts)                            | Drops the hint on conversion and records the target type's ownership.                                    |
| [`note/noteContentHost.ts`](../../apps/web/src/components/Nodes/note/noteContentHost.ts)                                      | The box and the reader shared by the mounted note and the offscreen measurer.                            |
| [`note/NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx)                                                  | Renders from `style.height`; reports an intrinsic height; never sizes itself.                            |
| [`note/heightMemory.ts`](../../apps/web/src/components/Nodes/note/heightMemory.ts)                                            | Session-scoped remembered pinned height; gated on ownership, not on numericness.                         |
| [`shared/height/commitQueue.ts`](../../apps/web/src/components/Nodes/shared/height/commitQueue.ts)                            | No-op suppression, coalescing, flush-time validation.                                                    |
| [`shared/height/commitSuspension.ts`](../../apps/web/src/components/Nodes/shared/height/commitSuspension.ts)                  | Named interaction holds with explicit cancellation; kept dependency-free to stay acyclic with the store. |
| [`shared/height/measure/`](../../apps/web/src/components/Nodes/shared/height/measure/offscreenMeasurer.ts)                    | Offscreen singleton measurer, stability protocol, viewport-priority prewarm queue.                       |
| [`canvasStore/load/normalizeNodeHeights.ts`](../../apps/web/src/store/canvasStore/load/normalizeNodeHeights.ts)               | Load-time ownership normalization and materialization.                                                   |
| [`canvasStore/load/warmupNodeHeights.ts`](../../apps/web/src/store/canvasStore/load/warmupNodeHeights.ts)                     | Bounded pre-paint measurement of never-measured notes.                                                   |
| [`canvasStore/height/measureMissingAutoHeights.ts`](../../apps/web/src/store/canvasStore/height/measureMissingAutoHeights.ts) | On-demand measurement behind a fixed → auto toggle.                                                      |
| [`hooks/useNodeScale.ts`](../../apps/web/src/hooks/useNodeScale.ts)                                                           | Content scale; delegates to `contentScaleFor` so one formula exists.                                     |
