# Node Auto Height

> Authoritative model for who owns a node's height, how a content height is measured, and how a derived height reaches geometry.
> Last updated: 2026-07-28

## 1. Scope and the invariant

A node's layout height is what every geometry consumer reads: frame fitting, the grid solver, snapping, edge routing, selection bounds, and the headless engine. This document covers how a `note` obtains that number when its height is content-driven.

The governing rule is that **rendering never causes a geometry change**. Zoom, pan, level-of-detail transitions, and virtualization mount/unmount leave [`getNodeSize`](../../packages/shared/src/canvas-engine/utils/nodeSizes.ts) output untouched. The store holds the height and the DOM consumes it; a measurement is a _proposal_, never a size.

`style.height` is therefore always a number for a `note`, including before the node has ever rendered.

## 2. The three heights

| Concept              | Definition                                                              | Where it lives                                             |
| -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Intrinsic height** | Content height at the node type's reference width, unscaled, no chrome. | `data.autoHeight.intrinsicHeight` — the persisted truth.   |
| **Layout height**    | The number every geometry consumer uses.                                | `style.height` — materialized from the intrinsic height.   |
| **Rendered height**  | The DOM's actual box.                                                   | `measured.height`, a mirror; and the source of a proposal. |

Intrinsic → layout is one pure function, [`intrinsicToLayoutHeight`](../../packages/shared/src/canvas-engine/height/compute.ts): clamp to the type's minimum, scale by the node's width, add the node shell's chrome, quantize to a 4 px step. The order mirrors the DOM — the minimum applies unscaled, the chrome is outside the scaled container and so is added after.

## 3. Ownership

`data.heightMode` records who owns `style.height`. It is authored state: toggling it is a user intent, it participates in the structure diff, and it is undoable.

[`getHeightPolicy`](../../packages/shared/src/canvas-engine/height/policy.ts) decides whether the field is even consulted:

| `kind`       | Types              | Ownership                                                                                                          |
| ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `content`    | `text`, `question` | Always the renderer. Sized by [`useTextAutoSize`](../../apps/web/src/hooks/useTextAutoSize.ts), not by this model. |
| `toggleable` | `note`             | `data.heightMode`; the only type whose owner changes at runtime.                                                   |
| `manual`     | everything else    | Always the user.                                                                                                   |

[`resolveHeightMode`](../../packages/shared/src/canvas-engine/height/policy.ts) is the single judgement; no consumer re-derives it. Nodes predating the field fall back to the legacy encoding — "auto is the absence of a height" — which is consulted once and then written out explicitly by creation or load normalization. The fallback deliberately does **not** read the measurement hint: a pinned note can carry one too.

A resize gesture on an auto note pins it to `fixed`. That flip is implicit, so the toolbar's auto indicator reflects it at gesture end.

## 4. Freshness

A stored height is meaningless without proof of what it measured. `data.autoHeight.measuredFor` carries an [`AutoHeightKey`](../../packages/shared/src/canvas-engine/height/freshness.ts): `` `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content, src })}` ``.

- **Content revision** proves the height still describes the node's content. Without it, a note rewritten by an agent while offscreen would keep a silently wrong height.
- **`HEIGHT_LAYOUT_VERSION`** is bumped whenever a change alters the rendered height of unchanged content — typography, note padding, the measurement rule itself. Hints live in user workspaces and cannot be cleared retroactively; one integer buys global invalidation.

The reference width is **not** in the key: it is a constant of the node type. The one operation that changes it is a type conversion, which drops the hint outright rather than relying on a comparison.

[`readAutoHeightHint`](../../packages/shared/src/canvas-engine/height/freshness.ts) returns `current | stale | missing`. All three materialize a usable number; only the measurement queues branch on it.

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

**In place** — a `ResizeObserver` on `.ProseMirror` inside a mounted note. Exact by construction, but requires the node to be mounted _and_ hydrated, which [`onlyRenderVisibleElements`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx) and the minimal-LOD hydration gate both deny.

**Offscreen** — one hidden Milkdown instance reused as a measuring tape ([`offscreenMeasurer.ts`](../../apps/web/src/components/Nodes/shared/height/measure/offscreenMeasurer.ts)). Almost all of Milkdown's cost is in building an instance rather than replacing its document, so one build amortized across every queued note is what makes this affordable; it also guarantees a single CSS context. The host is positioned off-screen with `visibility: hidden` — `display: none` would measure zero.

Both resolve under a bounded protocol ([`stability.ts`](../../apps/web/src/components/Nodes/shared/height/measure/stability.ts)): wait for fonts, accept a value only once two consecutive samples agree, resolve _provisionally_ rather than waiting on an undecoded image, and always meet a deadline. A queue that cannot drain is worse than a wrong number. A provisional hint reads as `stale` on the next load, so it is never trusted indefinitely.

Measurement reads `.ProseMirror` rather than the host, whose `scrollHeight` Crepe's absolutely positioned block handle inflates. `.ProseMirror` is `display: flow-root` so a leading child's margin cannot collapse out of the box being measured.

## 7. Commit gating

Proposals go to a singleton queue ([`commitQueue.ts`](../../apps/web/src/components/Nodes/shared/height/commitQueue.ts)) with two gates, both evaluated **at flush time against the live store** — a proposal held through a gesture routinely describes a node the user has since pinned, resized, or deleted.

1. **No-op suppression.** Discard when the proposal resolves to the height the node already has _and_ the stored hint already carries the proposal's key. The comparison is exact, because quantization has already collapsed anything smaller than one step. The provenance half is not optional: content that changes without changing its height would otherwise leave the hint pointing at old content and be re-measured on every load forever.
2. **Interaction suspension.** Pan, zoom, node drag, and resize hold commits until they settle. The ref-counted counter lives in its own dependency-free module ([`commitSuspension.ts`](../../apps/web/src/components/Nodes/shared/height/commitSuspension.ts)) because the gesture handlers live in `canvasStore` and the queue reads `canvasStore`.

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

**Load** runs [`normalizeNodeHeights`](../../apps/web/src/store/canvasStore/load/normalizeNodeHeights.ts) — write the inferred owner explicitly, then materialize — and then [`warmupNodeHeights`](../../apps/web/src/store/canvasStore/load/warmupNodeHeights.ts), which measures never-measured notes _before_ the canvas is shown, nearest to the restored viewport first, under a wall-clock budget. Normalization never writes a hint; a canvas saved before this model existed would otherwise paint a wall of collapsed cards and expand them one by one.

**Prewarming** ([`prewarmQueue.ts`](../../apps/web/src/components/Nodes/shared/height/measure/prewarmQueue.ts)) then measures the rest on idle, ordered by distance from the viewport with never-measured notes ahead of stale ones. Each candidate carries the key of the content it is about to measure, captured before the async work starts, and the commit is dropped if the node's key moved meanwhile.

**Toggling to auto** measures offscreen first when no current hint exists, and lands the measurement and the geometry change in one executor batch, so the node never paints at the policy minimum. A pinned note is never measured in place: its box is one the user chose, and a wrong hint is self-confirming — materializing it produces exactly the number the next measurement would be compared against.

## 9. Persistence

The hint and the materialized height ride the ordinary structure save. `style.height` is redundant with the hint, but the redundancy is safe in the direction that matters: load-time materialization always recomputes and overwrites, so a stale persisted height can never win, while a reader that does not materialize sees a slightly outdated number instead of zero.

Derived geometry is **not yet isolated from the sync path** — see §11.

## 10. The invariant, and how it is checked

An auto note that does not fit its content is a defect report, not a cosmetic complaint: the box was derived from the measurement, so content that overflows means the two disagree. Truncation on a _pinned_ note is normal — the user chose a smaller box.

Two layers assert it. [`useAutoHeightInvariant`](../../apps/web/src/components/Nodes/note/useAutoHeightInvariant.ts) warns in dev once the commit queue has settled, re-reading the DOM after a delay rather than firing on the first short-looking render. [`note-auto-height.spec.ts`](../../apps/web/e2e/note-auto-height.spec.ts) drives a real browser with fixtures chosen for the shapes that have broken it — a leading heading whose margin can escape the measured box, a heading mid-document whose margin cannot, wrapping prose, a list — and asserts both the geometry and that the dev hook stayed silent.

Unit tests cannot cover this class: the failures live in CSS layout, and happy-dom computes none.

## 11. Known limits

- **Narrow notes.** `MIN_CONTENT_SCALE` clamps the content scale at `0.5`, so a note narrower than ~206 px lays its content out at less than the reference width. Its intrinsic height is then measured under a width it does not use, and the note renders short.
- **`text` / `question` are not on this model.** They size themselves synchronously through [`useTextAutoSize`](../../apps/web/src/hooks/useTextAutoSize.ts) and never write `style.height`, so `getNodeSize` returns `0` for one that has not rendered.
- **No sync isolation.** A derived height currently bumps `canvas.version` and broadcasts like any other structural write. [`node-height-ownership-model.md`](../proposals/node-height-ownership-model.md) §D9 specifies the value-aware structure diff, the per-batch derived marker, and the dedicated write channel that close this; they are a prerequisite for multi-user co-editing on canvases containing auto notes.
- **Late-decoding media.** A note whose image has not decoded cannot reach its final height; it commits provisionally and re-measures on the next load.
- **Hug frame geometry** is stored as authored geometry but is in practice derived from its children. See [derived-frame-geometry.md](../backlog/derived-frame-geometry.md).

## Code entry points

| File                                                                                                                          | Responsibility                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`height/policy.ts`](../../packages/shared/src/canvas-engine/height/policy.ts)                                                | Per-type policy, node shell inset, `resolveHeightMode` — the only ownership judgement. |
| [`height/compute.ts`](../../packages/shared/src/canvas-engine/height/compute.ts)                                              | `contentScaleFor`, `intrinsicToLayoutHeight`, quantization.                            |
| [`height/freshness.ts`](../../packages/shared/src/canvas-engine/height/freshness.ts)                                          | `AutoHeightKey`, `HEIGHT_LAYOUT_VERSION`, `readAutoHeightHint`.                        |
| [`height/materialize.ts`](../../packages/shared/src/canvas-engine/height/materialize.ts)                                      | Hint → `style.height`; shared by web load and headless hydration.                      |
| [`commands/setNodeGeometry.ts`](../../packages/shared/src/canvas-engine/commands/setNodeGeometry.ts)                          | Authored geometry; the `'auto'` branch.                                                |
| [`commands/applyMeasuredHeight.ts`](../../packages/shared/src/canvas-engine/commands/applyMeasuredHeight.ts)                  | Derived correction; non-undoable; collects frame ancestors.                            |
| [`commands/changeNodeType.ts`](../../packages/shared/src/canvas-engine/commands/changeNodeType.ts)                            | Drops the hint on conversion and records the target type's ownership.                  |
| [`note/noteContentHost.ts`](../../apps/web/src/components/Nodes/note/noteContentHost.ts)                                      | The box and the reader shared by the mounted note and the offscreen measurer.          |
| [`note/NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx)                                                  | Renders from `style.height`; reports an intrinsic height; never sizes itself.          |
| [`note/heightMemory.ts`](../../apps/web/src/components/Nodes/note/heightMemory.ts)                                            | Session-scoped remembered pinned height; gated on ownership, not on numericness.       |
| [`shared/height/commitQueue.ts`](../../apps/web/src/components/Nodes/shared/height/commitQueue.ts)                            | No-op suppression, coalescing, flush-time validation.                                  |
| [`shared/height/commitSuspension.ts`](../../apps/web/src/components/Nodes/shared/height/commitSuspension.ts)                  | Ref-counted interaction hold; kept dependency-free to stay acyclic with the store.     |
| [`shared/height/measure/`](../../apps/web/src/components/Nodes/shared/height/measure/offscreenMeasurer.ts)                    | Offscreen singleton measurer, stability protocol, viewport-priority prewarm queue.     |
| [`canvasStore/load/normalizeNodeHeights.ts`](../../apps/web/src/store/canvasStore/load/normalizeNodeHeights.ts)               | Load-time ownership normalization and materialization.                                 |
| [`canvasStore/load/warmupNodeHeights.ts`](../../apps/web/src/store/canvasStore/load/warmupNodeHeights.ts)                     | Bounded pre-paint measurement of never-measured notes.                                 |
| [`canvasStore/height/measureMissingAutoHeights.ts`](../../apps/web/src/store/canvasStore/height/measureMissingAutoHeights.ts) | On-demand measurement behind a fixed → auto toggle.                                    |
| [`hooks/useNodeScale.ts`](../../apps/web/src/hooks/useNodeScale.ts)                                                           | Content scale; delegates to `contentScaleFor` so one formula exists.                   |
