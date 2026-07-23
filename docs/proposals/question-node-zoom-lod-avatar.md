# Question Node Zoom LOD — Avatar Takeover

Status: Shipped — **continuous-`t` takeover**. (This project went binary V1 → discrete three-stage → and finally landed on the continuous-`t` engine that the "V2" section below first explored. The intermediate three-stage design was itself superseded — see "What actually shipped".)
Last updated: 2026-07-23

## Finalized proposal — playground avatar takeover

The zoom-LOD lab in [`AgentNodePlaygroundPage.tsx`](../../apps/web/src/pages/playground/AgentNodePlaygroundPage.tsx) is the visual design source for the shipped Question-node takeover. Its first section is now the 1:1 finalized executable reference and imports the production takeover math plus `QuestionTakeoverMark`; the earlier copied implementation remains immediately below it as proposal history. The final proposal is: preserve one persistent Agent mark across the entire zoom range, derive its geometry continuously from the Question node's live screen dimensions, and let that mark replace the unreadable card at deep zoom-out. The architecture reference in [canvas-zoom-rendering.md §3.1](../architecture/canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node) remains authoritative when this historical proposal and the implementation differ.

### Final behaviour

1. **One mark, continuously transformed.** The readable corner badge and collapsed stand-in are not separate renderers. `collapseProgress(screenWidth)` produces a smoothstep-eased $t \in [0,1]$ over the 64 px → 24 px screen-width band; the mark's position is `lerp(corner, centre, t)` and its size is `lerp(readableBadgeSize, collapsedMarkSize, t)` on every zoom frame.
2. **The card and mark have separate responsibilities.** The mark's size and position are continuous, while the card body uses a hysteretic `readable | collapsed` cutover around 64 px. The cutover fades the whole node shell to zero opacity over 200 ms but intentionally retains the invisible node footprint for canvas selection and double-click activation; the discrete body stage never changes mark geometry.
3. **Readable badge size follows the card.** At the readable endpoint, badge diameter is 28% of the node's shorter on-screen side, clamped to 30–84 px. This retains the playground's principle that the Agent identity belongs to the card rather than remaining a fixed-size sticker on every zoom level.
4. **Collapsed size follows a concave curve.** At the collapsed endpoint, mark diameter follows the node's shorter on-screen side with gamma $0.7$, bounded to 6–30 px. The curve leaves the floor quickly and flattens near the readable badge floor, avoiding both a deep-zoom crowd of large chips and a visible size pop during takeover.
5. **Glyph detail is size-driven.** A mark at or above 7 px renders the full Agent avatar; below 7 px it becomes a solid identity-colour dot. This is visual LOD inside the mark, not another node stage.
6. **Status survives collapse.** Open, running, done, error, unread, and conflict treatments use the same status-chrome resolver across the zoom range. The `open` state keeps the shared speech bubble; running keeps the identity-coloured activity ring; terminal attention states retain their ring/halo semantics while the conflict counter is omitted once the node is collapsed.
7. **Interaction remains node-owned.** The mark owns single-click conversation opening and its hit-area policy. The overlay only positions the mark and forwards the existing semantics-free double-click activation.
8. **No collapsed caption in the final scope.** The playground's delayed title-caption sequence is intentionally not shipped. At deep zoom, the identity mark alone is the Question node's minimal representation; this avoids duplicate text during takeover and keeps dense canvases quiet.

### Playground decisions retained, adjusted, and deferred

- **Continuous corner → centre re-anchoring:** retained, with smoothstep easing and live screen-space geometry.
- **Avatar size follows node size on a concave curve:** retained, split into readable-badge and collapsed-mark endpoint curves.
- **Full avatar → silhouette → identity dot:** adjusted to full avatar → dot at the current tiny 7 px threshold; there is no separate silhouette band in the Question takeover.
- **Representative size $\sqrt{w \cdot h}$:** adjusted so takeover progress uses screen width while endpoint sizes use the shorter screen side, matching the card's limiting dimension.
- **150 px → 66 px takeover band:** retuned to 64 px → 24 px after integration on the real canvas.
- **Avatar range 14–88 px:** retuned so the readable badge is 30–84 px and the collapsed mark is 6–30 px.
- **Card opacity fades continuously during early takeover:** adjusted to one hysteretic body-visibility cutover; only mark geometry remains continuous.
- **Caption appears after card fade, then disappears near dot size:** deferred; no caption is rendered in the shipped scope.
- **Shared status rings, bubble, avatar art, and identity dot:** retained and extracted into shared production components/configuration.

### Acceptance criteria

- Zooming through either end of the takeover band produces no positional snap, size pop, duplicate mark, or resting half-opacity card; the transparent node footprint intentionally remains selectable.
- At $t=0$, the mark is the normal readable corner badge; at $t=1$, its centre exactly matches the node's screen-space centre.
- Pan, node movement, resize, wheel zoom, and pinch zoom all resolve the mark from current geometry rather than replaying a one-shot animation.
- Dense deep-zoom views reduce Question nodes to bounded identity marks, with tiny avatars degrading to clean dots rather than muddy glyphs.
- The heavy Question body does not subscribe to continuous zoom updates; only the small takeover overlay re-renders.
- Adding another takeover client remains deferred until a second node type needs it; the current implementation stays question-tuned rather than introducing a speculative registry.

## What actually shipped (continuous-`t` takeover)

The authoritative description now lives in [canvas-zoom-rendering.md §3.1](../architecture/canvas-zoom-rendering.md#31-continuous-zoom-takeover-question-node) and [question-node.md §5.1](../architecture/question-node.md). Summary of the final design:

- **Continuous morph, not discrete stages.** The mark's size and position are a smoothstep-eased function of the node's on-screen width (`collapseProgress` → `t ∈ [0,1]`): the badge glides corner → centre and resizes badge → mark in lock-step with the zoom gesture. The earlier three-stage design (with a one-shot FLIP between crisp resting stages) was dropped because the stage swap + decoupled FLIP felt abrupt; the continuous geometry tracks the gesture with no snap. The static-in-between-frames worry that motivated discrete stages did not materialise in practice.
- **The card fade is still binary** (`data-lod-body` attribute), derived from a two-value `readable | collapsed` stage (`resolveQuestionStage`, with hysteresis) that governs body visibility + chrome ONLY — never the mark's size/position.
- **The glyph is size-driven, not a stage.** Full avatar down to `MARK_FACE_MIN` px, then a solid identity dot.
- **The `open` chat bubble is a shared component** ([`QuestionAgentBubble`](../../apps/web/src/components/Nodes/question/QuestionAgentBubble.tsx)) reused by both the readable corner badge and the takeover mark. Its avatar is geometrically centred on the bubble's circular body, then receives a tiny proportional optical correction so the artwork reads centred at every zoom without a fixed-pixel nudge overwhelming small marks.
- **Files:** [`config/nodeTakeover.ts`](../../apps/web/src/config/nodeTakeover.ts) (`collapseProgress`, `badgeSizeForNode` / `collapsedMarkSize`, `resolveQuestionStage`, `lerp`, sizes), [`hooks/useNodeTakeover.ts`](../../apps/web/src/hooks/useNodeTakeover.ts) (`{ stage, size, point, collapsedRadius }`, interpolated by `t`), [`components/Nodes/NodeTakeoverLayer.tsx`](../../apps/web/src/components/Nodes/NodeTakeoverLayer.tsx) (continuous positioning, binary card fade — no FLIP), [`components/Nodes/question/QuestionTakeoverMark.tsx`](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx) (the one badge across the whole range), [`components/Nodes/question/QuestionAgentBubble.tsx`](../../apps/web/src/components/Nodes/question/QuestionAgentBubble.tsx) (shared bubble).
- The generic-engine ambition (any node type opts in) is **deferred, not built** — the staging math is question-tuned for now.

> The sections below record the earlier V1 (binary) and the explored "V2" continuous-engine design for history. They do **not** describe the shipped code; treat "What actually shipped" above + the architecture docs as authoritative.

## Decisions (locked)

- **Reuse the LOD infrastructure, independent minimal representation** — question opts into the shared `full ↔ minimal` boundary but supplies its own minimal payload (the agent avatar) instead of the generic title label.
- **V1 = binary boundary + cross-fade**, not a hand-rolled continuous `t`. The continuous corner→centre morph is deferred to V2; the coordinate model is chosen up front so V2 is additive (swap the cross-fade for an interpolation), not a rewrite.
- **Keep the dot floor, accept a small symmetric overhang.** The avatar rides a curve with a 14 px floor; at the deepest zoom-out it can sit slightly larger than a vanishing node (bounded, centred). We do NOT clamp it to the node footprint — that would defeat the stand-in.

## V1 — what shipped

- Shared avatar-LOD primitives: [`config/agentAvatarLOD.ts`](../../apps/web/src/config/agentAvatarLOD.ts) (`avatarSizeForNode`, detail tiers, `resolveAvatarDetail`) and [`AgentAvatarMark`](../../apps/web/src/components/Common/AgentAvatarMark.tsx) (dot / silhouette / full for both agent kinds). `BuiltInAgentAvatar` gained `showFace`.
- `question` opted into [`SEMANTIC_ZOOM_CONFIG.nodeLOD`](../../apps/web/src/config/semanticZoom.ts); `NodeWrapper` gained a generic `minimalContent` slot rendered in the existing cross-fade layer.
- [`QuestionMinimalAvatar`](../../apps/web/src/components/Nodes/question/QuestionMinimalAvatar.tsx) renders the centred stand-in (counter-scaled `1/zoom`, purely visual); status chrome is shared with the corner badge via [`questionBadgeChrome.ts`](../../apps/web/src/components/Nodes/question/questionBadgeChrome.ts). Idle question nodes (no agent status) fall back to the generic title-label placeholder.

## V2 — generalized continuous takeover

V2 turns the binary cross-fade into a **continuous corner→centre morph** and, per an explicit product requirement, makes it a **reusable engine any node type can opt into** — not question-specific. Question is the first client; a text node (title → glyph), a PDF (page → thumbnail dot), etc. should later opt in by supplying a "mark" + a band, with **zero engine changes**.

### The unifying idea

Today the corner badge (full) and the centred stand-in (minimal) are two separate elements swapped by a cross-fade. V2 makes them **one persistent element** whose position, size, detail, and the card's opacity all interpolate on a single takeover factor `t ∈ [0,1]` derived from the node's on-screen size:

- `t = 0` (readable) → the mark sits at its full-state anchor (the corner, constant screen size) — pixel-identical to today's corner badge.
- `t → 1` (small) → the mark slides to the node centre, rides the size curve toward a dot, the card fades out, and the caption eases in after the card is gone (the playground's `captionIn` sequencing).

One element across the whole range = the "shared-element transition" flagged in V1, and it removes the badge/stand-in duplication.

### Locked decisions

- **Coordinate space: screen-space.** The mark lives in a screen-space overlay (like today's badge `OverlayPortal`), positioned from the node's transformed corner and centre. Everything is screen px; there is no `1/zoom` counter-scaling. (V1's counter-scaled in-node approach is retired.)
- **Driver: representative size `√(w·h)`.** `t` and the size curve are both driven by the node's on-screen representative size, so wide-short and tall-narrow nodes behave identically. The `band` is expressed in rep-size px.
- **Contract split: engine owns geometry, the node owns pixels.** The engine's shared vocabulary is deliberately type-agnostic — it never names `AvatarDetail`, a resolved `size`, or a pixel range. It exposes only `t` (takeover factor), `p` (eased progress), `representativeSize` (the node's on-screen √(w·h)), the two screen anchors, and the visibility/opacity signals. Everything visual — the avatar's `[14, 88]` size curve, the `dot | silhouette | full` detail tiers, the status chrome — stays inside `QuestionTakeoverMark` and `agentAvatarLOD.ts`.
- **Anchor is a local spec, not an absolute point.** `fullAnchor` cannot be a screen `Point` — an absolute screen coordinate is invalid the moment the canvas pans/zooms or the node moves, so it can never live in a memo-stable descriptor. The node supplies a _relative_ anchor spec (which node corner, which mark origin, a fixed px offset); the engine resolves it to the live screen `anchorPt` each frame from the node's transformed rect, and fixes ONE interpolation reference (the mark's centre) so `lerp(anchorPt, centrePt, t)` never drifts by half a mark.
- **Size is `lerp(fullSize → minimalCurve)`, not the raw curve.** At `t = 0` the mark must equal today's 36 px badge exactly; the shared `avatarSizeForNode` curve spans `[14, 88]` and does NOT pass through 36. So the mark computes `size = lerp(fullSize, minimalSizeForRepresentativeSize(repSize), p)` with `fullSize = 36`; only after takeover begins does it ride the avatar curve. Pixel parity at `t = 0` is a hard requirement, not tuning.
- **Interaction: the engine has zero interaction vocabulary.** The engine does not know what "clickable", "a conversation", or "open" mean. The mark is rendered by the node (`renderMark`), so it owns its own single-click behaviour (e.g. open the conversation) with its own `onClick`, and reads its own hover/selected gating straight from the store — React events work inside the portal, so no engine "wiring" is needed and the retired `.react-flow__node:hover` descendant selector is not required. The engine only offers ONE optional, semantics-free `onActivate` that the overlay fires on a double-click of the mark container; `NodeWrapper` points it at the node's existing activate handler (the same one the shell double-click uses), so the engine never learns what activation _does_. The container is `pointer-events: none` by default and the mark opts its own sub-region into `pointer-events: auto` — a pure hit-area concern, not a business policy.

### Module boundaries (single responsibility · must-not-know)

| Module                                              | Owns (only)                                                                                                                                                                                                                       | Must NOT know                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `config/nodeLOD` (registry)                         | `mode: binary \| continuous`, `band`                                                                                                                                                                                              | any node's visuals, anchors, sizes, colours               |
| `lodCurve` (pure math)                              | rep-size + band → `t`; `t` → eased `p ∈ [0,1]`; `bodyOpacity(t)`, `bodyInteractive(t)`, `captionOpacity(t)`                                                                                                                       | pixels, node types, the DOM                               |
| `useNodeTakeover(nodeId, { band, anchor })`         | self-subscribe to zoom + node rect; return `{ t, p, representativeSize, anchorPt, centrePt, bodyOpacity, bodyInteractive, captionOpacity }`                                                                                       | what the mark looks like; its size in px; its detail tier |
| `NodeTakeoverLayer` (overlay)                       | position the mark container `lerp(anchorPt, centrePt, t)`; publish `--lod-body-opacity` **and** a discrete `data-lod-body='hidden'` on the node root; render the mark + caption container; wire `onActivate` + interaction policy | the mark's internals; its size/detail; the card's markup  |
| `.semantic-lod-content` (card)                      | `opacity: var(--lod-body-opacity, 1)`, and when `data-lod-body='hidden'`: `pointer-events:none; visibility:hidden`                                                                                                                | that a takeover engine exists                             |
| `NodeWrapper`                                       | pick ONE of `<BinaryPlaceholder>` / `<NodeTakeoverLayer>`; expose a stable root ref for the CSS var/attr; pass the node's stable descriptor + `onActivate`                                                                        | takeover math or positioning                              |
| node's `TakeoverMark` (e.g. `QuestionTakeoverMark`) | derive `size` from `fullSize` + `representativeSize` + `p`, derive `detail`, draw itself + status chrome                                                                                                                          | where it is on screen; the card; caption sequencing       |

The decoupling fixes baked into the table above, explicitly:

- **(A)** the relative anchor spec (which corner, which mark origin, px offset) and `fullSize` live in the node's descriptor/mark, never the central registry — and the anchor is relative, resolved to a live screen point by the engine.
- **(B)** the card fade is driven _only_ by `NodeTakeoverLayer` via one CSS var **plus** a discrete `data-lod-body` attribute; `NodeWrapper` and the card markup compute nothing. The attribute restores `pointer-events:none` + `visibility:hidden` once the body has faded, so a fully-transparent body can never still capture clicks or hold focus.
- **(C)** the mark render-prop receives type-agnostic engine signals (`t`, `p`, `representativeSize`) only — never a resolved pixel size, detail tier, or position; the mark owns the size/detail math.
- **(D)** the engine has no interaction vocabulary: the mark (business) owns its own `onClick` + hover/selected gating (read from the store, not from DOM ancestry); the engine exposes only one semantics-free `onActivate` (double-click passthrough) wired by `NodeWrapper` to the node's existing activate handler. No `markActivation`/`markInteractive`, no cross-tree DOM bubbling.
- **(E)** `lodCurve` yields a normalised `p ∈ [0,1]`; the per-type mark maps `p` (blended with `fullSize`) to its own pixel range (avatar's `[14, 88]` stays in the question/avatar layer).
- **(F)** the heavy node body is already isolated today: `QuestionNode`/`NodeWrapper` are both `memo`, the body is passed as a stable `children` element, and it does not subscribe to zoom — so continuous zoom re-renders only the small mark/overlay (exactly as today's badge does), not the body. `useNodeTakeover` self-subscribes and `NodeTakeoverLayer` is memoised so this stays true; no extra body-isolation refactor is required. _(Downgraded from a blocker after review — see "Review corrections".)_

### Node contract (stable seam)

```ts
// Engine-owned, type-agnostic signals handed to the mark/caption render props.
interface TakeoverState {
  t: number; // takeover factor [0,1] from rep-size + band
  p: number; // eased progress [0,1]
  representativeSize: number; // node on-screen √(w·h), px — the mark sizes itself from this
}

// A RELATIVE anchor spec; the engine resolves it to a live screen point.
interface MarkAnchorSpec {
  nodeCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  markOrigin: 'top-left' | 'centre';
  offsetPx: { x: number; y: number };
}

// Supplied by the node to NodeWrapper — presentation only.
interface NodeTakeoverProps {
  descriptor: { band: Band; anchor: MarkAnchorSpec }; // policy + geometry only
  renderMark: (s: TakeoverState) => ReactNode; // node owns size/detail/chrome AND its own onClick
  renderCaption?: (s: TakeoverState) => ReactNode; // node owns text; engine owns container fade/position
  onActivate?: (e: React.MouseEvent) => void; // semantics-free double-click passthrough only
}
```

`descriptor`, `renderMark`, and `renderCaption` must be memo-stable (or perf isolation breaks — see F). The engine hands the mark only `{ t, p, representativeSize }` — never a resolved `size` or `AvatarDetail` — so a non-avatar client (PDF thumbnail, text glyph) needs no engine change. It has **no** interaction vocabulary (`markActivation`/`markInteractive` were removed as over-coupling): the mark owns its own click and gating.

### Question migration

Fold `QuestionAgentBadge` + `QuestionMinimalAvatar` into one `QuestionTakeoverMark({ t, p, representativeSize })`: at `t = 0` it renders exactly today's corner badge (`fullSize = 36 px`, all status chrome), and as `t → 1` it becomes the centred avatar + caption. It derives its own pixel size as `lerp(36, avatarSizeForNode(repSize), p)` and its own `AvatarDetail` via `resolveAvatarDetail(size)` — the engine never sees either. It also owns its own click-to-open behaviour and its hover/selected gating (read from the store), so no engine interaction props are involved. Delete question's binary `minimalContent` branch. The shared `questionBadgeChrome` + `AgentAvatarMark` are reused unchanged.

### Extensibility checklist (definition of done)

- Adding a node type = one `continuous` registry entry (`mode` + `band`) + one `TakeoverMark` + a descriptor. **No edits to `lodCurve`, `useNodeTakeover`, `NodeTakeoverLayer`, or `NodeWrapper`.**
- The engine owns `t`/positioning/card-fade (opacity **and** the `pointer-events`/`visibility` cutover)/caption-container-sequencing/perf; the type owns only its mark visual, its own `fullSize → curve` pixel mapping, and its detail tiers.
- The engine never references `AvatarDetail`, `avatarSizeForNode`, or any avatar constant — proof the seam is type-agnostic.
- Binary LOD (title-label) stays available for types that don't want a morph.

### Risks / watch-items

- **Full-state pixel parity**: at `t=0` the question mark must equal today's badge exactly — snapshot before/after.
- **Edge smoothing** at the band ends so the mark doesn't pop when crossing `t≈0/1`.
- **Overhang policy** stays as decided (floor + small symmetric overhang; do not clamp to the node footprint).
- **Body interactivity cutover**: opacity alone is not enough — the faded card must also drop `pointer-events`/`visibility` (and ideally `inert`/`aria-hidden`) via the discrete `data-lod-body` attribute, or a transparent body still captures clicks and holds keyboard focus.
- **Portal gating**: the screen-space mark is not a `.react-flow__node` descendant, so V1's `.question-agent-badge-hit` hover/selected CSS gating does not carry over. The mark reproduces it by reading `selected`/hover from the store itself — this stays entirely in the mark (business), not the engine.

### V1 → V2 cost

Additive: the mark visuals, size curve, detail tiers, and status chrome all carry over. New work is the engine (`lodCurve` + `useNodeTakeover` + `NodeTakeoverLayer`) and folding the two question elements into one `t`-driven mark. Because the coordinate model and interaction seam are now locked, this is a swap of "binary cross-fade" for "interpolation", not a rewrite.

### Prototype-first

Before touching the real canvas, rebuild the loop in the `AgentNodePlaygroundPage` lab: a screen-space `useNodeTakeover` + `NodeTakeoverLayer` driving one node with a draggable `t`, to lock the feel and the `t=0` pixel parity — then migrate question, then open it to other types.

### Build order (question-first, being implemented)

The lab already proves the feel, so V2 lands directly on the question node without a generic registry:

1. **Pure math** — [`config/nodeTakeover.ts`](../../apps/web/src/config/nodeTakeover.ts): `takeoverFactor(rep, band)`, `easeTakeover` (smoothstep), `takeoverBodyOpacity`, `takeoverCaptionOpacity`, plus `TakeoverBand` / `MarkAnchorSpec` / `TakeoverState` types. Factor `avatarSizeForRep(rep)` out of `avatarSizeForNode`.
2. **Hook** — [`hooks/useNodeTakeover.ts`](../../apps/web/src/hooks/useNodeTakeover.ts): self-subscribes to zoom + node rect, returns `TakeoverState` (screen-space `anchorPt`/`centrePt`, `t`, `p`, `representativeSize`, `bodyOpacity`, `bodyHidden`, `captionOpacity`). Type-agnostic.
3. **Overlay** — [`components/Nodes/NodeTakeoverLayer.tsx`](../../apps/web/src/components/Nodes/NodeTakeoverLayer.tsx): portal into `.react-flow__renderer`, centres the mark at `lerp(anchorPt, centrePt, t)`, writes `--lod-body-opacity` + `data-lod-body` onto the node root ref, renders `renderMark` + `renderCaption`. Mounted only for takeover nodes, so non-takeover nodes gain no hook.
4. **Mark** — [`components/Nodes/question/QuestionTakeoverMark.tsx`](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx): folds badge + stand-in; `size = lerp(36, avatarSizeForRep(rep), p)`, owns its own click + gating.
5. **Wiring** — `NodeWrapper` gains a `takeover` prop + a root ref + `.semantic-lod-content { opacity: var(--lod-body-opacity, 1) }`; `QuestionNode` passes `takeover`, drops the corner `QuestionAgentBadge` + the binary `minimalContent`; `question` leaves the binary `SEMANTIC_ZOOM_CONFIG.nodeLOD` list.
6. **Generalize later** — only when a second node type needs it, lift steps 1–3 verbatim into a shared engine + registry (`mode: continuous`).

### Review corrections

Applied after a code review of this plan against the shipped V1 code:

- **Engine seam is type-agnostic (P1).** Removed `size`/`detail`/`AvatarDetail`/`sizeRange` from the engine's return and contract; the engine exposes only `t`, `p`, `representativeSize`, the anchors, and visibility signals. The avatar `[14, 88]` curve and detail tiers live only in the question/avatar layer, so PDF/text clients need no engine change.
- **`fullAnchor` is a relative spec, not a `Point` (P1).** An absolute screen point can't sit in a memo-stable descriptor; the node supplies a `MarkAnchorSpec` and the engine resolves the live screen point each frame, with one fixed interpolation reference.
- **Size blends from the real `fullSize` (P1).** `t=0` must equal the shipped 36 px badge, which the `[14, 88]` curve does not pass through; the mark uses `lerp(36, curve(repSize), p)`.
- **Body interactivity cutover (P1).** Opacity alone leaves an invisible-but-clickable body; the engine also publishes a discrete `data-lod-body='hidden'` that restores `pointer-events:none` + `visibility:hidden`.
- **Interaction fully decoupled from the engine (P1).** `markActivation`/`markInteractive` were removed — they leaked business concepts ("clickable", "a conversation exists") into a supposedly generic engine. The mark owns its own single-click + hover/selected gating (React events work in the portal; gating reads the store); the engine keeps only one semantics-free `onActivate` double-click passthrough that `NodeWrapper` points at the node's existing handler.
- **Perf claim (F) downgraded from a blocker (was P1 → non-issue).** The original review over-stated this. The heavy body is already isolated: `QuestionNode` and `NodeWrapper` are both `memo` and the body is a stable `children` element that does not subscribe to zoom, so continuous zoom re-renders only the small mark/overlay today. No extra body-isolation refactor is required; the engine just has to keep the overlay memoised.
- **Generalization is deferred, not up-front (P2 · YAGNI).** Building a fully type-agnostic registry + contract for a single client (question) is speculative generality. Recommended build order: implement it question-first (a `QuestionTakeoverLayer` + mark), keep the module boundaries above as the _shape_ to grow into, and only lift the shared `lodCurve`/`useNodeTakeover`/`NodeTakeoverLayer` into a generic engine when a **second** node type (PDF thumbnail, text glyph) actually needs it. The seam is designed so that extraction is mechanical, so nothing is lost by waiting.

> How the `AgentNodePlaygroundPage` "zoom LOD lab" (avatar takeover + identity dot) should land on the real canvas, and how much of the existing node LOD system it should reuse.
> Owner: canvas
> Prototype: [`apps/web/src/pages/playground/AgentNodePlaygroundPage.tsx`](../../apps/web/src/pages/playground/AgentNodePlaygroundPage.tsx) (`QuestionNodeLodLab`, `LodViewport`, `LodAgentChip`, `avatarSizeForNode`).

## 1. Where we are today

The question node's agent avatar ([`QuestionAgentBadge`](../../apps/web/src/components/Nodes/question/QuestionAgentBadge.tsx)) is a **screen-space overlay**: it counter-scales by `1/zoom`, so it stays a constant ~29 px mark pinned at the node's top-left corner (`offset {top:-20,left:0}`) at every zoom. It carries status (open bubble / running ring / unread-done / error / conflict) but does **not** participate in level-of-detail — it neither grows with the node when zoomed in nor becomes the node's stand-in when zoomed out.

The question node is also **not** in the LOD pipeline. [`SEMANTIC_ZOOM_CONFIG.nodeLOD`](../../apps/web/src/config/semanticZoom.ts) opts only `note` / `pdf` / `web` into the binary `full → minimal` flow; everything else is always `full`. That flow ([`useNodeLOD`](../../apps/web/src/hooks/useNodeLOD.ts) → [`NodeWrapper`](../../apps/web/src/components/Nodes/NodeWrapper.tsx) → [`SemanticPlaceholder`](../../apps/web/src/components/Nodes/SemanticPlaceholder.tsx)) switches a node's body for a **tier-sized title label** at a 150 px screen-width boundary with 10 px hysteresis, cross-fading the two via CSS.

## 2. What the playground proposes

As a question node shrinks on screen, its identity avatar smoothly takes over as the node's stand-in:

- the sticky card **fades out**, and the avatar **re-anchors from the corner to the node centre**;
- the avatar **rides a concave size curve on the node's on-screen size** (`avatarSizeForNode`) instead of a constant screen size — bigger when zoomed in, easing toward a dot when zoomed out;
- once the card is gone, a one-line **title caption** appears under the avatar, then fades as the avatar collapses;
- at the bottom the avatar sheds detail in tiers — full face → face-less silhouette (`< 24 px`) → a crisp **solid identity-colour dot** (`< 18 px`, floor 14 px) — so a field of zoomed-out question nodes reads as tidy colour-coded dots.

## 3. The core question: reuse or independent?

**Recommendation: reuse the LOD _infrastructure_, but give the question node its own _minimal representation_.** Not a parallel LOD engine, and not the generic title-label placeholder.

The shipped pipeline and the proposal already agree on the hard parts and differ only on the payload:

| Concern            | Shipped `full ↔ minimal`                       | Playground proposal              | Verdict                                                   |
| ------------------ | ---------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| Trigger            | node screen-width vs 150 px + hysteresis       | node screen-size band            | **Reuse** the boundary + hysteresis                       |
| Size philosophy    | size by `nodeRepresentativeSize` (√w·h)        | avatar rides curve on √(w·h)     | **Reuse** `nodeRepresentativeSize`                        |
| Shell / transition | `NodeWrapper` CSS cross-fade of full ↔ minimal | card fades, avatar takes over    | **Reuse** the cross-fade shell                            |
| Minimal payload    | tier-sized **title label**                     | **agent avatar** + caption + dot | **Independent** renderer                                  |
| Detail tiers       | one label, scales continuously                 | face / silhouette / dot by px    | **New**, but as pure data like `MINIMAL_TYPOGRAPHY_SCALE` |

`SemanticPlaceholder` already branches on `type`, and `SEMANTIC_ZOOM_CONFIG.nodeLOD` is per-node-type render data — this is exactly the extension point the system was designed for. A fully independent implementation would duplicate the threshold/hysteresis/cross-fade machinery and drift from the rest of the canvas; forcing the question node into the title-label placeholder would throw away its whole identity-first point.

Two sub-decisions inside "reuse the infrastructure":

- **Binary boundary + cross-fade for v1, not a hand-rolled continuous `t`.** The shipped binary mode + CSS cross-fade already delivers "card fades / avatar takes over" for free and keeps the question node consistent with note/pdf/web. The valuable, keep-now parts of the playground — the **avatar size curve** and the **detail tiers** — are pure functions of the node's canvas size and need no per-frame React state (the badge already reads `zoom` via `useStore`). The literal corner→centre **slide** and the caption-after-fade **sequencing** are polish; defer them to a v2 rather than build a second animation system.
- **Factor the avatar's LOD + status chrome into shared code** so the corner badge (full) and the centred stand-in (minimal) render from one source of truth, not two.

## 4. Integration plan

### Phase 0 — Extract shared avatar primitives (playground → shared)

Move the reusable, framework-free pieces out of the playground so both the badge and the minimal renderer consume them:

- `avatarSizeForNode` + the `AVATAR_*` tuning constants → a shared config (e.g. `apps/web/src/config/agentAvatarLOD.ts`, or a new section of `semanticZoom.ts`).
- Detail tiers as data: `AVATAR_DOT_MAX = 18`, `AVATAR_FACE_MIN = 24`, `AVATAR_MIN_DOT_PX = 14`, plus a `resolveAvatarDetail(sizePx): 'dot' | 'silhouette' | 'full'` helper (add hysteresis if tiers flicker at the boundaries during pinch).
- A single **`AgentAvatarMark`** wrapper that, given `{ agent, sizePx }`, renders dot / silhouette / full uniformly for both external (`AgentIcon`) and built-in (`BuiltInAgentAvatar`) agents. It owns the solid identity dot (`agentIconColorHex(color)` / built-in Huabu blue) and passes `withFace` / `showFace` through.

Component parity work:

- `AgentIcon`: `withFace` already exists; the **flower-centering fix already shipped** in this branch. Good.
- `BuiltInAgentAvatar`: already centered (`viewBox="14 10.5 92 92"`); **add a `showFace` prop** (mirror the playground's `BuiltInStarBody`) so the silhouette tier can drop the face.

### Phase 1 — Opt the question node into LOD

- Add `question: { full: 'full', minimal: 'minimal' }` to `SEMANTIC_ZOOM_CONFIG.nodeLOD`.
- Give the question node a **type-specific minimal renderer** instead of the title label — either a `type === 'question'` branch in `SemanticPlaceholder` or a dedicated `QuestionSemanticAvatar` mounted in the same shell. It renders `AgentAvatarMark` sized by `avatarSizeForNode(nodeWidth·zoom, nodeHeight·zoom)`, centred, with the optional title caption below.
- `NodeWrapper` already cross-fades `full` ↔ this minimal via `data-lod` + `.semantic-lod-node`; no shell change needed.

### Phase 2 — Reconcile the corner badge with the stand-in

- In `minimal`, hide the screen-space `QuestionAgentBadge`; the centred canvas-space avatar is now the identity.
- The stand-in must still show **status**: running ring, unread/error/conflict halo, and the open bubble. Extract the badge's ring/halo/bubble chrome (currently inline in `QuestionAgentBadge`) into a shared piece the centred avatar reuses, so status is defined once. Map the shipped states (`open | running | done | error` + `unread` + `conflictCount`) onto the shared chrome; the playground's extra demo states collapse to these.
- Preserve interactivity: clicking the stand-in opens the thread (reuse the `question-agent-badge-hit` pointer-gating so a stray canvas click near a tiny node doesn't open the panel).
- Retire the ad-hoc `AI_BADGE_MIN_SCREEN_WIDTH` hide for this node in favour of the LOD tiers.

### Phase 3 (optional) — continuous morph polish

- Shared-element transition for the literal corner→centre slide and a continuous avatar size across the full range.
- Caption-after-card-fade sequencing (the playground's `captionIn` gate) if the cross-fade alone reads as a double line.

## 5. Risks & open questions

- **Full-state size behaviour**: the playground grows the avatar with the node when zoomed _in_ (up to 88 px); today's badge is constant 29 px. Decide whether the corner badge also adopts the curve in the readable range or stays constant until `minimal`. (Recommendation: stay constant in `full`, adopt canvas-space size only in `minimal`, to limit churn.)
- **Status chrome duplication**: Phase 2 only pays off if the ring/halo/bubble logic is genuinely shared; otherwise two copies drift.
- **Tier flicker**: dot ↔ silhouette ↔ face boundaries need the same hysteresis discipline as the node LOD boundary.
- **Interaction target** on a sub-`minimal` node: ensure the hit area stays reasonable when the avatar is a 14 px dot.
- **Other identity surfaces**: `AgentAvatarMark` should be adoptable by the chat panel / profile pickers later, but that is out of scope here.

## 6. Reuse summary

- **Reuse as-is**: `useNodeLOD` boundary + hysteresis, `SEMANTIC_ZOOM_CONFIG` opt-in, `nodeRepresentativeSize`, `NodeWrapper` cross-fade shell, `AgentIcon` / `BuiltInAgentAvatar` art.
- **Extend**: `SemanticPlaceholder`/config with a question-specific minimal; `BuiltInAgentAvatar` with `showFace`; the badge's status chrome into a shared piece.
- **New (shared)**: `avatarSizeForNode`, the detail-tier data + `resolveAvatarDetail`, and the `AgentAvatarMark` wrapper — lifted straight from the playground.
