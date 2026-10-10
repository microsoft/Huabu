# Touch and Pen Note Reading

Status: Approved for implementation and device trial
Last updated: 2026-10-10

## Problem

TP-02 in the [touch and pen pain-point list](../backlog/touch-and-pen-usage-pain-points.md) reports that mouse/trackpad users can scroll a selected text node, while direct touch and pen gestures move nodes or navigate the Canvas instead. The existing internal-scroll contract applies to fixed-height Notes with overflowing content, not auto-height Notes that expand to fit.

## Approved trial interaction

For a sole-selected, visible, fixed-height, overflowing read-only Note under Select, cycle through unselected, selected, and reading states using separate taps. The first tap selects the node using existing selection routing. A tap on its selected document body enters reading; dragging instead still moves the node through the existing drag lifecycle. While reading, a finger or pen drag scrolls the document, and a subsequent tap deselects the node. The cycle is state-based, not a timed triple-click gesture.

A scrollbar identifies the active state: touch/pen selection alone shows no scrollbar; entering reading shows a persistent slim thumb, and exiting hides it. A visual-only overlay follows document position and uses the existing scrollbar lane geometry without changing text width. This avoids relying on iPad native scrollbars, which may disappear while idle; native scrollbars remain unchanged for mouse/trackpad use. The earlier visible footer hint is removed, with guidance text deferred pending device feedback; localized instructions remain available to assistive technology only. Reading never enables text editing, selection, link activation, or the software keyboard. The existing toolbar grip remains available for moving the node, and Expand remains the full editor entry. Touch compatibility clicks and double-clicks must not reselect the node or open the expanded editor as a side effect of the cycle.

Content scrolling owns its full gesture, including at document boundaries. A drag that returns to its starting point is still a drag, not an exit tap. A pending touch may yield to two-finger Canvas navigation; a locked content-scroll gesture does not. Cancelled gestures do not cycle state. Explicit Sketch, Lasso, and creation tools keep their existing ownership and exit reading.

Deselecting or selecting another node exits reading but preserves the local document offset for a mounted Note used through this touch-reading path. This offset is transient, not persisted or guaranteed after unmount/reload. Mouse-only selection and wheel behavior are unchanged. Auto-height, missing-content, hidden/minimal, multi-selected, and nonoverflowing Notes do not enter touch reading; PDF, Web, Chat, and expanded editors are out of scope.

## Validation

Cover finger input in both Finger and Pen preferences, pen input in Pen preference, the three-state tap cycle, moving a selected node before reading, internal scroll and boundary containment without node/Canvas movement, retained reading position, cancellation, pending pinch takeover, explicit-tool exclusion, and mouse wheel regressions. Browser automation establishes the routing baseline; real iPad/Apple Pencil and large-touchscreen testing is still required before declaring the device pain point resolved.

Leaving the Canvas during a held scroll must cancel its gesture ownership even if React has already detached the live DOM refs. A regression test navigates away before pointer release, returns without reloading the app, and verifies that Canvas pinch navigation still works.
