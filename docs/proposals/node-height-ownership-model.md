# Node Height Ownership Model

Status: Partly shipped
Last updated: 2026-07-28

> Steps 1–5 and most of Step 7 have shipped; the current behaviour is documented in [node-auto-height.md](../architecture/node-auto-height.md), which is authoritative. **Step 6 (sync isolation) is outstanding** and belongs with the multi-user co-editing work. Moving `text` / `question` onto the model is deferred and needs its own proposal — see the note at the end of the rollout.

> Related: [note-auto-height-stable-geometry.md](./note-auto-height-stable-geometry.md) attacks the same symptom and reaches several of the same conclusions independently. This revision adopts its freshness and stability mechanisms (see [D8](#d8--freshness-is-a-key-not-a-timestamp), [D10](#d10--measurement-is-bounded-and-may-be-provisional)) while keeping a different storage decision. See [Relationship to the stable-geometry proposal](#relationship-to-the-stable-geometry-proposal).

## Summary

An auto-height note has no layout height of its own. Its footprint is whatever the DOM happened to produce, which depends on whether Milkdown has mounted, which depends on semantic-zoom LOD and React Flow visibility culling. Zooming or panning a note into view therefore changes canvas geometry, and frames, snapping, edges, and selection bounds all move with it.

This proposal removes the dependency by inverting a single arrow: **the store owns the height and the DOM consumes it**, instead of the DOM producing it. Concretely, `style.height` is a number that is always present for every node, `data.heightMode` records _who owns_ that number — the user (`fixed`) or the renderer (`auto`) — and for auto nodes that number is materialized from a persisted, revision-keyed measurement hint. Measurement no longer sets geometry; it _proposes a correction_ through a dedicated, non-undoable command that is thresholded, suspended during gestures, and animated on commit.

Because multi-user realtime co-editing is a committed direction ([canvas-realtime-sync-plan.md](./canvas-realtime-sync-plan.md)), derived geometry is designed from the start as a **convergent cache rather than shared document state**: it is keyed by content revision, never bumps `canvas.version`, never marks a node dirty, and never enters the conflict model. Two clients measuring the same note compute the same number from the same key, so there is nothing to reconcile.

The consequence is a change of failure mode. Today a wrong or missing height is a layout jump that propagates to every geometry consumer, on every hydration, for unchanged content. After this change it is at most one bounded, gated correction per content change, and prewarming removes even that from the user's view. Measurement accuracy becomes a quality concern rather than a correctness concern, which is what lets the expensive part — offscreen measurement — be sequenced after the correctness work instead of blocking it.

## Problem

### The cycle

```text
content ──▶ (render, only if hydrated) ──▶ DOM height
                                             │
                        measured.height ◀────┘
                                             │
                  getNodeSize() prefers measured ──▶ layout height
```

The layout height is downstream of rendering, and rendering is gated on viewport and zoom. That is the cycle. Everything below is a symptom of it.

### Why each existing mitigation is insufficient

`data.measuredHeight` exists and is genuinely persisted — it is absent from `NODE_CONTENT_KEYS` in [`nodeContentFields.ts`](../../apps/web/src/store/canvasStore/save/nodeContentFields.ts), so [`structureDirtyDetector.ts`](../../apps/web/src/store/canvasStore/save/structureDirtyDetector.ts) treats a write as a structural change and the server's `stripNodesForCanvas` keeps it. But it is only a first-paint seed for the note's own inner container. No engine consumer reads it: `getNodeSize`, frame fitting, the grid solver, and snapping never see it.

`measured.height` is what actually drives layout, because [`getNodeSize`](../../packages/shared/src/canvas-engine/utils/nodeSizes.ts) resolves `measured` before `style`. It has three defects that combine badly:

1. It sits in `NODE_TOPLEVEL_IGNORE` in [`structureDirtyDetector.ts`](../../apps/web/src/store/canvasStore/save/structureDirtyDetector.ts), so a change to it never schedules a save. It only reaches disk by riding along with an unrelated structural write, and can be arbitrarily stale.
2. [`NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx) skips measurement entirely while unhydrated, and hydration is skipped at minimal LOD. A note that has never been viewed at full LOD has never produced a correct value.
3. [`setNodeGeometry.ts`](../../packages/shared/src/canvas-engine/commands/setNodeGeometry.ts) deliberately leaves `measured.height` untouched when a height is cleared, on the reasoning that the new height is unknown and writing `0` would collapse the node. The retained value is the _pre-toggle fixed height_ — a definitively wrong number that layout then uses.

`style.height` is deleted for auto notes by the same command, so nothing authoritative remains.

`onlyRenderVisibleElements` is enabled in [`Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx). Offscreen nodes are unmounted and cannot self-measure. This is why the symptom is not limited to zoom: panning a never-measured note into view produces the same jump, and why [`focusNodesOnCanvas.ts`](../../apps/web/src/components/Panels/CanvasLayerPanel/focusNodesOnCanvas.ts) already carries a fallback chain for "nodes React Flow left unmeasured".

### The maintenance cost, separately from the bug

"Auto height" is currently encoded as _the absence of `style.height`_. Because absence is not a value, every consumer re-derives the mode with its own inline check, and the knowledge is spread across at least eight sites: `ALWAYS_AUTO_HEIGHT_NODE_TYPES` and `DEFAULT_AUTO_HEIGHT_NODE_TYPES` in [`nodeSizes.ts`](../../packages/shared/src/canvas-engine/utils/nodeSizes.ts), `getNodeCreationStyle` in the same file, the `heightCleared` branch in [`setNodeGeometry.ts`](../../packages/shared/src/canvas-engine/commands/setNodeGeometry.ts), `targetKeepsHeight` in [`changeNodeType.ts`](../../packages/shared/src/canvas-engine/commands/changeNodeType.ts), `hasFixedHeight` in [`NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx), `hasFixedNodeHeight` in [`NodeWrapper.tsx`](../../apps/web/src/components/Nodes/NodeWrapper.tsx), `isNoteAutoHeight` in [`NodeFloatingToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar.tsx), the equivalent in [`MultiSelectToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/MultiSelectToolbar.tsx), the `resizeEndClearHeight` prop threaded from [`useTextNodeSurface.ts`](../../apps/web/src/hooks/useTextNodeSurface.ts), and the `style.height` capture in [`heightMemory.ts`](../../apps/web/src/components/Nodes/note/heightMemory.ts).

Independently, notes and text/question nodes solve the same problem with two entirely disjoint mechanisms that share no code: text/question measure synchronously and purely via canvas 2D in [`textMeasure.ts`](../../apps/web/src/utils/node/textMeasure.ts), lock scale into `data.style.fontSize`, and discard `style.height` at resize end; notes measure asynchronously via `ResizeObserver` on `.ProseMirror` and delete `style.height`. Each carries its own legacy migration. Unifying them is the larger maintainability win and is in scope here.

## Acceptance bars

Two bars are stated separately because they are met by different steps and are verified differently. Conflating them is how the first revision of this document came to claim the jump was fixed earlier than it is.

**Bar A — causal (correctness).** Rendering is never the cause of a geometry change. LOD transitions, hydration, and virtualization mount/unmount do not alter `getNodeSize` output for any node. Met at Step 4. Verified by automated assertion.

**Bar B — outcome (quality).** When a node becomes visible, its size is already final. Approached at Step 5 and is the accepted product target. It cannot be verified by a single assertion and is not absolutely attainable — see below.

After Bar A is met, the only remaining cause of a size change is that the stored height does not match the current content. That residue is finite and self-extinguishing: at most one correction per node per content change, never recurring for unchanged content. Bar A accepts it; Bar B does not, which is why Bar B requires measuring nodes _before_ the user reaches them.

Bar B has two honest limits, both of which are accepted rather than solved:

- **Cold-start window.** The prewarm queue is idle-scheduled. A user who loads a large canvas and immediately pans across unmeasured regions will outrun it. Bar B therefore means "zero size change in the steady state", not "zero size change always".
- **Late-decoding media.** A note containing an image of unknown intrinsic size cannot be measured to its final height until that image decodes, and a client with a cold HTTP cache cannot do that before the note is reached. Closing this requires persisting intrinsic media dimensions alongside the height hint, which is out of scope here and left as an open question.

The metric for Bar B is instrumented rather than asserted: **the share of `APPLY_MEASURED_HEIGHT` commits that land while the target node is visible.** Prewarmed commits are invisible to the user; visible commits are Bar B violations. The target is that this share trends to zero as the queue drains.

## Goals

1. Viewport pan, zoom, LOD transitions, and virtualization mount/unmount never change a node's layout geometry.
2. Every node has a numeric layout height at all times, including before its body has ever rendered.
3. Height ownership (`auto` vs `fixed`) is an explicit, persisted, single-source value — never inferred from the presence of a number.
4. Height correctness has exactly one read path (`getNodeSize`) and exactly one write path (a dedicated command), for all node types.
5. Note and text/question auto-sizing share one policy/commit skeleton, differing only in their measurement strategy.
6. A wrong height degrades to transient clipping, never to a layout jump.
7. Derived height corrections do not enter undo history, do not bump authored-content revision, and do not appear in the action log.
8. A node's own derived height never bumps `canvas.version`, never marks the node dirty, and never participates in the realtime conflict model. A user editing a note in one tab is never blocked, warned, or overwritten because another client measured it.
9. A cached height can always be proven fresh or stale against the content it describes. Staleness is detectable without re-measuring, and is never fabricated.
10. In the steady state, a node is measured before the user can see it (Bar B).

## Non-goals

1. Server-side layout computation. The backend validates and stores; it does not calculate browser layout.
2. Predicting height from Markdown length as an authoritative value. Estimation is only ever a never-measured fallback.
3. A second Markdown renderer. If offscreen measurement is added, it reuses the real Milkdown pipeline.
4. Changing the fixed-height user experience, the fixed → auto → fixed height memory, or the resize gesture contract.
5. Disabling `onlyRenderVisibleElements` or the deferred hydration scheduler.
6. Byte-identical derived geometry across clients. The target is convergence and the absence of conflict, not consensus: a client running a different font stack may legitimately compute a different number, and that must not be an error condition.

## The three heights

The current design conflates three distinct quantities into two fields. Naming them separately is the precondition for every decision below.

| Concept              | Definition                                                                   | Today                                                                     | After                                                                      |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Intrinsic height** | `f(content, canonical content width)`. Independent of node scale and chrome. | `data.measuredHeight`, note-only, read only by the note body.             | `data.autoHeight`, a key-stamped hint. The persisted truth for auto nodes. |
| **Layout height**    | The number every geometry consumer uses.                                     | Sometimes `style.height`, sometimes `measured.height`, sometimes neither. | `style.height`. Always numeric. Materialized from the hint for auto nodes. |
| **Rendered height**  | The DOM's actual box.                                                        | `measured.height` — and it _drives_ layout via `getNodeSize`.             | A read-only mirror of `style.height`, plus a verifier that feeds the hint. |

The invariant to enforce and to test for: **no arrow runs from rendering to layout height within a frame.** Rendering feeds the hint; the hint is materialized into layout height at two well-defined moments (canvas load, and a gated commit) rather than continuously. That deferral is what breaks the cycle.

The only _direct_ writer of layout height is a resize gesture, which is user input, not rendering.

## Decisions

### D1 — `style.height` is always a number

For every node type, `style.height` is present and numeric in the in-memory canvas. Clearing it is no longer a legal operation.

This is the whole fix. Once the store holds a number and the node body is constrained to it, React Flow measures exactly what the store already said, `measured.height` converges instead of contradicting, and no consumer can observe a hydration-order-dependent value.

For an auto node this number is _materialized_, not authored. The persisted truth is the hint defined in [D8](#d8--freshness-is-a-key-not-a-timestamp); `style.height` is what that hint evaluates to. Materialization happens at exactly two moments — canvas load, and a gated measurement commit — never per read. This is the difference from a projection layer: the number is written once into the same node object every consumer already reads, so no consumer learns a new API, and the engine (which runs headless on the server against the same node shape) needs no resolver.

On disk, an auto node's `style.height` carries no authority and may be absent or stale. Readers materialize it. Materialization therefore lives in `packages/shared` and is applied by both the web load path and any server-side path that hydrates a canvas for engine execution.

### D2 — Ownership is a flag, not the presence of a number

`BaseNodeData` gains:

```ts
/** Who owns `style.height`: the user (`fixed`) or the renderer (`auto`). */
heightMode?: 'auto' | 'fixed';
```

This is the direct answer to the objection that D1 conflates user-owned and renderer-owned geometry. It does not: ownership moves into a dedicated field that says so explicitly, which is strictly more expressive than encoding it as the absence of a value. Absence cannot distinguish "renderer owns this" from "nobody has measured this yet" — which is precisely the ambiguity that produces the current bug.

The same objection is sometimes raised in the opposite direction: why not keep a single slot and let `style.height` hold the string `'auto'`? Because mode and value are orthogonal, and one slot cannot hold both facts at once.

|         | value = ⊥    | value = 812                 |
| ------- | ------------ | --------------------------- |
| `auto`  | a note today | **what this proposal adds** |
| `fixed` | —            | a note the user has resized |

The top-right cell is the entire fix: _this note is auto-sized, and it is currently 812 px, even though nothing has ever rendered it_. Encoding the mode in the value slot makes that cell permanently unreachable.

`'auto'` would also not be inert in the meantime. [`getNodeSize`](../../packages/shared/src/canvas-engine/utils/nodeSizes.ts) parses a string height with `parseFloat`, so `'auto'` yields `NaN`, falls through the `??` chain, and resolves to `0` — byte-for-byte identical to the absent value it was meant to improve on.

A single resolver replaces all eight inline checks:

```ts
export function resolveHeightMode(node: Node): 'auto' | 'fixed' {
  const policy = getHeightPolicy(node.type ?? '');
  if (policy.kind === 'content') return 'auto'; // text, question
  if (policy.kind === 'manual') return 'fixed'; // image, video, pdf, web
  const explicit = (node.data as { heightMode?: 'auto' | 'fixed' })?.heightMode;
  if (explicit) return explicit;
  // Legacy: absence of an explicit height used to mean "auto".
  return typeof (node.style as { height?: number })?.height === 'number'
    ? 'fixed'
    : 'auto';
}
```

### D3 — The DOM is a consumer, never a producer

The note body renders identically in both modes: the outer container is `h-full overflow-hidden`, and the inner scaled container is `height: 100/scale%`. The branch in [`NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx) that computes `height: contentHeight * scale` for auto mode is deleted.

The existing `.ProseMirror` `ResizeObserver` stays, but its output no longer touches the DOM. It reports an intrinsic height, which becomes a _proposal_.

A side effect worth keeping: the truncation indicator stops being conditional on fixed mode. In auto mode it now surfaces during the window between "content grew" and "the correction committed", which is exactly the honest signal.

### D4 — One height-policy registry

```ts
type HeightPolicy =
  | { kind: 'content'; refWidth: number; insetY: number } // text, question
  | { kind: 'toggleable'; refWidth: number; insetY: number; default: 'auto' } // note
  | { kind: 'manual' }; // image, video, pdf, web
```

`refWidth` and `insetY` are declared per type rather than hard-coded at the use site, which folds in the `REF_WIDTHS` table in [`useNodeScale.ts`](../../apps/web/src/hooks/useNodeScale.ts) and removes the chrome constant that would otherwise be guessed inside the note component. `ALWAYS_AUTO_HEIGHT_NODE_TYPES`, `DEFAULT_AUTO_HEIGHT_NODE_TYPES`, `resizeEndClearHeight`, and every scattered boolean derive from this one table.

Intrinsic → layout conversion becomes one pure function:

```ts
export function intrinsicToLayoutHeight(
  intrinsicH: number,
  nodeWidth: number,
  policy: HeightPolicy,
): number;
```

Used by three callers and only three: the `APPLY_MEASURED_HEIGHT` measurement commit, the `height: 'auto'` branch of `SET_NODE_GEOMETRY` (D5), and load-time materialization.

### D5 — Two commands, split by authorship rather than by value

Height changes arrive from two different places. The line between them is **who caused the change**, not what value was written.

| Change                        | Frequency | Authored | Undoable | Command                        |
| ----------------------------- | --------- | -------- | -------- | ------------------------------ |
| User drags a note to a height | low       | yes      | yes      | `SET_NODE_GEOMETRY` (number)   |
| User switches a note to auto  | low       | yes      | yes      | `SET_NODE_GEOMETRY` (`'auto'`) |
| Content changed, re-measured  | **high**  | no       | **no**   | `APPLY_MEASURED_HEIGHT`        |

The names must carry that line, because the two are otherwise easy to confuse: `SET_NODE_GEOMETRY { height: 'auto' }` and a derived correction both end up writing a number into `style.height`. A name describing the _value_ — `SET_AUTO_HEIGHT` — would read as a synonym for the mode toggle and invite exactly the wrong mental model, that the second command is a follow-up acknowledgement of the first. `APPLY_MEASURED_HEIGHT` names the author instead: a measurement happened, and this applies it. Its dominant trigger is a content edit, not a geometry command.

#### `SET_NODE_GEOMETRY` gains an explicit `'auto'`

`CanvasNodeGeometryUpdate.size.height` widens from `number` to `number | 'auto'`.

This is not a new capability, only an honest spelling of one that already exists: [`setNodeGeometry.ts`](../../packages/shared/src/canvas-engine/commands/setNodeGeometry.ts) already treats any non-numeric height as `heightCleared` and deletes `style.height`. The comment on that branch states the defect outright — _"the new content height is unknown until the next render"_.

Under this proposal the branch stops deleting and starts resolving: `'auto'` writes `data.heightMode = 'auto'` and immediately materializes a concrete height from the node's hint. The `heightCleared` path disappears, and with it the last place where the engine deliberately leaves a height undefined.

Because this type is agent-visible, the zod schema validating `SET_NODE_GEOMETRY` on the server widens with it. That is intended: "make this note fit its content" is a legitimate authored intent, and it is the only height intent an agent should be able to express.

##### The counter-argument, stated fairly

There is a real tension between this and [D2](#d2--ownership-is-a-flag-not-the-presence-of-a-number), which spends a section arguing that a mode must not live in a value slot. Here the mode does live in a value slot — just a command's, not storage's.

The codebase already contains the alternative spelling, and it works. A frame's `data.sizing` is the frame-level equivalent of `heightMode`, and when the user types an explicit width or height into the size picker, [`NodeFloatingToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/FloatingToolbars/NodeFloatingToolbar.tsx) dispatches **two** commands — `SET_FRAME_LAYOUT_MODE { sizing: 'manual' }` followed by `SET_NODE_GEOMETRY` — folded into a single `beginGesture` so they collapse into one undo entry. A parallel `SET_NODE_HEIGHT_MODE` would be entirely consistent with that precedent and would leave `SET_NODE_GEOMETRY` purely numeric.

The reason this proposal still chooses `'auto'` is the agent, not the user. Agents cannot open a gesture, so the two-command spelling would either give them a way to emit a half-applied intent (mode changed, size not yet followed) or require them to reason about batch atomicity to avoid it. A single self-describing enum value compresses one intent into one command. The distinction from D2 is lifetime: a command input is consumed once by one handler and discarded, whereas `style.height` is read by dozens of consumers forever, several of which would `parseFloat` it into `NaN`.

If the agent-facing argument ever weakens — for example if the command schema gains real batch-atomicity semantics agents can rely on — aligning with the frame precedent is the better end state.

#### `APPLY_MEASURED_HEIGHT` carries the derived correction

```ts
meta: { snapshot: 'no', requiresEdgeReroute: true }
```

The handler accepts `{ nodeId, intrinsicHeight, measuredFor, provisional? }[]`, ignores any node whose `resolveHeightMode` is not `auto`, and writes the hint and the materialized geometry in a single step — `data.autoHeight`, `style.height`, and `measured.height` together — so geometry and its provenance can never disagree. Mirroring into `measured` is required for the same reason `setNodeGeometry.ts` already mirrors width: `getNodeSize` reads `measured` first, and the end-of-batch `fitFrames` pass runs before React Flow's `ResizeObserver` has reconciled the DOM.

Because the height is known at commit time rather than "after the next render", the `deferredFitFrameIds` double-rAF path can be dropped for note auto-height. Parents are added to `affectedFrameIds` and fit synchronously in the same batch, so there is no intermediate frame where a note and its parent frame disagree.

With the mode toggle absorbed by `SET_NODE_GEOMETRY`, and load-time materialization being a pure array transform applied before the nodes enter the store, `APPLY_MEASURED_HEIGHT` has exactly **one** caller: the measurement commit.

#### Why a command at all, when the value is derived

A derived value has no business in the undo stack, in `canvas.version`, or in the realtime broadcast — and this command is in none of them. But bypassing the executor entirely would buy nothing and cost the cascade.

It buys nothing because [`structureDirtyDetector.ts`](../../apps/web/src/store/canvasStore/save/structureDirtyDetector.ts) compares node snapshots and has no idea what produced them. A plain store mutation would need the identical D9 exemption. Undo is already off via `snapshot: 'no'`.

It costs the cascade because a height change must refit parent hug frames, reroute edges, and mirror into portals. Handlers do not call `fitFrames` themselves — they declare `affectedFrameIds`, and the executor runs a single end-of-batch pass filtered per-frame by `data.sizing`. Re-implementing that gating in a bespoke store path duplicates real policy and loses batching exactly where it matters most: the prewarm queue commits many notes at once, which must produce one refit pass rather than N. Reusing `MERGE_NODE_DATA` to write only the hint fails for the same reason — it declares no `affectedFrameIds` at all, so the parent frame would never follow.

The executor is therefore used for its **cascade**, with its other semantics switched off one by one. That is only possible because they are configured per command type — which is also why this cannot be a flag on `SET_NODE_GEOMETRY`: `snapshot` is a property of the type, not of an item, so a single type cannot be both undoable and not.

This is not a new pattern. [`setNodeSelection.ts`](../../packages/shared/src/canvas-engine/commands/setNodeSelection.ts) is already `snapshot: 'no'` with its written field (`selected`) exempted from the dirty detector — the same three-part shape, differing only in that `selected` is top-level while `autoHeight` lives in `data` and therefore needs its own exemption set (Step 6).

It also carries a directly transferable lesson. `setNodeSelection` reuses the original node reference whenever the visible flag is unchanged, and returns the original array when the batch was a no-op, because every downstream `React.memo` and xyflow reconciliation relies on reference identity. `APPLY_MEASURED_HEIGHT` is at least as hot, and **must** do the same; `materializeAutoHeights` already establishes the pattern.

Crucially, `APPLY_MEASURED_HEIGHT` is **not** a structure save. See [D9](#d9--derived-geometry-is-a-convergent-cache-not-shared-state) for how it reaches disk.

### D6 — Commit gating is where the smoothness comes from

A singleton commit queue applies two gates before dispatching:

1. **No-op suppression.** Discard when the proposal resolves to the layout height the node already has, _and_ the stored hint already carries the proposal's key. Kills sub-pixel `ResizeObserver` churn.
2. **Gesture suspension.** While a zoom, pan, drag, or resize gesture is active, corrections accumulate in a pending map instead of dispatching. They flush once on settle. This alone removes mid-gesture movement even when a measurement is late.

Gate 1's comparison is **exact**, not tolerance-based. An earlier revision specified `|next - current| <= 2`; implementing it showed that to be dead code, because the comparison happens after the 4 px quantization in `intrinsicToLayoutHeight` and no difference smaller than one step can survive to be compared. Quantization already _is_ the tolerance; a second one would only be a place for the two numbers to disagree.

The second half of gate 1 is not optional. Geometry settling is insufficient on its own: content that changes without changing its height would leave the stored hint pointing at the old content, so the node would report `stale` and be re-measured on every load forever. The commit has to land to let provenance catch up, even when no pixel moves.

Both gates are evaluated **at flush time against the live store**, never at enqueue time. A proposal held through a gesture may describe a node the user has since pinned, resized, or deleted.

Gate 2 is what makes measurement latency invisible; gate 1 is what makes it cheap. Neither reduces the _number_ of corrections — that is Bar B's job, and it belongs to prewarming.

An earlier revision proposed animating the committed height change by writing `style.transition` and clearing it on the next frame. That is dropped. Clearing on the next frame would abort the transition it just started; `OverlayPortal` in [`NodeWrapper.tsx`](../../apps/web/src/components/Nodes/NodeWrapper.tsx) uses the presence of `style.transition` as a FLIP _marker_, and overloading one field to carry both a marker and a CSS animation lifetime is how that gets broken. There is also a substantive objection: during the transition the store already holds the final geometry, so edges, selection bounds, and hit-testing would use the end state while the DOM interpolates. Whether a correction should be animated at all is best decided after Steps 3–4 are observable in practice; if it is wanted, it needs a dedicated transient token cleared on `transitionend` or a bounded timer, not a reused field.

### D7 — Measurement is an interface, and the offscreen singleton is one implementation

```ts
interface HeightMeasurer {
  measure(req: {
    nodeId: string;
    content: string;
    logicalWidth: number;
  }): Promise<number>;
}
```

Two implementations, introduced in order:

**`inPlace`** — the existing `.ProseMirror` `ResizeObserver`, extracted from the note component. Exact by construction, because it measures the real thing. Its only limitation is that it requires the node to be mounted.

**`offscreen`** — a singleton hidden host holding **one** read-only Milkdown instance, reused as a measuring tape via `setMarkdown()` for every queued note. The singleton is not a tidiness preference: the cost of Milkdown is almost entirely in _building_ the instance, not in replacing its document, so amortizing one build across N notes is the only thing that makes offscreen measurement affordable at all. It also guarantees a single CSS context, so no two notes can drift apart.

Because `onlyRenderVisibleElements` unmounts offscreen nodes, `inPlace` can never cover a note the user has not looked at. The offscreen implementation is therefore **required for Bar B**, and is a required phase rather than an enhancement. D1–D3 still reduce an unmeasured note to transient clipping rather than a jump, which is what lets it be sequenced after Bar A rather than before it — but it is not optional.

The prewarm queue is priority-ordered, not FIFO. Bar B is about reaching a node before the user does, so the queue is sorted by distance from the current viewport, biased along the pan direction, with anything inside or adjacent to the viewport first. Stale hints outrank missing ones only when the stale value is far from the last measurement; otherwise missing hints go first, since they carry the largest potential correction.

Offscreen host constraints, all of which are failure modes if violated: absolutely positioned off-screen with `visibility: hidden` (never `display: none`, which measures zero); fixed at the policy's `refWidth`; mounted inside the same `.milkdown` CSS scope used by the visible body. Timing and provisional results are specified in [D10](#d10--measurement-is-bounded-and-may-be-provisional).

### D8 — Freshness is a key, not a timestamp

A measurement is meaningless without knowing what it measured. `data.autoHeight` therefore carries its own identity:

```ts
interface AutoHeightHint {
  /** Content height at the type's reference width, excluding node chrome. */
  intrinsicHeight: number;
  /** Identity of the inputs this height was measured against. */
  measuredFor: AutoHeightKey;
  /** Settled before fonts or images finished; re-measure on next load. */
  provisional?: boolean;
}

/** `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content })}` */
type AutoHeightKey = string;

export function autoHeightKey(node: Node): AutoHeightKey;
```

The usability check is one comparison: `hint.measuredFor === autoHeightKey(node)`.

There is no sentinel for "a height of unknown provenance", because nothing is ever allowed to write one. A hint exists only where a measurement produced it. The absence of a hint is itself the honest representation of an unproven height, and it is what the `missing` freshness value reports.

The key deliberately has no separate fields. Consumers only ever compare it for equality — nothing downstream needs to know _whether_ the content or the renderer layout changed, only that the height no longer applies. Splitting it would create two fields that must always be read together, which is the shape of a future bug.

It has exactly two components, and neither can be dropped:

- **Content revision**, via [`nodeRevisionOf`](../../packages/shared/src/canvas-engine/change.ts) — the same primitive the content CAS path already uses, so measurement identity speaks the existing vocabulary. It grants no write authority; it only proves which content the height describes. Without it, an agent or a remote collaborator editing a note while it is offscreen leaves the stored height silently and _undetectably_ wrong. With it, the mismatch is observable at load time and the node is queued for re-measurement.
- **`HEIGHT_LAYOUT_VERSION`**, a single check-in constant — bumped when Milkdown configuration or `.milkdown` CSS changes the shape of rendered content. The hints live in user workspaces, so there is no way to go back and clear them; without a version stamp, a typography change silently invalidates every stored height and the errors surface only as users happen to open each note. One integer buys global invalidation.

The reference width is deliberately **not** stored. It is a constant of the node type, derived from the policy table (`getHeightPolicy(node.type).refWidth`), not per-node data. Copying it into user data would only create a second place for it to disagree with itself. The one case that would change it — converting a note to another type — is an explicit command, which clears the hint outright rather than relying on a comparison.

The resolver returns freshness rather than hiding it:

```ts
type HeightFreshness = 'current' | 'stale' | 'missing';

export function readAutoHeightHint(node: Node): {
  hint?: AutoHeightHint;
  freshness: HeightFreshness;
};
```

`stale` and `missing` both still materialize a usable number — the stale hint's height, or the policy minimum. The difference is only that they enqueue a re-measurement. Nothing downstream branches on freshness; only the measurement queue does.

Freshness is never fabricated. A hint may only claim an `AutoHeightKey` that a measurement produced it under. The design has no path that synthesizes one — not even for backwards compatibility, which is why no legacy height is carried forward into the new field.

### D9 — Derived geometry is a convergent cache, not shared state

This is the decision that makes the model safe under multi-user co-editing.

Derived height is not a document. It is a recomputable function of `(content, node type, renderer layout, font stack)`, so it must not be routed through machinery designed for reconciling _intent_. For **a node's own auto height** the guarantees are absolute:

1. **No version bump.** `style.height` for auto nodes and `data.autoHeight` are excluded from the structure-save diff. A burst of pixel corrections cannot produce a burst of `canvas.version` increments, and cannot cause a 409 for an unrelated concurrent edit.
2. **No broadcast.** Derived height emits no `update` event. Per [canvas-realtime-sync.md](../architecture/canvas-realtime-sync.md), a broadcast forces every peer to either apply a delta or take a version gap and `loadCanvas`; measurement noise must never be able to trigger either.
3. **No dirty-node interaction.** A measurement never marks a node dirty, and never causes a remote update to be skipped. The realtime conflict model's scope is authored content, and derived geometry stays outside it — this proposal narrows that surface rather than widening it.
4. **Inbound deltas are re-materialized, not trusted.** When a remote delta carries an auto node's `style.height`, the receiving client discards it and re-materializes from its own hint. This is what prevents a peer's in-flight or lower-fidelity measurement from moving geometry under a local user's cursor.

Excluding the height from the structure diff is more than adding a key to `NODE_TOPLEVEL_IGNORE`. [`structureDirtyDetector.ts`](../../apps/web/src/store/canvasStore/save/structureDirtyDetector.ts) compares top-level keys with `!==`, and `style` is an object — so it is compared **by reference**, and rebuilding `{ ...style, height }` trips the gate even when the value is unchanged. The detector needs a value-aware comparison of `style` that skips `height` when `resolveHeightMode(node) === 'auto'`. This is a real cost of the step, and it must not silently loosen the gate for fixed-height nodes.

#### Derived batches, and the frame-refit exception

The guarantees above cover the node. They do not automatically extend to its consequences. A committed height change causes `fitFrames` to resize the parent hug frame, and a frame's `style` and `position` are ordinary structural fields: left alone, that write bumps the version, broadcasts, and enters the conflict model like any other geometry change.

The fix is to scope the guarantee to the **batch** rather than to the field. [`executor.ts`](../../packages/shared/src/canvas-engine/executor.ts) already computes `snapshotNeeded` per batch from `COMMAND_META`, and already carries a per-batch `execution.source`. A parallel per-batch judgement is added: when every command in a batch is derived (today that means `APPLY_MEASURED_HEIGHT`), the batch's **entire output is derived** — including the frames the end-of-batch `fitFrames` pass moved. The store then skips the structure diff, the version bump, and the broadcast for the whole batch.

This is safe precisely because frame fit is _not_ a measurement. [`computeContainerFit`](../../packages/shared/src/canvas-engine/container/fit.ts) is a pure function of children geometry and padding, with no DOM, no fonts, and no device dependency — so a peer holding the same hints computes a byte-identical frame box. There is nothing to reconcile, and nothing worth sending.

What this deliberately does **not** do is change how frame geometry is stored. A hug frame's box remains persisted authored geometry; it is simply not _rewritten_ by a derived batch. That leaves the deeper separation unresolved — a hug frame's box is stored as authored geometry but is in practice derived from its children — and resolving it means making frame geometry locally materialized the way node height now is. That is a larger change with a materially different risk profile (a hug frame's `position` is derived too, and children's coordinates are parent-local, so load-time re-derivation partially rebuilds a coordinate system), and it is deliberately out of scope. It is recorded in [derived-frame-geometry.md](../backlog/derived-frame-geometry.md).

Two residual cases stay accepted:

- A batch that mixes an authored command with a derived one is treated as authored in full. This is the conservative direction and it costs nothing, because the two never share a batch in practice — the commit queue dispatches measurements alone.
- [`fitFrameToChildren`](../../packages/shared/src/canvas-engine/frame/fit.ts) short-circuits to the same node array reference when the frame already fits, so a refit that changes nothing costs nothing and trips no gate even before the batch marker exists. Only a real size change ever depended on this.

The pathological case is the first load of an existing canvas, where every note is unproven at once and the prewarm queue corrects them in bulk. That is handled as a one-time normalization rather than as ordinary operation: refit locally, persist once, do not broadcast.

#### Persistence and convergence

Persistence uses a dedicated derived-geometry write channel rather than the canvas structure PUT: a small endpoint whose contract lives in [`packages/shared/src/types/api/canvas.ts`](../../packages/shared/src/types/api/canvas.ts) per [api-design.md](../architecture/api-design.md), accepting a batch of hints and merging them into node `data` **without** touching `canvas.version` and **without** publishing an update. The server's only validation is a freshness check: reject a hint whose `measuredFor` does not match the node's current on-disk content, because such a hint describes content the server no longer has.

The materialized `style.height` is persisted alongside the hint rather than stripped for auto nodes at the serialization boundary. It is redundant — it is a pure function of the hint, the node type, and the reference width — but the redundancy is safe in the direction that matters: load-time materialization always recomputes from the hint and overwrites, so a stale persisted height can never win. What it buys is that a reader which does not run materialization sees a slightly outdated number instead of zero. Stripping it would instead add an asymmetric write-time transform to a boundary that already maintains `NODE_CONTENT_KEYS` in three separate places, where one missed site is a silent bug. The hint is the truth; `style.height` is a durable cache of it.

The persisted hint is an **advisory seed, not a guarantee**. It exists to do two things: stop a cold-starting client from collapsing an unmeasured note to the policy minimum, and give the headless engine a real number for auto-layout. It does not promise that two clients render the same note at the same height — they may not, because font availability, browser version, and device pixel ratio all affect the measurement and none of them are captured by the key, deliberately. The key's job is detecting content and renderer-layout staleness, not proving cross-device determinism.

Last-writer-wins is therefore safe not because the writers agree, but because the worst case is a marginally different seed that each client corrects locally on its next measurement. Nothing reads the hint expecting authority.

To keep that residual divergence from turning into frame-refit churn, committed heights are **quantized to a 4 px step** in `intrinsicToLayoutHeight`. Sub-step differences between clients then collapse to the same value and produce no write at all.

The cost of a lost or rejected write is one re-measurement on the next load. That is the entire blast radius, and it is why this channel is allowed to be lossy.

### D10 — Measurement is bounded and may be provisional

An asynchronous measurement that never declares itself finished is worse than a wrong one, because the commit queue cannot drain. Every `HeightMeasurer` implementation resolves under a bounded protocol:

1. `await document.fonts.ready` before the first non-provisional result. A metric-incompatible fallback font is the largest single source of measurement error.
2. Accept a value only after two consecutive samples agree within 1 px. ProseMirror reflows asynchronously after `setMarkdown`, and the first frame is routinely wrong.
3. If images have not decoded, resolve **provisionally**: mark the hint `provisional: true`, commit it (a provisional height is still far better than a policy minimum), and re-queue the node on `load`.
4. Hard timeout. On expiry, resolve with the best sample seen so far, marked provisional. The queue must always drain.

A provisional hint is treated as `stale` on the next load, so it re-measures rather than being trusted indefinitely. Results are cached in memory under the same `autoHeightKey` and written through to `data.autoHeight`, so a warm canvas queues almost nothing.

## Data flow

```text
content ──measure (D10)──▶ intrinsic ──▶ data.autoHeight  ← persisted truth
                                          { intrinsicHeight,             (auto)
                                            measuredFor }
                                                    │
                                    materialize (load | gated commit)
                                                    ▼
resize gesture ────────────────────────────▶ style.height  ← what layout reads
                                                    ▼
                                      DOM (h-full, overflow-hidden)
                                                    ▼
                              measured.height (mirror) ──verify──▶ hint
```

## Module boundaries

| Module                                                              | Responsibility                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/types/canvas/node.ts`                          | `heightMode` and `autoHeight: AutoHeightHint` on `BaseNodeData`.                                       |
| `packages/shared/src/canvas-engine/height/policy.ts`                | `HeightPolicy` registry and `resolveHeightMode()` — the only mode judgement in the codebase.           |
| `packages/shared/src/canvas-engine/height/compute.ts`               | Pure `intrinsicToLayoutHeight()`, including the 4 px quantization.                                     |
| `packages/shared/src/canvas-engine/height/freshness.ts`             | `AutoHeightHint`, `HEIGHT_LAYOUT_VERSION`, `autoHeightKey()`, `readAutoHeightHint()`.                  |
| `packages/shared/src/canvas-engine/height/materialize.ts`           | `materializeAutoHeights(nodes)` — hint → `style.height`. Shared by web load and server-side hydration. |
| `packages/shared/src/canvas-engine/commands/applyMeasuredHeight.ts` | Non-undoable derived-height command; writes hint and geometry together; collects frame ancestors.      |
| `packages/shared/src/types/api/canvas.ts`                           | Derived-geometry batch write schema (zod + inferred type).                                             |
| `apps/web/src/components/Nodes/shared/height/useAutoHeight.ts`      | Type-agnostic hook: intrinsic in, gated commit out. Used by note, text, and question.                  |
| `apps/web/src/components/Nodes/shared/height/commitQueue.ts`        | No-op suppression, gesture suspension, per-node coalescing.                                            |
| `apps/web/src/components/Nodes/shared/height/commitSuspension.ts`   | Dependency-free interaction counter; keeps the queue and `canvasStore` acyclic.                        |
| `apps/web/src/components/Nodes/note/noteContentHost.ts`             | The box and the height reader shared by the mounted note and the offscreen measurer.                   |
| `apps/web/src/components/Nodes/shared/height/measure/`              | Offscreen singleton measurer, the D10 stability protocol, and the prewarm queue.                       |
| `apps/web/src/store/canvasStore/save/derivedGeometryQueue.ts`       | Batches hints to the derived-geometry endpoint; independent of the structure autosave.                 |
| `apps/web/src/components/Nodes/note/NoteNode.tsx`                   | Renders from `style.height`; reports intrinsic height; no longer sizes itself.                         |
| `apps/web/src/hooks/useTextAutoSize.ts`                             | Retained as the text/question _measurer_; its commit path moves to `useAutoHeight`.                    |

## Normalization of existing canvases

There is no data migration. Nothing is copied out of the old representation into the new one, and no eager workspace rewrite happens.

What does happen is lazy normalization at canvas load: for each node without `data.heightMode`, infer the mode from the presence of `style.height` (per `resolveHeightMode`'s legacy branch) and write it explicitly. That is a statement of ownership, not a height.

Existing notes therefore start with **no** hint. `readAutoHeightHint` reports `missing`, they materialize at the policy minimum, and the prewarm queue — which prioritizes `missing` over `stale` — measures them. From the second load onwards each note has a real, key-stamped hint and the question never arises again.

Seeding the hint from the existing `data.measuredHeight` was considered and rejected. The value itself is sound — it is genuinely persisted and is already an intrinsic, pre-scale height — but it carries no revision, so there is no evidence it still corresponds to the node's content; an agent may have rewritten the note long after the height was recorded. Carrying it forward would mean either fabricating a key, which is precisely the defect D8 exists to prevent, or inventing a sentinel and a write that dirties every node on first load, producing exactly the canvas-wide structure save D9 exists to avoid. Since Step 5 ships in the same release as Steps 2–4, the only thing the seed would buy is a shorter first-open window on each existing canvas — not worth a second, weaker provenance path through the design.

### Retiring `data.measuredHeight`

The legacy field is superseded by `data.autoHeight` and is never read by the new code. It is removed in two moves:

1. **Step 3** — stop writing it. The note body no longer sizes itself, so its only writer disappears naturally.
2. **Step 7** — delete the field from [`node.ts`](../../packages/shared/src/types/canvas/node.ts). Values left on disk are inert from Step 3 onwards.

This also discharges the TODO already recorded on the field's own TSDoc: it warns that the value rides the whole-node JSON to disk, churns on every zoom and edit, and should either be stripped at the persistence boundary or promoted into a shared `viewHints` sub-object once a second view-only field appears. `data.autoHeight` _is_ that sub-object, with the content revision the original field lacked.

Note that `node.measured.height` — React Flow's own top-level field, unrelated despite the similar name — is **not** retired. It stays as a read-only mirror of `style.height`, written together with it by `APPLY_MEASURED_HEIGHT` so the two cannot disagree. Making `getNodeSize` prefer `style` over `measured` would be the deeper fix, but that priority also governs width and the manual-height media types, so it is a separate change and is deferred to Step 7 at the earliest.

Two guards are mandatory:

`useTrackNoteFixedHeight` in [`heightMemory.ts`](../../apps/web/src/components/Nodes/note/heightMemory.ts) currently records _any_ numeric `style.height`. After D1 that would record auto heights and destroy the fixed → auto → fixed round-trip. It must be gated on `resolveHeightMode(node) === 'fixed'`.

The migration must never convert an auto node to fixed merely because it now carries a number. This is the inverse of the inference rule and is the single most likely way to get normalization wrong.

## Rollout

Each step is independently mergeable and independently verifiable. Steps 1–5 ship together, which is what allows normalization to carry no data forward.

**Step 1 — Contract.** `heightMode`, `AutoHeightHint`, `autoHeightKey`, `HEIGHT_LAYOUT_VERSION`, `policy.ts`, `compute.ts` (including the 4 px quantization), `freshness.ts`, `materialize.ts`. Pure additions, zero behaviour change. Unit tests for legacy mode inference, freshness resolution, and the equivalence of the policy table with the constants it replaces.

**Step 2 — Authority.** `APPLY_MEASURED_HEIGHT`, the `height: 'auto'` widening of `SET_NODE_GEOMETRY` and its server-side schema, the store action, and load-time normalization + materialization. Heights now exist in the store, but the note still renders from its own measurement. Verifiable by asserting `style.height` is numeric for every note after load, and that a measurement commit adds no undo entry.

**Step 3 — Inversion.** Note body switches to `h-full`; all eight mode checks move to `resolveHeightMode`; `heightMemory` guard added; `setNoteHeightMode` dispatches `SET_NODE_GEOMETRY` with `height: 'auto'` instead of clearing the height. Rendering stops being a cause of geometry change. What remains is a bounded, at-most-once-per-content-change correction — Bar A is close but not yet met, because corrections can still land mid-gesture.

This step also carries the one user-visible consequence of the model: because a resize gesture on an auto note pins it to `fixed`, the toolbar's auto/fixed indicator **must** flip at resize end. Ownership was previously invisible because it had no representation; now that it is a stored fact, leaving it unshown produces the worst version of this feature — a note the user believes is auto-sizing and which silently stopped. Treat the indicator as part of Step 3, not as polish.

**Step 4 — Gating.** Commit queue with quantization, threshold, and gesture suspension. Drop `deferredFitFrameIds` for note auto-height. **Bar A is met here** and should be locked down with the automated assertions below.

**Step 5 — Prewarming.** Implement `offscreen` behind the existing `HeightMeasurer` interface with the D10 protocol, the viewport-priority queue, and the keyed cache. Store and engine are untouched by this step, which is the point of D7. **This is the step that approaches Bar B**, and it is sequenced before sync isolation deliberately: making corrections rare shrinks the blast radius of everything Step 6 has to isolate.

**Step 6 — Sync isolation.** Value-aware structure diffing for auto `style.height` and `data.autoHeight`, the per-batch derived marker in the executor (so a refit caused by a derived batch does not bump the version or broadcast), the derived-geometry endpoint and its batching queue, and re-materializing rather than trusting inbound deltas. This is the rest of the D9 work and it is the prerequisite for enabling multi-user co-editing on canvases containing auto notes.

**Step 7 — Unification.** Retire `resizeEndClearHeight`, delete `data.measuredHeight`, drop the measurement hint on type conversion, and fold the contract into `docs/architecture/`.

Steps 1–4 deliver Bar A. Step 5 delivers Bar B and is required, not optional. Step 6 must land before, or together with, multi-user co-editing. Step 7 is the maintainability payoff and can be scheduled independently.

### What actually shipped

Steps 1–5 shipped as written, with three corrections found in use, all of the same shape — the box being measured was not the box the browser laid out. The node shell's 3px border was missing from the layout height, then missing from the content _width_ (which also made the intrinsic height depend on node width, breaking the premise that lets a hint be cached at all), and a leading heading's top margin collapsed out of the measured element. Each is now covered by the invariant in [node-auto-height.md](../architecture/node-auto-height.md) §10.

Two decisions changed under contact:

- **No `HeightMeasurer` interface.** The offscreen measurer is a concrete module and the mounted note measures inline. A second implementation would be the thing that justifies the interface, and `text` / `question` did not become one.
- **Fixed → auto measures on demand.** D8 assumed the toggle could materialize from a stored hint, but a pinned note has none — and measuring one in its pinned box produces a hint that is _self-confirming_, since materializing it yields exactly the number the next measurement is compared against. The toggle measures offscreen and lands both commands in one batch instead.

Of Step 7, everything except the `text` / `question` move has shipped. That move is **deferred and needs its own proposal**: those types auto-size their _width_, carry scale as `data.style.fontSize` rather than a transform, and measure synchronously via canvas 2D with no DOM. The likely conclusion is that they should materialize `style.height` **without** a hint at all — a hint exists to make an expensive asynchronous measurement cacheable, and theirs is neither. Forcing them onto `AutoHeightHint` would require `fontSize` and `width` in the key, which is exactly how a self-confirming wrong value gets built.

## Validation

Automated:

1. `style.height` is numeric for every note after load, after mode toggles, after undo/redo, and after type conversion. Assert as an engine-level invariant.
2. LOD transitions and virtualization remount produce zero change in `getNodeSize` output.
3. A measurement correction produces one state commit covering the node and all affected hug/structured frame ancestors, with no intermediate disagreeing frame.
4. `APPLY_MEASURED_HEIGHT` creates no undo entry, and an undo of an unrelated action does not revert a committed auto height to a stale value.
5. Fixed → auto → fixed restores the remembered user height; auto heights never enter the height memory.
6. `note → text → note` conversion preserves mode and produces a valid height at each step.
7. Corrections are suppressed while a gesture is active and flush exactly once on settle.
8. Grid layout and snapping receive non-zero heights for never-rendered auto notes — a regression fixed incidentally, since `getNodeSize` previously returned `0` for them.
9. A burst of `APPLY_MEASURED_HEIGHT` commits on nodes with no frame parent produces zero `canvas.version` increments, zero structure PUTs, and zero broadcast `update` events. For nodes inside a hug frame, a correction that does not change the frame's fitted box likewise produces none, because `fitFrameToChildren` short-circuits.
10. Changing a node's content invalidates its hint: `readAutoHeightHint` reports `stale` and the node is enqueued for re-measurement, including when the content change arrived from a remote agent while the node was offscreen.
11. Bumping `HEIGHT_LAYOUT_VERSION` invalidates every stored hint on the next load.
12. An inbound delta carrying an auto node's `style.height` does not move local geometry; the value is re-materialized from the local hint.
13. A measurement in flight does not suppress or conflict with a concurrent remote content update to the same node, and does not mark the node dirty.
14. Converting a note to another node type clears `data.autoHeight` rather than leaving a hint measured at the previous type's reference width.
15. Load-time normalization writes `heightMode` but never `data.autoHeight`: a note carrying only the legacy `data.measuredHeight` reports `missing`, and no code path produces a hint that was not measured.
16. Two measurements whose intrinsic heights differ by less than the quantization step produce the same committed `style.height`, and the second produces no write at all.
17. A derived batch that _does_ change a parent hug frame's fitted box still produces zero `canvas.version` increments and zero broadcasts, while a batch mixing an authored command with a derived one produces exactly one, as an authored write.
18. A resize gesture on an auto note leaves it `fixed` and the toolbar indicator reflects that at gesture end.

Instrumented (Bar B):

19. The share of `APPLY_MEASURED_HEIGHT` commits landing on a currently-visible node trends to zero as the prewarm queue drains. This is the Bar B metric; it is reported, not asserted, since a cold start legitimately starts above zero.

Manual: pan and zoom across a canvas containing notes that have never been viewed, with the frame inspector open, confirming frames do not resize as nodes enter the viewport. Two clients open on the same canvas: edit a note in one while the other holds it offscreen, then bring it into view in the second client and confirm a single settled correction rather than a jump plus a conflict toast.

## Risks and open questions

**Save amplification.** This was the strongest objection to making `style.height` authoritative, and D9 answers it for the node's own height: it leaves the version-bumping structure diff and persists through its own lossy channel. Two residual risks remain. The derived-geometry queue can itself become chatty — it must coalesce per node and be rate-limited independently of the structure autosave, and the `provisional` flag must not cause a write-per-image-load storm on media-heavy notes. And until the per-batch derived marker lands in Step 6, corrections on framed notes still produce structural writes; the mitigation in the meantime is prewarming (Step 5) landing first, so that by the time multi-client sync matters, corrections are rare.

**Frame geometry is authored in storage but derived in practice.** The per-batch derived marker stops a derived correction from _propagating_ through a hug frame, but it does not make a frame's box a derived value. A `hug` frame and a `manual` frame are still stored, versioned, and reconciled identically, distinguished only by a field the engine reads and the storage layer does not. The full resolution is recorded in [derived-frame-geometry.md](../backlog/derived-frame-geometry.md); it is deliberately not scheduled, because the migration risk exceeds the present benefit.

**Late-decoding media blocks Bar B.** A note containing an image of unknown intrinsic size cannot reach its final height until that image decodes. Offscreen prewarming can force the decode, but a client with a cold HTTP cache cannot do so before the user arrives. Closing this needs intrinsic media dimensions persisted alongside the height hint — an open question, deliberately out of scope.

**A second persistence path.** D9 introduces a write channel that bypasses `canvas.version`, which means it also bypasses the guarantee that the canvas file has one writer at a time. It must go through the existing write coordinator rather than around it, and it must be safe to drop under contention — which it is, since the cost of a lost hint is one re-measurement.

**Two writers of the same field.** After D1, both the resize gesture and the measurement queue write `style.height`. `resolveHeightMode` is the arbiter, and a resize gesture on an auto note switches the node to `fixed`, matching current behaviour where dragging the handle pins a height. Because that flip is implicit, surfacing it in the toolbar is a Step 3 requirement rather than a suggestion.

**Width changes rescale content.** Because note content is transform-scaled by `width / refWidth`, a width-only resize changes the required height. The commit must be re-evaluated at resize end for auto notes.

**Cross-client measurement divergence.** Two clients with different font availability may compute different intrinsic heights for the same `measuredFor` key. D9 makes this harmless rather than impossible: the persisted hint is advisory, each client materializes locally, and the 4 px quantization collapses minor divergence to the same committed value. The residual case is a divergence larger than one step that also changes parent frame geometry. The per-batch derived marker keeps that from broadcasting, but each client then holds a slightly different frame box until an authored write settles it. If that becomes visible in practice, the step size is the first tuning knob and [derived-frame-geometry.md](../backlog/derived-frame-geometry.md) is the second.

**Offscreen fidelity.** Step 5's measurement must equal the in-place measurement for the same content, or it should not be enabled. Shadow mode was considered and not built: the two surfaces instead share the box that produces the number — the same host classes and the same `readNoteIntrinsicHeight` reader — which is a structural guarantee rather than an empirical one, and it fails loudly (a compile error) rather than as drift. The empirical residue is bounded anyway, because an offscreen measurement is only ever used for a node that would otherwise have no measurement at all, and the in-place measurer overwrites it the moment the user arrives.

## Relationship to the stable-geometry proposal

[note-auto-height-stable-geometry.md](./note-auto-height-stable-geometry.md) targets the same symptom and was written independently. The designs agree on more than they disagree: both introduce an explicit `heightMode`, both keep the server out of layout, both identify `onlyRenderVisibleElements` as the reason a visible-only measurer is insufficient, and both conclude that a **single hidden Milkdown worker** is the right measurement mechanism rather than a second renderer.

**Adopted from it.** Three of its mechanisms were genuinely stronger than this proposal's first revision and are now folded in as D8–D10: the revision-keyed measurement identity (`contentRevision` via `nodeRevisionOf`), `layoutVersion` as a global cache invalidator, and the bounded stability protocol with `provisional` results. Its insistence that derived-geometry persistence must be freshness-checked rather than blindly overwriting also shaped D9. Its `freshness` return value is preserved in `readAutoHeightHint`.

**The remaining disagreement** is a single decision: where the layout height lives.

That proposal keeps canonical data with _no_ canonical height and introduces a **render projection** plus a `resolveEffectiveNoteHeight(node, layoutVersion)` resolver that every geometry consumer must call. It explicitly rejects storing auto height in `style.height` on the grounds that this conflates renderer-owned and user-owned geometry.

This proposal materializes the hint into `style.height` and expresses ownership with `heightMode`. The reasoning:

- The conflation objection is answered by D2 plus D8. Ownership is a dedicated field, and provenance is a dedicated hint. The presence of a number never implies ownership in either design; the difference is only whether the number exists where consumers already look.
- No projection seam exists to build on. In [`Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx) the Zustand node array _is_ the React Flow node array — the only transform between them adjusts `zIndex`, `className`, and `draggable`. More importantly, the canvas engine (`fitFrames`, the grid solver, alignment, portal placement) reads store nodes directly and never passes through that transform, and it also runs headless on the server. A render projection can therefore only cover the React Flow half; the engine half would still need the resolver threaded through every call site.
- A projection means two numbers exist for the same node and every consumer must be taught which one to ask for. The existing `getNodeSize` priority bug is exactly this class of mistake. Materializing once removes the class; resolving per read preserves the conditions for it.
- Rollout risk differs materially. That proposal's first geometry improvement lands in its Phase 4, behind a shadow-mode worker and a persistence contract. Here rendering stops driving geometry at Step 3 and Bar A is met at Step 4, with the worker following at Step 5, because D1–D3 convert measurement error from a correctness failure into a cosmetic one. Under a committed multi-user roadmap this ordering matters more, not less: the sync-isolation work is easier to reason about once geometry has already stopped moving on its own and corrections have become rare.

The two should not both be implemented. With D8–D10 folded in, this proposal now covers the freshness and multi-client concerns that previously argued for the other one, and differs from it only in storage placement and sequencing.

## Code entry points

| File                                                                                                                                     | Current responsibility                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/shared/src/canvas-engine/utils/nodeSizes.ts`](../../packages/shared/src/canvas-engine/utils/nodeSizes.ts)                     | `getNodeSize` (prefers `measured` over `style`), the two auto-height type sets, `getNodeCreationStyle`.                                         |
| [`packages/shared/src/canvas-engine/commands/setNodeGeometry.ts`](../../packages/shared/src/canvas-engine/commands/setNodeGeometry.ts)   | `heightCleared` branch, `measured` mirroring, `deferredFitFrameIds` emission.                                                                   |
| [`packages/shared/src/canvas-engine/commands/changeNodeType.ts`](../../packages/shared/src/canvas-engine/commands/changeNodeType.ts)     | `targetKeepsHeight` on type conversion.                                                                                                         |
| [`packages/shared/src/types/canvas/node.ts`](../../packages/shared/src/types/canvas/node.ts)                                             | `BaseNodeData`, `NodeStyle`, and the `measuredHeight` cache field.                                                                              |
| [`apps/web/src/components/Nodes/note/NoteNode.tsx`](../../apps/web/src/components/Nodes/note/NoteNode.tsx)                               | `hasFixedHeight`, deferred hydration gate, `.ProseMirror` measurement, auto-mode inline height.                                                 |
| [`apps/web/src/components/Nodes/note/autoHeight.ts`](../../apps/web/src/components/Nodes/note/autoHeight.ts)                             | Auto-height minimum and fixed-height seeding policy.                                                                                            |
| [`apps/web/src/components/Nodes/note/heightMemory.ts`](../../apps/web/src/components/Nodes/note/heightMemory.ts)                         | Session-scoped remembered fixed height; records any numeric `style.height`.                                                                     |
| [`apps/web/src/components/Nodes/NodeWrapper.tsx`](../../apps/web/src/components/Nodes/NodeWrapper.tsx)                                   | `hasFixedNodeHeight` layout branch, `resizeEndClearHeight`, `OverlayPortal` FLIP-on-transition — the marker this proposal declines to overload. |
| [`apps/web/src/components/Nodes/shared/nodeHydrationScheduler.ts`](../../apps/web/src/components/Nodes/shared/nodeHydrationScheduler.ts) | One-heavy-mount-per-frame grant queue; the model for the idle measurement queue.                                                                |
| [`apps/web/src/components/Panels/Canvas/Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx)                             | `onlyRenderVisibleElements` — the reason offscreen nodes cannot self-measure.                                                                   |
| [`apps/web/src/hooks/useNodeScale.ts`](../../apps/web/src/hooks/useNodeScale.ts)                                                         | `REF_WIDTHS`, folded into the height-policy registry.                                                                                           |
| [`apps/web/src/hooks/useTextAutoSize.ts`](../../apps/web/src/hooks/useTextAutoSize.ts)                                                   | Text/question sizing: canvas-2D measurement, `fontSize` locking, legacy height migration.                                                       |
| [`apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                                           | `setNoteHeightMode`, `patchNodeSilent`, geometry dispatch.                                                                                      |
| [`apps/web/src/store/canvasStore/save/structureDirtyDetector.ts`](../../apps/web/src/store/canvasStore/save/structureDirtyDetector.ts)   | `NODE_TOPLEVEL_IGNORE` (contains `measured`) and the structure-save gate.                                                                       |
| [`apps/web/src/handler/canvasCommand/postEffects.web.ts`](../../apps/web/src/handler/canvasCommand/postEffects.web.ts)                   | Double-rAF deferred frame refit that Step 4 retires for note auto-height.                                                                       |
| [`packages/shared/src/canvas-engine/change.ts`](../../packages/shared/src/canvas-engine/change.ts)                                       | `nodeRevisionOf` — reused as the measurement freshness key in D8.                                                                               |
| [`apps/web/src/store/canvasSyncStore.ts`](../../apps/web/src/store/canvasSyncStore.ts)                                                   | SSE delta application and dirty-node filtering; where D9's re-materialization rule lands.                                                       |
| [`apps/server/src/modules/canvas/canvas.route.ts`](../../apps/server/src/modules/canvas/canvas.route.ts)                                 | Structure PUT, version bump, and broadcast — all of which the derived-geometry channel must avoid.                                              |
| [`apps/server/src/modules/storage/write-coordinator.ts`](../../apps/server/src/modules/storage/write-coordinator.ts)                     | Single-writer coordination the derived-geometry write must go through, not around.                                                              |
