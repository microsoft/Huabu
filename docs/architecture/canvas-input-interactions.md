# Canvas Input Interactions

> Authoritative input-routing policy for mouse, touch, and pen canvas gestures.
> Last updated: 2026-07-18

## 1. Input preferences

Canvas input uses one persisted preference in `toolStore`, plus a reactive signal that tracks the pointer currently in use.

| Signal                     | Values                           | Responsibility                                                                                                                                                                                                       |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input mode (persisted)     | `auto`, `mouse`, `pen`, `finger` | Gates which non-mouse pointers may reach the canvas and disambiguates whether pen or finger directly manipulates versus navigates.                                                                                   |
| Current pointer (reactive) | mouse vs touch/pen               | Drives UI density and pointer-appropriate affordances — toolbar contents, keyboard-shortcut hints, on-canvas delete buttons, resize-handle size, pan vs box-select, node draggability, and tap-versus-drag distance. |

Auto resolves to Pen after a trusted `pointerdown` reports `pointerType === 'pen'`; the resulting `penObserved` flag persists for the browser profile and origin. Before a pen is observed, Auto resolves to Finger when the browser reports touch capability or observes touch or pen input, and Mouse otherwise. Explicit Mouse, Pen, and Finger preferences always win and are never rewritten by observation.

The mouse is a precise, unambiguous pointer and always operates the canvas — it is never blocked by the input mode. The input mode only decides how the touchscreen and pen behave. Mouse mode additionally ignores touchscreen and pen input entirely: those pointers do not navigate, place nodes, draw Lasso or Sketch gestures, or manipulate content. Trackpad wheel gestures remain available because browsers expose them as wheel input rather than touchscreen pointer events.

The reactive current-pointer signal (`useIsNotMouse`) follows the most recent `pointerdown` so hybrid devices (e.g. Surface) switch between the desktop and touch experiences the instant the pointer changes. Mouse mode pins this signal to mouse because it ignores touch and pen.

## 2. Tool mapping

While the mouse is the current pointer, the toolbar keeps the Select, Pan, and Lasso tools and their existing mouse and keyboard behavior, including shortcut hints and badges.

While touch or pen is active, Sketch is the visible default tool: a pen draws while touch navigates in Pen mode, and touch draws while two-finger input navigates in Finger mode. Select and Pan collapse to the internal direct-manipulation state and are hidden from the touch-first toolbar; Lasso remains available as an explicit alternative. Select and Pan shortcuts both resolve to the internal Select state instead of creating hidden Pan state, and the visible toolbar returns to Sketch whenever no other explicit tool is active. Because the toolbar layout follows the current pointer rather than the persisted mode, a mouse and a finger used on the same hybrid device each get their native toolbar.

New empty canvases carry a one-shot input-appropriate creation intent: Mouse starts with Note armed, while Pen and Finger start with Sketch armed. Existing canvases do not arm Note; Pen and Finger still fall back to the visible Sketch default after any one-shot placement tool finishes.

Lasso and Sketch remain explicit persistent modes across pointer and input-mode changes. Lasso owns only empty-pane gestures, so activating it does not disable dragging nodes that were already selected before pointer down.

## 3. Direct manipulation

While touch or pen is the current pointer, node objects are draggable only when they were selected before the render that precedes pointer down. An unselected-node gesture can therefore select the node but cannot move it during that same gesture; the next gesture can drag it. The mouse always drags nodes directly. Dragging an already-selected member continues to use React Flow's existing multi-selection drag behavior.

Direct-manipulation gestures use a shared screen-space activation policy: touch locks after 8 CSS px, pen after 4 CSS px, and mouse after 1 CSS px. React Flow receives the distance for the current pointer for both node drag activation and click tolerance, while custom pan, Lasso, and Sketch paths choose by each event's pointer type through `canvasGestureSession` and transition from `pending` to `locked`.

The shared values define only the tap-versus-drag activation gate. Feature-specific quantities retain their separate meanings, including Lasso point sampling and minimum polygon span, Frame minimum creation size, Sketch merge distance, eraser radius, and Smart Snap distance.

In Finger mode, one-finger touch on empty canvas owns a pending viewport gesture: releasing below the touch activation distance clears the current selection, while crossing the distance locks and pans without clearing selection. Empty-canvas ownership is determined by excluding nodes and React Flow panels rather than requiring a particular React Flow pane descendant, so Background and other non-interactive canvas layers remain pannable. Node content and selected nodes retain their normal target ownership.

The canvas root suppresses browser long-press callouts and native context menus on non-editable interaction surfaces so they cannot interrupt Pan, Lasso, Sketch, or node manipulation. Text inputs, selects, editable content, and real links retain their native context menus.

In Pen mode, pen input manipulates on-canvas nodes and content while touch input is intercepted before React Flow selection and drives viewport navigation. Touch remains available to application chrome inside React Flow panels.

Click-to-place creation tools such as Note, Text, and Question always accept a mouse click through the pane click handler. Non-mouse placement uses an explicit primary Pointer Events tap gated by the input mode: Pen accepts the pen tip and rejects touch placement; Finger accepts touch and rejects pen placement; Mouse mode rejects both. Placement starts only from empty canvas surfaces and is cancelled when movement reaches the pointer's activation distance.

## 4. Multi-touch navigation

The pointer router's `viewport-navigation` recognizer owns touch navigation through one capture-phase Pointer Events stream from pointer down through move and release. The same stream intercepts React Flow and drives the viewport, avoiding browser-dependent compatibility ordering between Pointer Events and legacy Touch Events. It captures the viewport and initial pointer geometry when the second finger lands; pinch scale is anchored to the takeover midpoint and midpoint translation contributes pan, preventing a viewport jump.

Touches that begin inside React Flow panels remain application-chrome input and are not added to the viewport recognizer's active-touch set. A panel touch therefore cannot become one half of a canvas pinch.

A two-finger navigation gesture remains latched when its pointer count falls to one. The remaining touch is suppressed and cannot resume selection, drag, Lasso, Sketch, link, or control behavior; the gesture ends only after all participating touches are released. A locked one-finger viewport pan may upgrade directly to pinch because both gestures retain viewport ownership.

A live node drag is considered locked while the snap session is active, so a second finger is ignored instead of taking over. When pinch takeover is allowed, the router cancels any owner held by each participating pointer before viewport navigation begins; this prevents a pending click-to-place pointer from committing after the pinch ends. Pending Lasso and Sketch gestures are also cancellable: takeover clears their gesture-local preview before viewport navigation begins. Locked Lasso and Sketch gestures retain ownership and reject takeover.

## 5. Lasso and Sketch routing

In Pen mode, Lasso and Sketch accept pen pointers and reject touch drawing. In Finger mode, they accept touch pointers and reject pen drawing. Mouse mode accepts only mouse pointers. Lasso begins only from the React Flow pane and excludes panels, nodes, edges, and handles. Sketch draw and erase movement is keyed by the active pointer id; only mouse movement additionally requires the primary button bit.

Lasso does not clear selection or expose a path while pending. Crossing the activation distance locks the gesture, clears selection, and starts the preview path; releasing or cancelling before lock has no selection side effect.

Sketch drawing remains gesture-local until pointer up and commits only after the gesture locks. Sketch erasing collects hit stroke ids in a gesture-local map and immediately hides those strokes through the transient gesture preview store, then builds one command batch on pointer up after lock. Cancelling the gesture clears the draw or erase preview and restores hidden strokes, producing no canvas mutation or undo entry.

## 6. Validation boundary

Automated tests cover preference precedence and persistence, Mouse/Pen/Finger tool mapping, direct-manipulation node drag eligibility, Pen/Finger click-to-place routing and activation thresholds, input-specific activation distances, pending/locked/takeover transitions, single-touch navigation ownership, full-lifecycle Pan/Pinch event suppression, fixed-anchor Pinch geometry, zoom clamping, and command generation for Sketch erasing. Browser checks cover non-editable canvas context-menu suppression and editable/link exceptions. Physical-device validation is still required for trusted pointer ordering, first-touch Auto resolution, complete Pan/Pinch event streams, Pen/Finger click-to-place delivery, Lasso and Sketch pointer capture, pen-tail eraser reporting, palm behavior, and multi-touch transitions across supported hardware.

## Code entry points

| File                                                                                                                                   | Responsibility                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`apps/web/src/store/toolStore.ts`](../../apps/web/src/store/toolStore.ts)                                                             | Persist input preferences, pen observation, and effective-mode resolvers.             |
| [`apps/web/src/handler/canvasGestureSession.ts`](../../apps/web/src/handler/canvasGestureSession.ts)                                   | Coordinate input-specific pending, locked, cancellation, and takeover state.          |
| [`apps/web/src/hooks/useInputMode.ts`](../../apps/web/src/hooks/useInputMode.ts)                                                       | Observe pointer capability and expose the effective input mode.                       |
| [`apps/web/src/components/Panels/Canvas/Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx)                           | Map input modes to React Flow configuration and per-node drag eligibility.            |
| [`apps/web/src/components/Panels/Canvas/canvasInputPolicy.ts`](../../apps/web/src/components/Panels/Canvas/canvasInputPolicy.ts)       | Define testable input-mode tool mapping and pointer eligibility rules.                |
| [`apps/web/src/handler/pointerRouter.ts`](../../apps/web/src/handler/pointerRouter.ts)                                                 | Arbitrate pointer ownership: ordered claim offering, observer broadcast, and preempt. |
| [`apps/web/src/hooks/useCanvasPointerRouter.ts`](../../apps/web/src/hooks/useCanvasPointerRouter.ts)                                   | Install the single capture-phase pointer stream and drive the recognizers.            |
| [`apps/web/src/handler/canvasPointerRecognizers/`](../../apps/web/src/handler/canvasPointerRecognizers)                                | Viewport-navigation, click-to-place, and lasso/frame forwarding recognizers.          |
| [`apps/web/src/hooks/useCanvasGestures.ts`](../../apps/web/src/hooks/useCanvasGestures.ts)                                             | Own trackpad pinch and multi-touch selection cancel.                                  |
| [`apps/web/src/hooks/useCanvasLasso.ts`](../../apps/web/src/hooks/useCanvasLasso.ts)                                                   | Route and cancel Lasso input by effective interaction mode.                           |
| [`apps/web/src/components/Nodes/sketch/SketchOverlay.tsx`](../../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)               | Route Sketch pointers and commit gesture-local draw or erase mutations.               |
| [`apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx)             | Present desktop tools or the touch-first Lasso tool.                                  |
| [`apps/web/src/components/Settings/sections/GeneralSettings.tsx`](../../apps/web/src/components/Settings/sections/GeneralSettings.tsx) | Present the input preference and resolved Auto value.                                 |
