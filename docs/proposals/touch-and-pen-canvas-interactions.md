# Touch and Pen Canvas Interactions

Status: In-Progress (implemented; physical-device validation pending)
Last updated: 2026-07-18

The implemented contract is documented in [`../architecture/canvas-input-interactions.md`](../architecture/canvas-input-interactions.md), including the shared input-specific activation thresholds and pending/locked arbitration model. This proposal remains in progress until pen-tail eraser support is implemented and the supported browser and physical touch/pen hardware matrix has been validated, including pointer ordering and multi-touch takeover transitions.

## Problem

The canvas currently exposes Select, Pan, and Lasso as explicit tools across mouse, touch, and pen input. That desktop tool model creates unnecessary mode switching on touch-first devices: viewport navigation should be available as a direct gesture, while selecting and moving nodes should remain predictable enough to avoid accidental movement.

Touch and pen input also need distinct interaction modes. In Pen mode, the pen owns selection, movement, lasso, and sketch input while fingers are reserved for viewport navigation. In Finger mode, fingers provide both direct manipulation and viewport navigation. Treating both as one generic non-mouse mode loses that distinction and makes hybrid pen-and-touch use difficult to arbitrate.

## Goals

1. Remove explicit Select and Pan mode switching from the touch-first toolbar while preserving their capabilities as direct gestures.
2. Make one-finger empty-canvas drag pan and let two-finger touch control viewport pan and zoom when it begins before a one-pointer mutation gesture locks.
3. Require a node to be selected before the gesture starts for that gesture to move it.
4. Keep Lasso and Sketch as explicit persistent modes whose single-pointer behavior is unambiguous.
5. Provide explicit Pen and Finger interaction modes instead of granting fingers the same manipulation capabilities whenever a pen is present.
6. Detect Pen mode from real `pointerType === 'pen'` input and provide a manual Auto / Pen / Finger preference because pen capability cannot always be detected before first contact.
7. Drive toolbars, hit targets, hover affordances, and future input adaptations from the pointer currently in use so hybrid devices adapt reactively, keeping that reactive signal separate from the persisted interaction preference.
8. Preserve the existing desktop mouse tool model and keyboard shortcuts.

## Non-Goals

1. Replacing React Flow's viewport or node-drag implementation.
2. Changing canvas commands, persisted canvas data, or undo semantics.
3. Adding platform-specific native gesture APIs.
4. Guaranteeing palm rejection on hardware or browsers that do not expose reliable pointer identity.

## Interaction Contract

| Interaction goal            | Pen mode                                                                                                                          | Finger mode                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Default tool state          | No explicit Select or Pan tool is required; the pen manipulates and fingers navigate.                                             | No explicit Select or Pan tool is required; one finger manipulates targets or pans empty canvas. |
| Select a node               | Tap the node with the pen; a finger touching a node does not select it.                                                           | Tap the node with one finger.                                                                    |
| Move an unselected node     | The first pen gesture selects only; it must not move the node.                                                                    | The first finger gesture selects only; it must not move the node.                                |
| Move a selected node        | Drag with the pen only when the node was selected before pointer down.                                                            | Drag with one finger only when the node was selected before pointer down.                        |
| Move a multi-selection      | Drag any already-selected node with the pen to move the selected group.                                                           | Drag any already-selected node with one finger to move the selected group.                       |
| Pan the canvas              | Drag with one finger, including when the gesture starts over a node; the pen may pan only from empty canvas in the default state. | Drag empty canvas with one finger.                                                               |
| Zoom and pan the viewport   | Use two-finger touch; the pen does not zoom.                                                                                      | Pinch and translate with two fingers.                                                            |
| Clear selection             | Tap empty canvas with the pen.                                                                                                    | Tap empty canvas with one finger.                                                                |
| Enter Lasso                 | Activate the visible Lasso tool.                                                                                                  | Activate the visible Lasso tool.                                                                 |
| Perform a lasso             | Draw on empty canvas with the pen; one-finger touch continues to pan.                                                             | Draw on empty canvas with one finger.                                                            |
| Navigate during Lasso       | One finger pans and two fingers pinch-pan without leaving Lasso.                                                                  | A second finger cancels the pending lasso and transitions to two-finger navigation.              |
| Exit Lasso                  | Lasso remains active until toggled off or replaced by another explicit mode.                                                      | Lasso remains active until toggled off or replaced by another explicit mode.                     |
| Sketch drawing              | Draw with the pen and use pressure when supported; one-finger touch does not draw.                                                | Draw with one finger.                                                                            |
| Sketch erasing              | Use the pen in eraser mode; support a pen-tail eraser when exposed by the browser.                                                | Use the active eraser mode with one finger.                                                      |
| Navigate during Sketch      | Touch navigation may cancel an uncommitted pen stroke before it locks; a locked pen mutation keeps ownership until it ends.       | A second finger cancels an uncommitted stroke and navigates only before the stroke locks.        |
| Scroll node content         | Use the pen on content scroll regions; finger drags remain canvas navigation.                                                     | Content regions own one-finger scrolling and must not move the node.                             |
| Edit text                   | Use the pen to place the caret, select text, or provide supported handwriting input.                                              | Use one finger to place the caret, select text, and invoke the keyboard.                         |
| Activate links and controls | Pen taps operate on-canvas links, buttons, and media controls; fingers still operate application chrome.                          | Finger taps operate links, buttons, media controls, and application chrome.                      |
| Prevent accidental drag     | Use pen-down selection state plus a movement threshold; ignore additional touch pointers that do not own the gesture.             | Use pointer-down selection state plus a movement threshold.                                      |
| Touch-first toolbar         | Show Lasso as the primary selection tool; show Sketch controls while Sketch is active.                                            | Show Lasso as the primary selection tool; show Sketch controls while Sketch is active.           |

## Gesture Arbitration

Gesture ownership is decided from the interaction mode, pointer type, hit target, active explicit mode, pointer count, and selection state captured at pointer down. Selecting an unselected node during pointer down must not make that same gesture eligible to move it. A one-pointer gesture remains pending until it crosses the shared drag threshold or produces a canvas mutation; it is locked after either event.

In Finger mode, an empty-canvas one-finger gesture pans by default. A node gesture moves only an already-selected node; otherwise it resolves to selection without geometry changes. Interactive node content keeps ownership of scrolling, text editing, links, buttons, and media controls. Ownership does not transfer between node content and the canvas during the same gesture, including when a scroll region reaches its boundary.

In Pen mode, pen pointers own on-canvas selection and manipulation while touch pointers own viewport navigation. One-finger touch pans even when it starts over a node, and two-finger touch pinch-pans. Touch must not select or move nodes, draw a lasso, or draw and erase Sketch strokes in this mode. Application chrome remains operable by touch. The app ignores additional touch pointers that do not own the active gesture; it does not claim to identify palms.

Two-finger touch may take over before a one-pointer manipulation commits or crosses its drag threshold. Once a node or Sketch mutation gesture locks, additional touch pointers do not reinterpret that gesture and must not start viewport navigation. Pending lasso paths and uncommitted Sketch strokes are cancellable exceptions: a second finger may discard them and begin pinch-pan. Sketch erasing must collect a gesture-local preview and commit one canvas mutation on pointer up so cancellation leaves no erased strokes or undo entry.

After a second finger takes over, the cancelled pointer cannot resume its previous operation. The viewport gesture remains latched as the pointer count falls from two to one and ends only after all participating touch pointers are released. The remaining pointer must not be reinterpreted as a selection, node drag, lasso, Sketch, link, or control activation. Pinch-pan starts from the viewport and touch positions captured at takeover so the viewport does not jump.

### Hit-Target Priority

Pointer-down ownership follows this priority: application chrome; node controls, links, and resize handles; editable text; scrollable node content; selected-node drag surface; unselected-node selection; empty canvas. A tap activates the captured target, while movement beyond the drag threshold starts only that target's eligible drag behavior. Ownership never transfers to a lower-priority target during the same gesture.

In Pen mode, touch operates application chrome but does not activate on-canvas node content; dragging touch over any canvas content navigates the viewport. Pen input operates on-canvas controls and content. In Finger mode, touch can operate both application chrome and on-canvas content according to the priority above.

### Interaction Mode Selection

The preference is `auto`, `mouse`, `pen`, or `finger` and governs canvas pointer routing, not toolbar density. `mouse`, `pen`, and `finger` are explicit user overrides.

In `auto`, the app resolves to Finger mode until this browser profile has observed a trusted `pointerdown` with `pointerType === 'pen'`. After observation it resolves to Pen mode and persists `penObserved` for subsequent sessions on the same browser profile and origin. Automatic detection must never infer Pen mode from `any-pointer: fine`, because that also matches a mouse. Users whose browser or driver misreports the pen can select Pen or Finger explicitly in Settings; an explicit preference always overrides `penObserved`.

Switching modes must not reinterpret a gesture already in progress. The new mode applies from the next gesture boundary.

## Settings Model

One persisted preference governs which non-mouse pointers reach the canvas; the reactive current pointer governs UI density and tool visibility:

| Setting    | Options                          | Responsibility                                                                                                                                                        |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input mode | `auto`, `mouse`, `pen`, `finger` | Gate which non-mouse pointers reach the canvas and disambiguate pen vs finger. The mouse is never blocked; Mouse mode additionally ignores touchscreen and pen input. |

Toolbar density, tool visibility, activation thresholds, and node-drag affordances follow the pointer currently in use (`useIsNotMouse`) rather than this persisted preference, so a mouse and a finger used on the same hybrid device each get their native experience.

In `auto`, trusted pen observation resolves to Pen, otherwise touch capability resolves to Finger, and environments without either resolve to Mouse. Explicit Mouse, Pen, and Finger choices override capability inference and are never rewritten automatically. Mouse mode rejects touchscreen touch and pen canvas operations while retaining trackpad wheel gestures.

```ts
type InputModePreference = 'auto' | 'mouse' | 'pen' | 'finger';
type EffectiveInputMode = Exclude<InputModePreference, 'auto'>;
```

## Device-Driven UI Behavior

Toolbar contents and affordances follow the pointer currently in use, not the persisted preference. While the mouse is the current pointer the toolbar keeps the Select, Pan, and Lasso tool group and its keyboard shortcuts. While touch or pen is the current pointer, Select and Pan are hidden because direct gestures provide their capabilities and Lasso becomes the visible primary selection tool. Because this follows the current pointer, a hybrid device switches between the two experiences the instant the pointer changes; Mouse mode pins the signal to mouse because it ignores touch and pen.

While touch or pen is the current pointer, Select and Pan collapse to one internal `default` tool. Switching from mouse to touch or pen maps either Select or Pan to `default`; switching back to the mouse maps `default` to Select rather than restoring a hidden prior tool. Lasso, Sketch, and other explicit modes remain active across pointer and input-mode changes. Select and Pan shortcuts must not create hidden tool state while touch or pen is the current pointer; they map to `default` or have no effect. Preference changes during an active gesture apply at the next gesture boundary.

## Acceptance Criteria

1. In Pen mode, one-finger drag pans from empty canvas or a node without selecting or moving nodes, and only the pen can manipulate on-canvas content.
2. In Finger mode, one-finger drag on empty canvas pans, while touching or dragging an unselected node selects it without changing its geometry during that gesture.
3. In either mode, a node selected before the manipulating pointer goes down can be dragged, and dragging one member of a multi-selection moves the group.
4. In Pen mode, Lasso and Sketch accept pen strokes but reject one-finger drawing; in Finger mode, they accept one-finger drawing.
5. A second finger takes over a pending node gesture, lasso, or uncommitted Sketch stroke without a viewport jump or residual mutation; it does not take over a node or Sketch mutation after that gesture locks.
6. Lasso remains explicitly active across completed selections, while mode-appropriate viewport navigation remains available.
7. Auto resolves to Finger until a real pen event is observed, persists `penObserved` per browser profile and origin, resolves subsequent Auto sessions to Pen, and honors explicit Pen and Finger overrides.
8. Auto, Mouse, Pen, and Finger input preferences resolve predictably without overwriting explicit user choices.
9. Mouse mode rejects touchscreen touch and pen canvas operations while retaining mouse and trackpad behavior.
10. Mouse Select, Pan, Lasso, and keyboard behavior remains unchanged.
11. A cancelled gesture cannot resume when the pointer count falls, and no click, selection, drag-stop, lasso, Sketch, link, or control action leaks from its remaining pointer.
12. Sketch erasing commits once on pointer up, produces one undo step, and leaves no mutation when cancelled before commit.
13. While the mouse is the current pointer Select or Pan is available; when touch or pen takes over they collapse to the internal `default`, returning to the mouse maps `default` back to Select, and shortcuts cannot create a hidden Select or Pan state while touch or pen is the current pointer.

## Likely Code Entry Points

| File/dir                                                                                                                                     | Responsibility                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`../../apps/web/src/components/Panels/Canvas/Canvas.tsx`](../../apps/web/src/components/Panels/Canvas/Canvas.tsx)                           | Configure React Flow pan, selection, and node-drag behavior from input and tool state.                   |
| [`../../apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx`](../../apps/web/src/components/Panels/Canvas/CanvasToolbar.tsx)             | Present mouse and touch-first tool choices.                                                              |
| [`../../apps/web/src/hooks/useCanvasGestures.ts`](../../apps/web/src/hooks/useCanvasGestures.ts)                                             | Own two-finger pinch-pan and multi-touch gesture takeover.                                               |
| [`../../apps/web/src/hooks/useCanvasLasso.ts`](../../apps/web/src/hooks/useCanvasLasso.ts)                                                   | Route lasso pointer input and cancel it during multi-touch takeover.                                     |
| [`../../apps/web/src/hooks/useInputMode.ts`](../../apps/web/src/hooks/useInputMode.ts)                                                       | Track observed pointer input; future device-mode resolution must remain separate from gesture ownership. |
| [`../../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx`](../../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)               | Keep draw and erase changes gesture-local until commit and discard them on eligible touch takeover.      |
| [`../../apps/web/src/store/canvasStore.ts`](../../apps/web/src/store/canvasStore.ts)                                                         | Own node-drag gesture snapshots, lock state, cancellation, commit, and undo boundaries.                  |
| [`../../apps/web/src/store/toolStore.ts`](../../apps/web/src/store/toolStore.ts)                                                             | Persist the input preference and pen observation separately from transient gesture ownership.            |
| [`../../apps/web/src/components/Settings/sections/GeneralSettings.tsx`](../../apps/web/src/components/Settings/sections/GeneralSettings.tsx) | Present the input preference and resolved Auto value.                                                    |
