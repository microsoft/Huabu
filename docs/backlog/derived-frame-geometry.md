# Derived Frame Geometry

Status: Backlog
Last reviewed: 2026-07-27

> Spun out of [node-height-ownership-model.md](../proposals/node-height-ownership-model.md), which resolves the same distinction for node height but deliberately stops at the frame boundary. Read D9 there first — this document assumes its vocabulary (`authored` vs `derived` geometry, materialization, the per-batch derived marker).

## The distinction that is currently missing

A frame's `data.sizing` already records ownership: `'hug'` means the engine's end-of-batch fit pass computes the frame's box from its children, `'manual'` means the user pinned it. See [`sizing.ts`](../../packages/shared/src/canvas-engine/frame/sizing.ts).

That flag is read by the engine and ignored by everything else. In storage, in the structure-save diff, in `canvas.version`, and in the realtime conflict model, a hug frame and a manual frame are indistinguishable — both carry an ordinary `style` and `position` that are persisted, versioned, broadcast, and reconciled as authored intent.

So the canvas has two kinds of geometry with only one representation:

|             | Authored                             | Derived                              |
| ----------- | ------------------------------------ | ------------------------------------ |
| Node height | user resized (`heightMode: 'fixed'`) | measured (`heightMode: 'auto'`)      |
| Frame box   | user resized (`sizing: 'manual'`)    | fitted to children (`sizing: 'hug'`) |

The node row is resolved by the height ownership proposal. The frame row is not.

## Why frame geometry is an easier derivation than node height — and a harder migration

[`computeContainerFit`](../../packages/shared/src/canvas-engine/container/fit.ts) is a pure function of children geometry and padding. It needs no DOM, no fonts, no device pixel ratio, and no asynchronous measurement. Consequences:

- No measurement hint, no freshness key, no `HEIGHT_LAYOUT_VERSION` equivalent, no bounded-measurement protocol, and no dedicated lossy write channel are required. Everything the fit needs is already in the document.
- Two clients holding the same children compute a **byte-identical** frame box. Unlike node height, this is genuine consensus rather than convergence, so quantization is unnecessary.

The work is therefore only two of the height proposal's ten decisions: the ownership flag (already present as `data.sizing`) and local materialization plus exclusion from the structure diff and the broadcast.

The difficulty is entirely in migration, and it is larger than it looks.

1. **Fit changes `position`, not just size.** A hug frame's top-left moves when its children move, and children's coordinates are parent-local. Making the frame's origin derived means load-time re-derivation partially rebuilds a coordinate system: nothing may read a child's absolute position before its ancestor chain has been fitted bottom-up. [`fitFrames`](../../packages/shared/src/canvas-engine/frame/fit.ts) already sorts deepest-first, so the mechanism exists, but the risk class is different from patching a height.
2. **Existing canvases will visibly move.** A persisted hug-frame box is not guaranteed to equal what the current fit would compute — padding constants have changed, older clients wrote boxes, and drift accumulates. Once load-time re-derivation becomes authoritative, the next open of an existing canvas snaps every drifted frame. That is precisely the experience the height proposal exists to eliminate, reintroduced canvas-wide as a one-time event.
3. **`layoutMode: 'column' | 'row' | 'grid'` frames are sized by the grid solver, not by the fit pass.** [`fitFrameToChildren`](../../packages/shared/src/canvas-engine/frame/fit.ts) returns early for them. Any definition of "derived frame geometry" must cover the grid path too, or the model will be right for free frames and silently wrong for structured ones.
4. **Portals mirror frame geometry.** `frameRef` / `canvasRef` nodes track their source's box. If the source box becomes derived, the mirror must re-derive rather than replay a persisted number, or it becomes a second place holding a stale value.
5. **Locked frames** are skipped by the fit pass entirely, so `locked` is effectively a third ownership state and must be folded into the model rather than special-cased.

## What has already been taken from this idea

The height proposal's Step 6 implements a **per-batch derived marker**: when every command in an executor batch is derived, the batch's whole output — including frames moved by the end-of-batch `fitFrames` pass — skips the structure diff, the version bump, and the broadcast.

That captures most of the practical benefit at a small fraction of the cost, because it changes propagation without changing storage. It does not resolve the distinction; a hug frame's box remains authored data that merely happens not to be rewritten by derived batches.

## When this becomes worth doing

Not before multi-user co-editing ships, and not on architectural grounds alone. The trigger to revisit is empirical:

- Observed cross-client frame refit churn — two clients whose note measurements diverge by more than the quantization step repeatedly refitting a shared frame against each other.
- Or a second consumer of the authored/derived distinction appearing, so the concept earns its cost across more than one call site.

Until one of those is real, this trades a visible one-time regression on existing canvases for conceptual symmetry.

## Unvalidated assumptions

- That persisted hug-frame boxes have measurably drifted from their computed fit. This is asserted from the absence of any invariant enforcing it, not measured. A survey across real workspaces would decide whether risk 2 is serious or theoretical, and it is cheap to run.
- That no server-side or non-engine reader depends on a hug frame's persisted box. Thumbnails, exports, and the world/portal paths need auditing before this is scheduled.
