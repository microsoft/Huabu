# Canvas Input Interactions

> Authoritative input-routing policy for mouse, touch, and pen canvas gestures.
> Last updated: 2026-07-18

## 1. Input preferences

Canvas input uses two independent persisted preferences in `toolStore`.

| Preference        | Values                     | Responsibility                                                                        |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| Device mode       | `auto`, `desktop`, `touch` | Chooses the overall desktop or touch-first canvas experience.                         |
| Touch interaction | `auto`, `pen`, `finger`    | Chooses which pointer manipulates canvas content while Device mode resolves to Touch. |

Device Auto resolves to Touch when the browser reports touch capability or the current pointer input is touch or pen; otherwise it resolves to Desktop. An explicit Desktop or Touch preference always wins.

Touch navigation also checks the saved Device preference at the pointer-event boundary. In Auto mode, the first trusted touch can therefore claim navigation immediately instead of waiting for the global input-mode listener to trigger a React render; an explicit Desktop preference still rejects touch navigation. Its Pointer Events listeners remain mounted across input-mode and tool-state renders, while current options are read only when a new pointer begins, so the first touch's Auto-mode render cannot discard an active Pan or Pinch session.

Touch interaction Auto resolves to Finger until a trusted `pointerdown` reports `pointerType === 'pen'`. The resulting `penObserved` flag persists for the browser profile and origin, after which Auto resolves to Pen. Explicit Pen and Finger preferences always win and are never rewritten by observation.

The saved Touch interaction preference remains inactive but preserved while Device mode resolves to Desktop.

## 2. Tool mapping

Desktop mode keeps the Select, Pan, and Lasso tools and their existing mouse and keyboard behavior.

Touch mode represents Select and Pan as the internal default state. The toolbar exposes a single Lasso entry without a redundant dropdown arrow and hides Select and Pan; the Lasso entry remains visually inactive until the user explicitly activates it, so displaying the entry does not change the default internal Select state. Select and Pan shortcuts both resolve to the default Select state instead of creating hidden Pan state; returning to Desktop maps that default state to Select.

Lasso and Sketch remain explicit persistent modes across Device mode changes.

## 3. Direct manipulation

Touch-mode node objects are draggable only when they were selected before the render that precedes pointer down. An unselected-node gesture can therefore select the node but cannot move it during that same gesture; the next gesture can drag it. Dragging an already-selected member continues to use React Flow's existing multi-selection drag behavior.

Direct-manipulation gestures use a shared screen-space activation policy: touch locks after 8 CSS px, pen after 4 CSS px, and mouse after 1 CSS px. React Flow receives the distance for the current direct-manipulation mode for both node drag activation and click tolerance (mouse in Desktop, touch in Touch Finger, pen in Touch Pen), while custom pan, Lasso, and Sketch paths choose by each event's pointer type through `canvasGestureSession` and transition from `pending` to `locked`.

The shared values define only the tap-versus-drag activation gate. Feature-specific quantities retain their separate meanings, including Lasso point sampling and minimum polygon span, Frame minimum creation size, Sketch merge distance, eraser radius, and Smart Snap distance.

In Finger mode, one-finger touch on empty canvas owns a pending viewport gesture: releasing below the touch activation distance clears the current selection, while crossing the distance locks and pans without clearing selection. Empty-canvas ownership is determined by excluding nodes and React Flow panels rather than requiring a particular React Flow pane descendant, so Background and other non-interactive canvas layers remain pannable. Node content and selected nodes retain their normal target ownership.

The canvas root suppresses browser long-press callouts and native context menus on non-editable interaction surfaces so they cannot interrupt Pan, Lasso, Sketch, or node manipulation. Text inputs, selects, editable content, and real links retain their native context menus.

In Pen mode, pen input manipulates on-canvas nodes and content while touch input is intercepted before React Flow selection and drives viewport navigation. Touch remains available to application chrome inside React Flow panels.

Click-to-place creation tools such as Note, Text, and Question use mouse click in Desktop workflows and an explicit primary Pointer Events tap in direct-manipulation workflows. Touch Pen accepts the pen tip and rejects touch placement; Touch Finger accepts touch and rejects pen placement. Placement starts only from empty canvas surfaces and is cancelled when movement reaches the pointer's activation distance, while the original mouse click path remains available for Desktop use.

## 4. Multi-touch navigation

`useCanvasGestures` owns touch navigation through one Pointer Events stream from pointer down through move and release. The same stream intercepts React Flow and drives the viewport, avoiding browser-dependent compatibility ordering between Pointer Events and legacy Touch Events. It captures the viewport and initial pointer geometry when the second finger lands; pinch scale is anchored to the takeover midpoint and midpoint translation contributes pan, preventing a viewport jump.

A two-finger navigation gesture remains latched when its pointer count falls to one. The remaining touch is suppressed and cannot resume selection, drag, Lasso, Sketch, link, or control behavior; the gesture ends only after all participating touches are released. A locked one-finger viewport pan may upgrade directly to pinch because both gestures retain viewport ownership.

A live node drag is considered locked while the snap session is active, so a second finger is ignored instead of taking over. Pending Lasso and Sketch gestures are cancellable: takeover clears their gesture-local preview before viewport navigation begins. Locked Lasso and Sketch gestures retain ownership and reject takeover.

## 5. Lasso and Sketch routing

In Touch Pen mode, Lasso and Sketch accept pen pointers and reject touch drawing. In Touch Finger mode, they accept touch pointers and reject pen drawing. Desktop behavior remains pointer-compatible with the existing mouse workflow. Lasso begins only from the React Flow pane and excludes panels, nodes, edges, and handles. Sketch draw and erase movement is keyed by the active pointer id; only mouse movement additionally requires the primary button bit.

Lasso does not clear selection or expose a path while pending. Crossing the activation distance locks the gesture, clears selection, and starts the preview path; releasing or cancelling before lock has no selection side effect.

Sketch drawing remains gesture-local until pointer up and commits only after the gesture locks. Sketch erasing collects hit stroke ids in a gesture-local map and immediately hides those strokes through the transient gesture preview store, then builds one command batch on pointer up after lock. Cancelling the gesture clears the draw or erase preview and restores hidden strokes, producing no canvas mutation or undo entry.

## 6. Validation boundary

Automated tests cover preference precedence and persistence, Desktop/Touch tool mapping, Touch node drag eligibility, Pen/Touch click-to-place routing and activation thresholds, input-specific activation distances, pending/locked/takeover transitions, single-touch navigation ownership, full-lifecycle Pan/Pinch event suppression, fixed-anchor Pinch geometry, zoom clamping, and command generation for Sketch erasing. Browser checks cover non-editable canvas context-menu suppression and editable/link exceptions. Physical-device validation is still required for trusted pointer ordering, first-touch Auto resolution, complete Pan/Pinch event streams, Pen/Touch click-to-place delivery, Lasso and Sketch pointer capture, pen-tail eraser reporting, palm behavior, and multi-touch transitions across supported hardware.

## Code entry points

| File                                                                                                                                   | Responsibility                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`apps/web/src/store/toolStore.ts`](../../apps/web/src/store/toolStore.ts)                                                             | Persist input preferences, pen observation, and effective-mode resolvers.     |
| [`apps/web/src/handler/canvasGestureSession.ts`](../../apps/web/src/handler/canvasGestureSession.ts)                                   | Coordinate input-specific pending, locked, cancellation, and takeover state.  |
| [`apps/web/src/hooks/useInputMode.ts`](../../apps/web/src/hooks/useInputMode.ts)                                                       | Observe pointer type and expose effective Device and Touch interaction modes. |
| [`apps/web/src/components/Panels/Canvas/Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx)                           | Map input modes to React Flow configuration and per-node drag eligibility.    |
| [`apps/web/src/components/Panels/Canvas/canvasInputPolicy.ts`](../../apps/web/src/components/Panels/Canvas/canvasInputPolicy.ts)       | Define testable Desktop/Touch tool mapping and node drag eligibility rules.   |
| [`apps/web/src/hooks/useCanvasGestures.ts`](../../apps/web/src/hooks/useCanvasGestures.ts)                                             | Own touch viewport navigation, multi-touch takeover, and gesture latching.    |
| [`apps/web/src/hooks/useCanvasLasso.ts`](../../apps/web/src/hooks/useCanvasLasso.ts)                                                   | Route and cancel Lasso input by effective interaction mode.                   |
| [`apps/web/src/components/Nodes/sketch/SketchOverlay.tsx`](../../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)               | Route Sketch pointers and commit gesture-local draw or erase mutations.       |
| [`apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx)             | Present desktop tools or the touch-first Lasso tool.                          |
| [`apps/web/src/components/Settings/sections/GeneralSettings.tsx`](../../apps/web/src/components/Settings/sections/GeneralSettings.tsx) | Present the independent input preferences and resolved Auto values.           |
