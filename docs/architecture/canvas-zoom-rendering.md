# Canvas Zoom Rendering

> Authoritative rendering policy for nodes, frames, edges, labels, and interaction chrome while the canvas viewport zoom changes.
> Last updated: 2026-07-23

## 1. Scope and coordinate spaces

The canvas supports zoom values from `0.1` through `5`, with the shared bounds in [`apps/web/src/config/canvas.ts`](../../apps/web/src/config/canvas.ts) applied to React Flow and the custom pinch handlers.

Zoom-sensitive rendering uses two coordinate spaces deliberately. Canvas-space content participates in the viewport transform and therefore grows or shrinks with the canvas; screen-space overlays are positioned from transformed coordinates but retain stable physical size for controls or labels that must remain operable.

The governing rule is semantic priority rather than uniform scaling: structural geometry stays in canvas space, expensive content may switch level of detail, relationship and container labels defend readability, and interaction chrome remains usable.

## 2. Policy matrix

| Surface                                  | Coordinate/scale policy                  | Visibility policy                                                      |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| Note, PDF, web node body                 | Canvas space                             | Switches between `full` and `minimal` LOD from screen-space width      |
| Other node bodies                        | Canvas space                             | Always full rendering unless explicitly added to the LOD configuration |
| Minimal node label                       | Canvas-space tiered typography           | Wraps and clamps inside the node; naturally scales with the viewport   |
| Frame body                               | Canvas space                             | Always full rendering                                                  |
| Frame label                              | Screen-space overlay                     | Collision-aware for nested frames; interaction can force reveal        |
| Edge path and markers                    | Canvas/SVG space                         | Always rendered; no zoom visibility threshold                          |
| Non-empty edge label                     | Canvas portal with bounded inverse scale | Always rendered; idle text clamps to three lines                       |
| Empty edge label                         | Canvas portal with bounded inverse scale | Mounted only while the edge is selected or the label is being edited   |
| Floating toolbars and selection controls | Screen-space interaction chrome          | Driven by selection/input state rather than a semantic zoom threshold  |

## 3. Node level of detail

[`SEMANTIC_ZOOM_CONFIG`](../../apps/web/src/config/semanticZoom.ts) opts `note`, `pdf`, and `web` into the two-level `full → minimal` pipeline. Unlisted node types remain `full` at every zoom. The `question` node deliberately does **not** use this binary boundary — it uses the continuous zoom takeover described in §3.1.

Participating binary types render the generic tier-sized title label in `minimal`.

[`useNodeLOD`](../../apps/web/src/hooks/useNodeLOD.ts) compares `nodeWidth × zoom` with a 150 px screen-width boundary. A 10 px hysteresis buffer means a full node must shrink below 140 px to collapse, while a minimal node must grow to at least 160 px to expand; retaining the previous mode prevents rapid switching near the boundary.

[`NodeWrapper`](../../apps/web/src/components/Nodes/NodeWrapper.tsx) keeps the full body and [`SemanticPlaceholder`](../../apps/web/src/components/Nodes/SemanticPlaceholder.tsx) in the same node shell so CSS can cross-fade the two render modes without changing geometry.

The minimal placeholder expresses hierarchy from node geometry, not title length. [`selectTypographyTier`](../../apps/web/src/config/semanticZoom.ts) uses the canvas-space representative size $\sqrt{width \times height}$ to select 32 px, 52 px, or 76 px typography; the resulting text still participates in viewport scaling.

Minimal labels wrap at word boundaries, break only an otherwise unbreakable token, and clamp to the smaller of six lines or the number of lines that physically fit the padded node height. They never continuously shrink to fit content.

AI provenance chrome is independently hidden when a node's screen width falls below 150 px. This threshold reduces non-essential detail but does not determine the node body's LOD mode.

### 3.1 Continuous zoom takeover (question node)

The `question` node uses a **continuous** zoom takeover instead of the binary boundary. The agent mark's SIZE and POSITION are a continuous function of the node's on-screen width, so across a zoom the badge smoothly shrinks and glides from the readable card's corner into the centred collapsed mark — there is no discrete stage swap and no one-shot tween, and every frame is the exact geometry for that zoom. A single `collapseProgress` value $t \in [0, 1]$ (smoothstep-eased) drives it:

The policy can be summarized as **continuous mark geometry + discrete card visibility + size-driven glyph detail**. These three signals are deliberately independent: zoom width drives $t$, the hysteretic stage only hides or restores the card, and the final rendered mark size alone decides avatar versus dot.

Status chrome follows the same geometry: the structural Running, Approval, and Error outer-ring width and outward inset scale from the rendered mark size with crisp minimums and restrained maximums, while attention halos remain fixed screen-space emphasis rather than part of the ring geometry.

| $t$     | When (node on-screen width)           | What renders                                                                                                                                                 |
| ------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| $t = 0$ | width ≥ `TAKEOVER_START_WIDTH` (64px) | the sticky card **plus** the agent badge at the top-left corner; the badge scales together with the card (`BADGE_FRACTION` of the shorter on-screen side)    |
| $0<t<1$ | transition band                       | the badge continuously moves corner → centre and resizes badge → mark as the node shrinks                                                                    |
| $t = 1$ | width ≤ `TAKEOVER_END_WIDTH` (24px)   | the card is gone and a centred agent mark stands in for it; the mark's **glyph** is size-driven — a full agent avatar down to `MARK_FACE_MIN` px, then a dot |

The readable endpoint diameter is $\operatorname{clamp}(0.28 \times \min(w,h), 30, 84)$ screen px. The collapsed endpoint is a gamma-$0.7$ curve of the shorter screen side bounded to 6–30 px, and the live diameter linearly interpolates between those endpoints by $t$. The readable anchor is near the card's top-left corner, the collapsed anchor is the card centre, and the live point interpolates between them by the same $t$. The final scope deliberately renders no collapsed title caption: the Agent mark is the complete minimal representation.

The card-body fade is the only discrete signal: a binary `data-lod-body` attribute derived from the same width via `resolveQuestionStage` (a two-value `readable` \| `collapsed` stage with hysteresis so it never flickers at the edge). It fades the node shell to zero opacity over 200 ms while intentionally retaining the invisible React Flow node footprint for canvas selection and double-click activation. The sticky's darker depth board hides immediately on collapse and returns only after the pale body finishes fading in, so it cannot flash by itself beneath the portal-rendered mark. That stage decides card-body visibility + chrome ONLY; it never drives the mark's size or position, which come purely from `collapseProgress`. The face ↔ dot fallback is likewise NOT a stage — it is size-driven inside the mark. A small, mostly type-agnostic engine drives it:

| File                                                                                                                          | Responsibility                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`config/nodeTakeover.ts`](../../apps/web/src/config/nodeTakeover.ts)                                                         | Pure geometry math: `collapseProgress` (screen width → smoothstep $t$), `badgeSizeForNode` / `collapsedMarkSize` (the two size endpoints lerped by $t$), `resolveQuestionStage` (screen width + hysteresis → `readable` \| `collapsed` for body visibility), `lerp`, and the size constants. No DOM.              |
| [`hooks/useNodeTakeover.ts`](../../apps/web/src/hooks/useNodeTakeover.ts)                                                     | Self-subscribes to zoom + node rect; interpolates the mark's `size` and screen `point` (corner → centre) by `collapseProgress` every frame, plus the `collapsedRadius` edges clip to. Returns `{ stage, size, point, collapsedRadius }`.                                                                          |
| [`components/Nodes/NodeTakeoverLayer.tsx`](../../apps/web/src/components/Nodes/NodeTakeoverLayer.tsx)                         | Screen-space portal; positions the mark at its continuous left/top/size (re-rendering each zoom frame — no FLIP), publishes the collapsed radius, writes the binary `data-lod-body` attribute on the node root, forwards a double-click. Memoised, so continuous zoom re-renders only this overlay, not the body. |
| [`components/Nodes/question/QuestionTakeoverMark.tsx`](../../apps/web/src/components/Nodes/question/QuestionTakeoverMark.tsx) | Question's mark: renders the SAME sticker badge (avatar/dot + status ring, or the `open` chat bubble) from `{ stage, size }` at any size, shares status colour via [`questionBadgeChrome`](../../apps/web/src/components/Nodes/question/questionBadgeChrome.ts), and owns its own click-to-open.                  |
| [`components/Nodes/question/QuestionAgentBubble.tsx`](../../apps/web/src/components/Nodes/question/QuestionAgentBubble.tsx)   | Shared `open` speech-bubble SVG (path + sticker fill + `--question-border` stroke) reused by BOTH the readable corner badge and the takeover mark, so the bubble geometry has a single source of truth.                                                                                                           |

The `open` mark centres the avatar geometrically against the bubble's circular body and then adds a tiny proportional optical correction for the avatar artwork.

Because the geometry is exact every frame, the overlay simply re-renders at the new left/top/size as the canvas zooms — the badge glides and resizes smoothly with the gesture, with no discrete stage swap and no one-shot animation to feel abrupt. The engine has **no** interaction vocabulary: the mark owns its own single-click + gating; the engine exposes only one semantics-free `onActivate` (double-click passthrough) that `NodeWrapper` wires to the node's existing activate handler. See [question-node.md](./question-node.md#51-trigger) and [proposals/question-node-zoom-lod-avatar.md](../proposals/question-node-zoom-lod-avatar.md).

## 4. Frame and frame-label policy

Frame geometry always remains full canvas-space content. A frame does not use `SemanticPlaceholder` because its border and containment boundary are structural information even when zoomed out.

The editable frame name is different: [`FrameNode`](../../apps/web/src/components/Nodes/frame/FrameNode.tsx) sends it through the screen-space overlay owned by [`NodeWrapper`](../../apps/web/src/components/Nodes/NodeWrapper.tsx), positioned 24 px above the transformed frame top. Its `text-xs` typography therefore remains readable instead of shrinking with the frame.

Fixed screen-space labels can overlap when nested frame top edges converge during zoom-out. `FrameNode` compares the vertical screen-space gap to the nearest frame ancestor and hides the nested label below 22 px, with a 4 px hysteresis buffer around subsequent hide/reveal transitions.

The default collision priority preserves the outer frame as the zoomed-out structural summary. Selecting, hovering, or editing an inner frame force-reveals its label; when a selected descendant would collide, the conflicting ancestor label is suppressed rather than merely painted underneath it.

### Display priority

When frame labels collide, the higher-priority label wins:

1. Label currently being edited.
2. Label of a selected frame.
3. Label of a hovered frame.
4. Label of the outer frame.
5. Label of the inner frame.

The first three interaction states force the affected label to remain visible and use matching overlay layers in descending order. With no interaction, the outer frame wins because zoomed-out views prioritize structural context over nested detail; the inner label returns after sufficient screen-space separation.

Frame label width is capped to the transformed frame width with a 48 px usability floor. Overflowing names truncate visually while the input title retains access to the complete name.

`FrameNode` owns the hierarchy and collision policy because it is frame-specific. `NodeWrapper` remains generic: it converts node coordinates to screen coordinates, applies owner-provided semantic visibility and width, handles interaction reveal, and performs opacity/FLIP transitions.

## 5. Edge and edge-label policy

Edge paths, markers, and hit areas remain in the React Flow SVG layer and have no semantic zoom visibility threshold.

[`LabelledEdge`](../../apps/web/src/components/Panels/Canvas/edges/LabelledEdge.tsx) renders editable relationship labels at the edge midpoint through `EdgeLabelRenderer`. Because this portal remains inside the zoomed viewport, the label pill applies a bounded inverse scale `min(max(1 / zoom, 1), 2.5)` so text defends readability while zooming out but neither shrinks on zoom-in nor grows without bound at extreme zoom-out.

Only the label pill is counter-scaled; its midpoint positioning wrapper is not transformed, so its anchor remains stable. Horizontal padding is divided by the same scale to avoid visually inflated whitespace.

A non-empty edge label is always mounted. Idle labels clamp to three lines, while hover, selection, or editing reveals the complete relationship. An empty edge label is omitted until its edge is selected, at which point the placeholder becomes available for editing.

The edge-label portal mirrors the edge's derived render z-index through [`getEdgeRenderZ`](../../apps/web/src/components/Panels/Canvas/edges/edgeZ.ts), keeping the label in the same layer contract as its relationship rather than elevating every label above all nodes.

## 6. Interaction chrome

Floating toolbars, resize controls, and similar interaction affordances use screen-oriented sizing so they remain operable across the zoom range. Their visibility follows selection, hover, editing, and input-mode state rather than node semantic LOD.

The bottom-left viewport controls display the current canvas zoom as a compact multiplier rounded to one decimal (`1×`, `0.8×`, `1.9×`) for orientation across wheel, pinch, shortcut, and button-driven zoom. Its tooltip and accessible label retain the exact integer percentage. Clicking the multiplier animates the viewport back to 100%; this value describes viewport scale only and does not report a selected node's dimensions. The multiplier sits after fit-view and before the interactivity lock; the custom-positioned lock mirrors React Flow's native toggle by changing node dragging, connection, and element-selection state together.

Viewport restoration is local and keyed by canvas ID. When no local or legacy viewport exists, the first mount fits all nodes through bounds computed from React Flow absolute positions with persisted `style.width` / `style.height` fallbacks. This avoids the native `fitView` failure mode where `onlyRenderVisibleElements` leaves every offscreen node unmeasured and the initial fit silently resolves to an empty rectangle. During this asynchronous first fit, the React Flow surface remains hidden behind the standard loading overlay and is revealed only after `fitBounds` settles, preventing a transient paint at the default viewport. Cached viewport restoration and genuinely empty canvases skip this overlay.

Ctrl-modified wheel events use the custom cursor-anchored path in [`useCanvasGestures`](../../apps/web/src/hooks/useCanvasGestures.ts). Small trackpad deltas retain a `0.02` exponential sensitivity for responsive pinch gestures, while the effective absolute delta per event is capped at `10`; this keeps a discrete mouse-wheel notch near a 13% zoom change instead of allowing a multi-fold jump. Two-finger touch pinch remains distance-based and is unaffected by this cap.

Selection outlines are rendered as canvas-level HUD overlays instead of changing node order. Zoom never promotes a selected node in the content stack; node and edge stacking remains governed by the policy in [`web-architecture.md`](./web-architecture.md#6-node--edge-stacking-z-order).

Zoom-invariant and counter-scaled chrome should be bounded. New overlays must not use unbounded `1 / zoom` scaling at the minimum zoom, and non-essential chrome should prefer a screen-space visibility threshold when it would obscure semantic content.

## 7. Extension rules

Add a node type to `SEMANTIC_ZOOM_CONFIG.nodeLOD` only when its full renderer is expensive or unreadable at small screen size and a meaningful minimal representation exists. Node geometry and persisted data must not change when LOD changes.

Use screen-space overlays for controls and short labels that must remain readable or clickable. Use canvas-space typography for content whose size should communicate hierarchy and naturally recede during zoom-out.

Every new fixed-size label needs an explicit collision policy, width bound, and interaction priority. Raising `z-index` alone is not a collision policy because it only chooses which overlapping text paints last.

Use hysteresis for any visibility or render-mode threshold that can be crossed continuously during wheel or pinch zoom. Keep threshold ownership with the feature that defines the semantic policy; generic portal components should accept resolved visibility rather than infer feature hierarchy.

## Code entry points

| File                                                                                                                                                   | Responsibility                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [`apps/web/src/config/canvas.ts`](../../apps/web/src/config/canvas.ts)                                                                                 | Canonical minimum and maximum viewport zoom                                 |
| [`apps/web/src/config/semanticZoom.ts`](../../apps/web/src/config/semanticZoom.ts)                                                                     | Node LOD thresholds, participating types, and minimal typography tiers      |
| [`apps/web/src/hooks/useNodeLOD.ts`](../../apps/web/src/hooks/useNodeLOD.ts)                                                                           | Screen-width LOD resolution with hysteresis                                 |
| [`apps/web/src/components/Nodes/SemanticPlaceholder.tsx`](../../apps/web/src/components/Nodes/SemanticPlaceholder.tsx)                                 | Minimal node representation and text fitting                                |
| [`apps/web/src/components/Nodes/frame/FrameNode.tsx`](../../apps/web/src/components/Nodes/frame/FrameNode.tsx)                                         | Frame-label collision, hierarchy priority, and width policy                 |
| [`apps/web/src/components/Nodes/NodeWrapper.tsx`](../../apps/web/src/components/Nodes/NodeWrapper.tsx)                                                 | Shared node shell and screen-space overlay rendering                        |
| [`apps/web/src/components/Panels/Canvas/edges/LabelledEdge.tsx`](../../apps/web/src/components/Panels/Canvas/edges/LabelledEdge.tsx)                   | Edge path, label visibility, wrapping, editing, and bounded inverse scaling |
| [`apps/web/src/components/Panels/Canvas/edges/edgeZ.ts`](../../apps/web/src/components/Panels/Canvas/edges/edgeZ.ts)                                   | Edge-label portal z-index mapping                                           |
| [`apps/web/src/components/Panels/Canvas/SelectionOutlines.tsx`](../../apps/web/src/components/Panels/Canvas/SelectionOutlines.tsx)                     | Screen-space selection HUD                                                  |
| [`apps/web/src/components/Panels/CanvasLayerPanel/focusNodesOnCanvas.ts`](../../apps/web/src/components/Panels/CanvasLayerPanel/focusNodesOnCanvas.ts) | Reliable node bounds, initial fit, and layer/search focus                   |
