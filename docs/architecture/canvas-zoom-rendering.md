# Canvas Zoom Rendering

> Authoritative rendering policy for nodes, frames, edges, labels, and interaction chrome while the canvas viewport zoom changes.
> Last updated: 2026-07-13

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

[`SEMANTIC_ZOOM_CONFIG`](../../apps/web/src/config/semanticZoom.ts) opts `note`, `pdf`, `web`, and `question` into the current two-level `full → minimal` pipeline. Unlisted node types remain `full` at every zoom.

Most participating types render the generic tier-sized title label in `minimal`. The `question` node is the exception: it supplies its own minimal payload — its agent avatar as a zoomed-out stand-in — through `NodeWrapper`'s `minimalContent` slot, which replaces [`SemanticPlaceholder`](../../apps/web/src/components/Nodes/SemanticPlaceholder.tsx) inside the shared cross-fade layer. The avatar rides [`avatarSizeForNode`](../../apps/web/src/config/agentAvatarLOD.ts) on the node's on-screen size and sheds detail toward a solid identity dot ([`AgentAvatarMark`](../../apps/web/src/components/Common/AgentAvatarMark.tsx)); an idle question node (no agent status) falls back to the title label. See [question-node.md](./question-node.md) and [proposals/question-node-zoom-lod-avatar.md](../proposals/question-node-zoom-lod-avatar.md).

[`useNodeLOD`](../../apps/web/src/hooks/useNodeLOD.ts) compares `nodeWidth × zoom` with a 150 px screen-width boundary. A 10 px hysteresis buffer means a full node must shrink below 140 px to collapse, while a minimal node must grow to at least 160 px to expand; retaining the previous mode prevents rapid switching near the boundary.

[`NodeWrapper`](../../apps/web/src/components/Nodes/NodeWrapper.tsx) keeps the full body and [`SemanticPlaceholder`](../../apps/web/src/components/Nodes/SemanticPlaceholder.tsx) in the same node shell so CSS can cross-fade the two render modes without changing geometry.

The minimal placeholder expresses hierarchy from node geometry, not title length. [`selectTypographyTier`](../../apps/web/src/config/semanticZoom.ts) uses the canvas-space representative size $\sqrt{width \times height}$ to select 32 px, 52 px, or 76 px typography; the resulting text still participates in viewport scaling.

Minimal labels wrap at word boundaries, break only an otherwise unbreakable token, and clamp to the smaller of six lines or the number of lines that physically fit the padded node height. They never continuously shrink to fit content.

AI provenance chrome is independently hidden when a node's screen width falls below 150 px. This threshold reduces non-essential detail but does not determine the node body's LOD mode.

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
