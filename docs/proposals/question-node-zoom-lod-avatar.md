# Question Node Zoom LOD — Avatar Takeover

Status: Accepted — V1 implemented (V2 continuous morph deferred)

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
- **Config splits policy vs presentation.** The central registry holds only _policy_ (`mode`, `band`); everything _visual_ (`fullAnchor`, `fullSize`, `minSize`, `maxSize`, the mark, the caption) is supplied by the node next to its own code.
- **Interaction: one shared `onActivate`.** The node passes a single `onActivate`; the overlay wires it to the mark (single-click, + tooltip) and `NodeWrapper` wires the same callback to the shell (double-click). No reliance on DOM bubbling across the overlay/shell trees.

### Module boundaries (single responsibility · must-not-know)

| Module                                              | Owns (only)                                                                                                                                                                  | Must NOT know                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `config/nodeLOD` (registry)                         | `mode: binary \| continuous`, `band`                                                                                                                                         | any node's visuals, anchors, sizes, colours             |
| `lodCurve` (pure math)                              | rep-size + band → `t`; `t` → eased `p ∈ [0,1]`; `bodyOpacity(t)`, `captionOpacity(t)`                                                                                        | pixels, node types, the DOM                             |
| `useNodeTakeover(nodeId, {band,sizeRange})`         | self-subscribe to zoom + node size; return `{ t, p, size, detail, cornerPt, centrePt, bodyOpacity, captionOpacity }`                                                         | what the mark looks like; how it's positioned           |
| `NodeTakeoverLayer` (overlay)                       | position the mark container `lerp(cornerPt,centrePt,t)`; publish `--lod-body-opacity`/`--lod-caption-opacity` on the node root; render the mark + caption; wire `onActivate` | the mark's internals; the card's markup                 |
| `.semantic-lod-content` (card)                      | `opacity: var(--lod-body-opacity, 1)` in CSS                                                                                                                                 | that a takeover engine exists                           |
| `NodeWrapper`                                       | pick ONE of `<BinaryPlaceholder>` / `<NodeTakeoverLayer>` and pass the node's stable descriptor + `onActivate`                                                               | takeover math or positioning                            |
| node's `TakeoverMark` (e.g. `QuestionTakeoverMark`) | draw itself from `{ t, size, detail }`; map `p→size` via its own `[minSize,maxSize]`                                                                                         | where it is on screen, the card, the caption sequencing |

The decoupling fixes baked into the table above, explicitly:

- **(A)** `fullAnchor`/`fullSize`/`min`/`maxSize` live in the node descriptor, never the central registry.
- **(B)** the card fade is a CSS var written _only_ by `NodeTakeoverLayer`; `NodeWrapper` and the card markup compute nothing.
- **(C)** the mark render-prop receives `{ t, size, detail }` only — positioning is never leaked to it.
- **(D)** activation is one `onActivate` shared by mark (click) and shell (double-click); no cross-tree bubbling.
- **(E)** `lodCurve` yields a normalised `p ∈ [0,1]`; the per-type mark maps `p` to its own pixel range (avatar's `88px` etc. stay in the question/avatar layer).
- **(F)** `useNodeTakeover` self-subscribes to zoom/size and takes only stable (memoised) props; `NodeTakeoverLayer` is memoised like `OverlayPortal`, so continuous zoom never re-renders node bodies.

### Node contract (stable seam)

```ts
// Supplied by the node to NodeWrapper — presentation only.
interface NodeTakeoverProps {
  descriptor: {
    band: Band;
    sizeRange: [min: number, max: number];
    fullAnchor: Point;
  };
  renderMark: (s: {
    t: number;
    size: number;
    detail: AvatarDetail;
  }) => ReactNode;
  caption?: string; // engine owns fade/sequencing; node owns text + style via renderMark
  onActivate?: (e: React.MouseEvent) => void;
}
```

`descriptor` and `renderMark` must be memo-stable (or perf isolation breaks — see F).

### Question migration

Fold `QuestionAgentBadge` + `QuestionMinimalAvatar` into one `QuestionTakeoverMark({t,size,detail})`: at `t=0` it renders exactly today's corner badge (constant size, all status chrome), and as `t→1` it becomes the centred avatar + caption. It maps `p→size` with the avatar's own `[14, 88]`. Delete question's binary `minimalContent` branch. The shared `questionBadgeChrome` + `AgentAvatarMark` are reused unchanged.

### Extensibility checklist (definition of done)

- Adding a node type = one `continuous` registry entry (`mode` + `band`) + one `TakeoverMark` + a descriptor. **No edits to `lodCurve`, `useNodeTakeover`, `NodeTakeoverLayer`, or `NodeWrapper`.**
- The engine owns `t`/positioning/card-fade/caption-sequencing/perf; the type owns only its mark visual and its pixel range.
- Binary LOD (title-label) stays available for types that don't want a morph.

### Risks / watch-items

- **Full-state pixel parity**: at `t=0` the question mark must equal today's badge exactly — snapshot before/after.
- **Edge smoothing** at the band ends so the mark doesn't pop when crossing `t≈0/1`.
- **Overhang policy** stays as decided (floor + small symmetric overhang; do not clamp to the node footprint).

### V1 → V2 cost

Additive: the mark visuals, size curve, detail tiers, and status chrome all carry over. New work is the engine (`lodCurve` + `useNodeTakeover` + `NodeTakeoverLayer`) and folding the two question elements into one `t`-driven mark. Because the coordinate model and interaction seam are now locked, this is a swap of "binary cross-fade" for "interpolation", not a rewrite.

### Prototype-first

Before touching the real canvas, rebuild the loop in the `AgentNodePlaygroundPage` lab: a screen-space `useNodeTakeover` + `NodeTakeoverLayer` driving one node with a draggable `t`, to lock the feel and the `t=0` pixel parity — then migrate question, then open it to other types.

---

> How the `AgentNodePlaygroundPage` "zoom LOD lab" (avatar takeover + identity dot) should land on the real canvas, and how much of the existing node LOD system it should reuse.
> Owner: canvas
> Prototype: [`apps/web/src/pages/AgentNodePlaygroundPage.tsx`](../../apps/web/src/pages/AgentNodePlaygroundPage.tsx) (`QuestionNodeLodLab`, `LodViewport`, `LodAgentChip`, `avatarSizeForNode`).

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
