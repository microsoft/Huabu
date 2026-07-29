# Canvas Input Interactions

> The single, complete reference for canvas gestures across mouse, touch, and pen.
> Sections 1–5 define the interaction contract (the rules), section 6 describes the pointer-router mechanism that delivers it, section 7 is the validation boundary, and the appendix places the model against mainstream whiteboard and note apps.
> Last updated: 2026-07-23

## 1. Input preferences

Canvas input uses one persisted preference in `toolStore`, plus a reactive signal that tracks the pointer currently in use.

| Signal                     | Values                           | Responsibility                                                                                                                                                                                                       |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input mode (persisted)     | `auto`, `mouse`, `pen`, `finger` | Gates which non-mouse pointers may reach the canvas and disambiguates whether pen or finger directly manipulates versus navigates.                                                                                   |
| Current pointer (reactive) | mouse vs touch/pen               | Drives UI density and pointer-appropriate affordances — toolbar contents, keyboard-shortcut hints, on-canvas delete buttons, resize-handle size, pan vs box-select, node draggability, and tap-versus-drag distance. |

Auto resolves to Pen after a trusted `pointerdown` reports `pointerType === 'pen'`; the resulting `penObserved` flag persists for the browser profile and origin. Before a pen is observed, Auto resolves to Finger when the browser reports touch capability or observes touch or pen input, and Mouse otherwise. Explicit Mouse, Pen, and Finger preferences always win and are never rewritten by observation.

```mermaid
flowchart TD
  P{Explicit preference?}
  P -->|Mouse| M[Mouse]
  P -->|Pen| E[Pen]
  P -->|Finger| F[Finger]
  P -->|Auto| O{Pen observed?}
  O -->|Yes| E
  O -->|No| T{Touch capable or observed?}
  T -->|Yes| F
  T -->|No| M
```

The mouse is a precise, unambiguous pointer and always operates the canvas — it is never blocked by the input mode. The input mode only decides how the touchscreen and pen behave. Mouse mode additionally ignores touchscreen and pen input entirely: those pointers do not navigate, place nodes, draw Lasso or Sketch gestures, or manipulate content. Trackpad wheel gestures remain available because browsers expose them as wheel input rather than touchscreen pointer events.

The reactive current-pointer signal (`useIsNotMouse`) follows the most recent `pointerdown` so hybrid devices (e.g. Surface) switch between the desktop and touch experiences the instant the pointer changes. Mouse mode pins this signal to mouse because it ignores touch and pen.

## 2. Tool mapping

While the mouse is the current pointer, the toolbar keeps the Select, Pan, and Lasso tools and their existing mouse and keyboard behavior, including shortcut hints and badges.

While touch or pen is active, Select is the visible default tool and the safe home base: a tap selects a node and a drag on an already-selected node moves it, all through React Flow with no accidental ink. Pan collapses to the internal direct-manipulation state and is hidden from the touch-first toolbar; Select and Lasso are the visible tools, and Sketch is an explicit sticky tool listed among the creation nodes. Pan shortcuts resolve to the internal Select state instead of creating hidden Pan state. Because the toolbar layout follows the current pointer rather than the persisted mode, a mouse and a finger used on the same hybrid device each get their native toolbar.

New empty canvases carry a one-shot input-appropriate creation intent: Mouse starts with Note armed, while Pen and Finger start with Sketch armed. This intent is consumed once, on the first completed load of a freshly created empty canvas. After it is consumed — and after any one-shot placement tool finishes on any canvas — the tool falls back to Select rather than re-arming Sketch, so a resting finger or pen can never accidentally draw or erase.

Lasso and Sketch remain explicit persistent modes across pointer and input-mode changes: once chosen they stay active until the user switches away. Lasso owns only empty-pane gestures, so activating it does not disable dragging nodes that were already selected before pointer down.

## 3. Direct manipulation

While touch or pen is the current pointer, node objects are draggable only when they were selected before the render that precedes pointer down. An unselected-node gesture can therefore select the node but cannot move it during that same gesture; the next gesture can drag it. The mouse always drags nodes directly. Dragging an already-selected member continues to use React Flow's existing multi-selection drag behavior.

Direct-manipulation gestures use a shared screen-space activation policy: touch locks after 8 CSS px, pen after 4 CSS px, and mouse after 1 CSS px. React Flow receives the distance for the current pointer for both node drag activation and click tolerance, while custom pan, Lasso, and Sketch paths choose by each event's pointer type through `canvasGestureSession` and transition from `pending` to `locked`.

```mermaid
stateDiagram-v2
  [*] --> Pending: pointer down
  Pending --> CompletedTap: release below threshold
  Pending --> Locked: cross activation threshold
  Pending --> Cancelled: cancel or eligible pinch takeover
  Locked --> CompletedDrag: pointer up
  Locked --> Cancelled: pointer cancel
  Locked --> Locked: additional touch cannot take over
  CompletedTap --> [*]
  CompletedDrag --> [*]
  Cancelled --> [*]
```

The shared values define only the tap-versus-drag activation gate. Feature-specific quantities retain their separate meanings, including Lasso point sampling and minimum polygon span, Frame minimum creation size, Sketch merge distance, eraser radius, and Smart Snap distance.

In Finger mode, one-finger touch on empty canvas owns a pending viewport gesture: releasing below the touch activation distance clears the current selection, while crossing the distance locks and pans without clearing selection. Empty-canvas ownership is determined by excluding nodes and React Flow panels rather than requiring a particular React Flow pane descendant, so Background and other non-interactive canvas layers remain pannable. Node content and selected nodes retain their normal target ownership.

The canvas root suppresses browser long-press callouts and native context menus on non-editable interaction surfaces so they cannot interrupt Pan, Lasso, Sketch, or node manipulation. While a finger or pen is the current pointer (`[data-canvas-root][data-not-mouse]`) it also disables text selection (`user-select: none`), so a drawing/pan/drag gesture that crosses node or panel text cannot select it and pop the iOS copy callout; the mouse keeps text selection so desktop users can still copy node text. Text inputs, selects, editable content, and real links retain their native context menus and remain selectable.

The React Flow interactivity lock applies to native and pointer-router interaction paths alike. While locked, node dragging, Lasso selection, retained Sketch-selection movement, and touch tap selection are disabled; viewport pan and zoom remain available, matching React Flow's native lock behavior. Creation tools remain governed by their own active-tool state rather than the interactivity lock.

In Pen mode, pen input manipulates on-canvas nodes and content while touch input is intercepted before React Flow selection and drives viewport navigation. Touch remains available to application chrome inside React Flow panels. A finger tap that never locks into a pan doubles as selection: on a pending release the `viewport-navigation` recognizer resolves the topmost node under the touch-down point through the shared `nodeIdAtScreenPoint` hit-test and selects it (or clears the selection on empty canvas). Because that hit-test walks node bounding boxes rather than the DOM target, it works even when the full-screen Sketch overlay covers the node — so the pen keeps drawing while the finger picks nodes and navigates, matching pen-first note apps.

Still in Pen mode, a finger that presses an **already-selected** node and drags moves it (the whole current selection), while the pen keeps drawing. The dedicated `node-drag` recognizer — offered before `viewport-navigation` so it wins the selected-node case, and gated to `inputMode === 'pen'` — owns this gesture. It cannot delegate to React Flow (node dragging is disabled and the overlay covers the nodes while Sketch is armed), so it drives the move through the store's existing drag lifecycle (`onNodeDragStart` → `onNodesChange` position ticks → `onNodeDragStop`), keeping smart-snap, frame re-parenting, autosave, and single-entry undo identical to a mouse or pen drag. A finger on an unselected node or empty canvas still falls through to tap-select / pan (select-first), and while the drag's snap session is active a second finger can neither pinch nor claim a competing pan (`canTouchClaimViewport` and `canTouchTakeOverForPinch` both reject it).

Click-to-place creation tools such as Note, Text, and Question always accept a mouse click through the pane click handler. Non-mouse placement uses an explicit primary Pointer Events tap gated by the input mode: Pen accepts the pen tip and rejects touch placement; Finger accepts touch and rejects pen placement; Mouse mode rejects both. Placement starts only from empty canvas surfaces and is cancelled when movement reaches the pointer's activation distance.

## 4. Multi-touch navigation

The pointer router's `viewport-navigation` recognizer owns touch navigation through one capture-phase Pointer Events stream from pointer down through move and release. The same stream intercepts React Flow and drives the viewport, avoiding browser-dependent compatibility ordering between Pointer Events and legacy Touch Events. Pinch scale is anchored to the takeover midpoint and midpoint translation contributes pan, preventing a viewport jump.

React Flow's own `zoomOnPinch` runs on d3-zoom's separate Touch Events stream, which the capture-phase Pointer Events suppression cannot stop; leaving it enabled lets it and the recognizer both write `setViewport` and the gesture stalls. It is therefore disabled whenever a finger or pen is the current pointer — mirroring the touch `panOnDrag` disable — so the router is the sole viewport driver; only the mouse/trackpad keeps React Flow's native pinch.

The pinch is always driven by the first two active touches, and its baseline (start distance, start midpoint, and start viewport) is keyed by that pointer-id pair. Whenever the pair changes — a third finger lands, or one of the two lifts — the baseline is re-captured from the live finger positions and viewport on the next move. This keeps the zoom continuous with three or more fingers down (no freeze) and prevents a jump when the gesture drops back to a different two-finger pair. While a pinch is live, additional touches only extend the pinch's touch set; they never claim a competing single-finger pan.

Touches that begin inside React Flow panels remain application-chrome input and are not added to the viewport recognizer's active-touch set. A panel touch therefore cannot become one half of a canvas pinch.

A one-finger viewport pan is an ordinary exclusive pointer-router owner. Only the multi-pointer observer tracks touches outside that owner lifecycle, allowing the second finger to cancel eligible pending owners and begin pinch takeover. A two-finger navigation gesture remains latched when its pointer count falls to one. The remaining touch is suppressed and cannot resume selection, drag, Lasso, Sketch, link, or control behavior; the gesture ends only after all participating touches are released. A locked one-finger viewport pan may upgrade directly to pinch because both gestures retain viewport ownership.

A live node drag is considered locked while the snap session is active, so a second finger is ignored instead of taking over. When pinch takeover is allowed, the router cancels any owner held by each participating pointer before viewport navigation begins; this prevents a pending click-to-place pointer from committing after the pinch ends. Pending Lasso and Sketch gestures are also cancellable: takeover clears their gesture-local preview before viewport navigation begins. Locked Lasso and Sketch gestures retain ownership and reject takeover.

## 5. Lasso and Sketch routing

In Pen mode, Lasso and Sketch accept pen pointers and reject touch drawing. In Finger mode, they accept touch pointers and reject pen drawing. Mouse mode accepts only mouse pointers. Lasso begins only from the React Flow pane and excludes panels, nodes, edges, and handles. Lasso and Frame are exclusive pointer-router owners: after a successful down, only that owner receives the pointer's move/up/cancel lifecycle, and pinch takeover cancels the owner through its normal cancellation path. The global observer channel is reserved for multi-pointer viewport takeover rather than ordinary tool dispatch. Sketch draw and erase movement is keyed by the active pointer id; only mouse movement additionally requires the primary button bit.

Lasso does not clear selection or expose a path while pending. Crossing the activation distance locks the gesture, clears selection, and starts the preview path; releasing or cancelling before lock has no selection side effect.

Sketch drawing remains gesture-local until pointer up and commits only after the gesture locks. Sketch erasing collects hit stroke ids in a gesture-local map and immediately hides those strokes through the transient gesture preview store, then builds one command batch on pointer up after lock. Cancelling the gesture clears the draw or erase preview and restores hidden strokes, producing no canvas mutation or undo entry.

A stroke ends at its last pointermove; the coordinates carried by `pointerup` are discarded. Lifting a pen is not instantaneous — pressure bleeds off over roughly 100ms while the tip sits nearly still — so the tail of a stroke is a run of near-stationary samples with monotonically decaying pressure, delivered before `pointerup` with the tip still nominally down. Because `streamline` renders behind the true tip, that dwell lets the smoothed path catch up and extend past where the user stopped, thinly, since `thinning` scales width with pressure. The overlay trims that run before committing (`countLiftOffPoints`). Detection is by shape rather than magnitude: an absolute pressure threshold cannot separate a light stroke from a lift-off, whereas a monotonic decay run is unambiguous. The trim is capped, requires the decay to reach a fraction of where it started, and is inert for devices that report no pressure — including the raw-touch replay path, which floors pressure at a constant.

The live preview republishes the in-progress stroke at most once per animation frame; pointermove appends to a buffer and schedules the publish. The overlay's origin is cached and refreshed from resize, scroll, and each gesture start rather than measured per event, so recording a point never forces a synchronous layout.

The Sketch overlay never selects nodes: whichever pointer it accepts (the pen in Pen mode, the finger in Finger mode) only draws or erases. Selection stays with the two natural owners — React Flow's native tap for a finger under the Select tool, and the `viewport-navigation` recognizer for the finger in Pen mode — so the drawing pointer and the selecting pointer are always different channels and the concern never mixes into the overlay component.

### 5.1 Raw-touch stylus engine

WebKit synthesises stylus pointer events through a gesture recogniser that drops light or fast contacts before dispatch, so an Apple Pencil stroke can fire no `pointerdown` at all — the ink is lost and the contact falls through to the native selection callout. The Sketch overlay compensates with a raw-touch engine (`stylusRawTouch.ts`): it listens to the non-passive `touch` stream, `preventDefault()`s each stylus contact to claim it, and replays it into the overlay's existing pointer handlers as a synthetic pen event. Draw, erase, merge, commit, and storage logic is therefore reused verbatim rather than duplicated; synthetic pointer ids live in a separate numeric namespace so they cannot collide with browser pointer ids.

The engine is gated on two static device capabilities, probed on first use and memoised: touch capability, and whether the browser exposes WebKit's non-standard `Touch.touchType`. The second is load-bearing — without it a finger contact is indistinguishable from a stylus contact in the raw stream, so the engine would hijack finger drawing on Chromium touch devices. The gate is deliberately not the live pointer mode, because the dropped contact this engine recovers never produces a pointer event to derive that mode from. Where the engine runs it owns the stylus outright and the browser's own pen pointer events are dropped, so a contact is never handled twice; where it does not run, nothing changes and Chromium stylus hardware keeps using its reliable pointer stream.

The replay protocol is split from React: a DOM-level `attachStylusRawTouch` core installs the listeners and is exercised in unit tests with a plain element and plain touch events, while a thin `useStylusRawTouch` hook owns the lifecycle. The hook takes the overlay element rather than a ref so its effect re-runs whenever the overlay mounts a different node. Replayed contacts are typed as `SketchPointer` — the explicit subset of `React.PointerEvent` the overlay handlers actually consume — so a synthetic contact is a complete value rather than a type assertion, and a handler reaching for a field the engine cannot supply fails to compile instead of failing only on a tablet.

Routing is unchanged: a replayed stylus contact is still filtered by `acceptsPointer`, so Mouse mode still ignores it and Finger mode still rejects pen drawing. Because the engine is itself a pointer source, it reports the observation through the same `observeInputPointer` entry point the global `pointerdown` listener uses. `acceptsPointer` resolves the effective input mode from live store state rather than a render-time value, since a contact that has just flipped `penObserved` would otherwise still be routed against the previous render's mode and the first stroke would be dropped.

## 6. Pointer router architecture

The behaviour in sections 1–5 is delivered by one arbitration layer rather than scattered listeners. A single capture-phase pointer stream on the canvas wrapper feeds a `PointerRouterCore` that offers each `pointerdown` to an ordered list of recognizers, records the first that claims the pointer, and routes that pointer's later move/up/cancel only to its owner. This replaces the former fan-out across `useCanvasGestures`, bubble-phase handlers in `Canvas.tsx`, and per-tool listeners, so the full "who owns this pointer" decision lives in one place. The core is DOM- and React-independent so the protocol is unit-testable with plain event objects; a thin hook (`useCanvasPointerRouter`) installs the capture-phase listeners and supplies the live context.

```mermaid
flowchart TD
  D[pointerdown] --> B[Broadcast to observe hooks]
  B --> P{Observer preempts?}
  P -->|Yes| C[Cancel displaced owner]
  C --> O[Record observer as owner]
  P -->|No| R[Offer recognizers in priority order]
  R --> Q{canClaim and onDown claims?}
  Q -->|Yes| N[Record recognizer as owner]
  Q -->|No recognizer claims| X[Leave pointer unowned]
  O --> L[Route move, up, and cancel to owner]
  N --> L
  L --> U[Release owner on up or cancel]
```

### Recognizer contract

Each pointer concern is a recognizer with a pure `canClaim` gate, a claim/pass `onDown`, optional move/up/cancel handlers, and an optional `observe` channel:

```ts
interface PointerRecognizer<E, C> {
  id: string;
  canClaim(event: E, ctx: C): boolean;
  onDown(event: E, ctx: C): 'claim' | 'pass';
  onMove?(event: E, ctx: C): void;
  onUp?(event: E, ctx: C): void;
  onCancel?(event: E, ctx: C): void;
  observe?: {
    onDown?(event: E, ctx: C & PreemptContext): void;
    onMove?(event: E, ctx: C & PreemptContext): void;
    onUp?(event: E, ctx: C & PreemptContext): void;
    onCancel?(event: E, ctx: C & PreemptContext): void;
  };
}
```

`canClaim` is side-effect-free and delegates to `canvasInputPolicy` predicates; the router calls `onDown` only for recognizers whose `canClaim` passed, and the first `'claim'` becomes the sole owner of that pointer id. Recognizers never call `addEventListener`; they receive dispatched events and call `preventDefault()` / `stopPropagation()` only for pointers they own.

The optional `observe` block sees _every_ pointer event regardless of ownership, before per-owner routing. Its `PreemptContext` exposes `preempt()` (seize the current pointer, cancelling the displaced owner via its `onCancel`) and `cancelPointer(id)` (release another tracked pointer). This is what lets two-finger navigation track a second finger while another recognizer owns the first, then escalate into a pinch. Ownership is always one recognizer per pointer id; the observer channel only watches and escalates.

### Event phase

The router listens in the capture phase because it must intercept a gesture before React Flow's pane and d3-zoom listeners, which are attached on descendant elements and would otherwise run first. Every former bubble-phase handler is folded into a recognizer so there is a single phase and a single ordering.

### Ownership and takeover priority

`pointerdown` is offered in a fixed order and the first `'claim'` wins:

| Order | Recognizer                              | Claims when                                                                                                                                                                                                                                                                                               |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `node-drag`                             | Pen mode, a finger presses an already-selected node. Offered before `viewport-navigation` so it wins the selected-node case; it drives the store drag lifecycle (`onNodeDragStart` → position ticks → `onNodeDragStop`) because the Sketch overlay covers the nodes and React Flow node-drag is disabled. |
| 2     | `viewport-navigation`                   | Touch eligible for single-finger empty-canvas pan. As a global observer it also tracks every touch so a second finger can `preempt()` into a two-finger pinch.                                                                                                                                            |
| —     | `sketch`                                | _Not_ a router recognizer: the full-screen overlay owns its own pointers and coordinates only through the shared `canvasGestureSession` / `canvasInteractionOwner`, so folding it into the router would split pointer handling from its SVG preview rendering for no arbitration gain.                    |
| 3     | `click-to-place`, `frame-drag`, `lasso` | Registered after `viewport-navigation`. Their `canClaim` gates are mutually exclusive on `pendingNodeType` and the active tool, so their relative registration order does not affect behaviour.                                                                                                           |

Cross-recognizer takeover — for example a second finger converting a pending lasso into a pinch — runs through the observer / `preempt()` channel and is gated by `canvasGestureSession` (pending vs locked) and `snapSession` (active node drag), both consulted only through the `canvasInteractionOwner` façade, the single answer to "can a new gesture take over right now". An active node drag is not a recognizer: React Flow and `snapSession` own it, and the router treats it as an external owner that rejects a second finger.

### Router responsibilities

The router keeps a `Map<pointerId, recognizer>` of owners, broadcasts every event to `observe` hooks before per-owner routing, offers `pointerdown` in priority order, and clears the entry on up/cancel. It holds no gesture-specific state beyond the current owner per pointer id and the observer set, and stays mounted across input-mode and tool re-renders (reading options from a ref) so a mid-gesture re-render never drops an active owner.

## 7. Validation boundary

Unit tests cover preference precedence and persistence, Mouse/Pen/Finger tool mapping, direct-manipulation node-drag eligibility, Pen/Finger click-to-place routing and activation thresholds, input-specific activation distances, pending/locked/takeover transitions, single-touch navigation ownership, full-lifecycle Pan/Pinch event suppression, fixed-anchor Pinch geometry, zoom clamping, Sketch-erase command generation, and the router protocol itself (offer order, claim-stops-offering, owner routing, and `preempt`) via synthetic recognizers. A touch-emulated Playwright suite drives `page.touchscreen` for pinch, single-finger pan takeover, placement, frame, and lasso. Browser checks cover non-editable canvas context-menu suppression and editable/link exceptions.

The capture-phase pointer model — trusted pointer ordering, `setPointerCapture`, pen and palm behaviour, Pen-mode finger tap-to-select and drag-to-move (including under the Sketch overlay, with snap and frame re-parenting), and multi-touch takeover transitions — was validated on iPad with Apple Pencil. The remaining hardware in the matrix (Surface, Android tablet with pen, phones, and pen-tail eraser reporting) stays a recommended regression pass for future pointer changes.

## Appendix: Product interaction position

Touch-first canvas products broadly follow two established models:

| Model                     | Examples                                  | Sketch-tool tap on content         | Selection model                      |
| ------------------------- | ----------------------------------------- | ---------------------------------- | ------------------------------------ |
| Whiteboard / diagram      | Figma, FigJam, Excalidraw, Miro           | Draws rather than selects          | Switch to Select                     |
| Pen-first notes / drawing | Goodnotes, Notability, Procreate, OneNote | Pen draws; finger selects or moves | Pen and finger are separate channels |

Sediment chooses between those models by input ambiguity rather than adopting either one everywhere. Pen mode follows the pen-first model: the pen draws or directly manipulates while a finger selects, moves already-selected nodes, and navigates. Finger mode follows the whiteboard model: the same finger cannot unambiguously draw and select, so Sketch draws and Select selects. Mouse mode preserves the desktop model.

| Dimension                          | Sediment behaviour                                                                       | Closest model                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| Touch default                      | Select is the safe default; a new empty canvas carries a one-shot Sketch creation intent | Whiteboard, with a creation shortcut          |
| Sketch persistence                 | Sketch and eraser remain active until explicitly replaced                                | Both                                          |
| Finger under Sketch in Finger mode | Draws; selecting requires Select                                                         | Whiteboard                                    |
| Finger under Sketch in Pen mode    | Selects, navigates, or moves an already-selected node while the pen keeps drawing        | Pen-first                                     |
| Empty-canvas finger drag           | Pans                                                                                     | Both                                          |
| Two-finger gesture                 | Pans and zooms through the pointer router                                                | Both                                          |
| Touch node movement                | Requires selection before pointer down                                                   | Both                                          |
| Selection region                   | Explicit Lasso rather than drag-box selection                                            | Pen-first                                     |
| Accidental-input protection        | Select default, activation thresholds, and locked-gesture ownership                      | More conservative than typical pen-first apps |

The distinctive choice is the automatic split: with a pen, physical pointers provide separate drawing and selection channels; without a pen, explicit tools remove the ambiguity. This combines whiteboard predictability with pen-first directness without making a resting finger or pen create ink accidentally.

## Code entry points

| File                                                                                                                                   | Responsibility                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`apps/web/src/store/toolStore.ts`](../../apps/web/src/store/toolStore.ts)                                                             | Persist input preferences, pen observation, and effective-mode resolvers.                    |
| [`apps/web/src/handler/canvasGestureSession.ts`](../../apps/web/src/handler/canvasGestureSession.ts)                                   | Coordinate input-specific pending, locked, cancellation, and takeover state.                 |
| [`apps/web/src/handler/canvasInteractionOwner.ts`](../../apps/web/src/handler/canvasInteractionOwner.ts)                               | Single answer to "can a new gesture take over now", composing the gesture and snap sessions. |
| [`apps/web/src/hooks/useInputMode.ts`](../../apps/web/src/hooks/useInputMode.ts)                                                       | Observe pointer capability and expose the effective input mode.                              |
| [`apps/web/src/components/Panels/Canvas/Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx)                           | Map input modes to React Flow configuration and per-node drag eligibility.                   |
| [`apps/web/src/components/Panels/Canvas/canvasInputPolicy.ts`](../../apps/web/src/components/Panels/Canvas/canvasInputPolicy.ts)       | Define testable input-mode tool mapping and pointer eligibility rules.                       |
| [`apps/web/src/handler/pointerRouter.ts`](../../apps/web/src/handler/pointerRouter.ts)                                                 | Arbitrate pointer ownership: ordered claim offering, observer broadcast, and preempt.        |
| [`apps/web/src/hooks/useCanvasPointerRouter.ts`](../../apps/web/src/hooks/useCanvasPointerRouter.ts)                                   | Install the single capture-phase pointer stream and drive the recognizers.                   |
| [`apps/web/src/handler/canvasNodeAtPoint.ts`](../../apps/web/src/handler/canvasNodeAtPoint.ts)                                         | Shared screen-point → topmost node id hit-test (overlay/pointer-events safe).                |
| [`apps/web/src/handler/canvasPointerRecognizers/`](../../apps/web/src/handler/canvasPointerRecognizers)                                | Node-drag, viewport-navigation, and exclusive click-to-place, Lasso, and Frame recognizers.  |
| [`apps/web/src/hooks/useCanvasGestures.ts`](../../apps/web/src/hooks/useCanvasGestures.ts)                                             | Own trackpad pinch and multi-touch selection cancel.                                         |
| [`apps/web/src/hooks/useCanvasLasso.ts`](../../apps/web/src/hooks/useCanvasLasso.ts)                                                   | Route and cancel Lasso input by effective interaction mode.                                  |
| [`apps/web/src/components/Nodes/sketch/SketchOverlay.tsx`](../../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)               | Route Sketch pointers and commit gesture-local draw or erase mutations.                      |
| [`apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx)             | Present desktop tools or the touch-first Select and Lasso tools.                             |
| [`apps/web/src/components/Settings/sections/GeneralSettings.tsx`](../../apps/web/src/components/Settings/sections/GeneralSettings.tsx) | Present the input preference and resolved Auto value.                                        |
