# Touch and Pen Usage Pain Points

Status: Backlog
Last reviewed: 2026-10-10

This list collects user-observed touch and pen problems for a later coordinated fix. It is not an approved interaction design or an instruction to implement changes now. Keep observations separate from unverified causes and proposed solutions.

## Collected issues

| ID    | Interaction                                                                | Observed limitation                                                                                                                                                  | State                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TP-01 | Extract part of an Agent reply onto the Canvas                             | Initially reported as unavailable through touch/pen dragging; the user subsequently found that touching the content reveals a "+" action that adds it to the Canvas. | Closed by user: existing alternative meets the need; no fix planned                                                                                    |
| TP-02 | Scroll inside a selected text node in the user-described "auto high" state | Mouse/trackpad users can select the node once and scroll its content, but direct touch needs an explicit distinction between node movement and document scrolling.   | Three-state trial approved; implementation tracked in [Touch and Pen Note Reading](../proposals/touch-note-reading.md); real-device validation pending |

### TP-01: Extract a passage from ChatPanel with touch or pen

- **Disposition (2026-10-10):** The user found that touching the reply content reveals a "+" action for adding it to the Canvas and confirmed that this removes the need for the requested fix. The user clarified that this update applies to TP-01, not TP-02. Keep the original report below for context; it is no longer an active task. This does not establish that six-dot-handle dragging itself works with touch or pen.
- **Reported environments:** iPad with Apple Pencil, and a large touchscreen. The supplied screenshot shows ChatPanel beside the Canvas in iPad Safari.
- **User goal:** Use the six-dot drag handle associated with the desired passage or content block in an Agent reply to extract it onto the Canvas as a content node. The user clarified that the drag starts from this handle, not from the text itself; native text selection is not an established prerequisite.
- **Observed behavior:** The user reports that the workflow is possible with a mouse but not with a finger or pen.
- **Initially perceived impact:** The user could not find a way to reuse a chosen part of an Agent response on the Canvas without switching to a mouse; the subsequently discovered "+" action provides an alternative.
- **Original requested outcome:** Operate the six-dot handle with touch or pen to transfer the intended reply content onto the Canvas. This specific interaction is no longer requested because the existing add action meets the user's need.
- **Unverified details:** Determine whether handle visibility/accessibility, drag initiation from the handle, Canvas drop, or multiple stages are blocked. Verify device/browser-specific behavior and interaction with scrolling and drawing. No root cause or gesture solution has been established.
- **Validation if reopened:** Check six-dot-handle dragging with touch and pen separately on the reported device classes, retain mouse behavior, and verify that the intended content is transferred without accidentally scrolling, drawing, or extracting unrelated reply content. No investigation is planned while this item remains closed.

### TP-02: Scroll text-node content after touch or pen selection

- **Disposition (2026-10-10):** The user approved trying the cycle “tap to select → tap again to read/scroll → tap again to deselect”. The active design is in [Touch and Pen Note Reading](../proposals/touch-note-reading.md); the original observations below remain context, not a competing implementation contract.

- **Reported context:** A text node in the state the user calls "auto high". Preserve this description until its exact sizing/overflow mode is verified rather than assuming an implementation-specific meaning.
- **User goal:** Select the node and scroll within its text content on a touchscreen, as mouse/trackpad users can.
- **Observed desktop behavior:** On a Mac, the user can select the node once using the trackpad-controlled pointer, then scroll its content with the trackpad.
- **Observed touchscreen limitation:** Selecting the node with a finger or pen does not provide an equivalent way to scroll its content.
- **Interaction distinction:** A trackpad provides a separate physical surface for scrolling after selection. Direct touch and pen interaction must share the node's on-screen area with selection, node movement, Canvas navigation, and editing/drawing. This is a constraint for later design discussion, not an established root cause.
- **Impact:** Reading overflowing text inside a node is not equally accessible without mouse/trackpad input.
- **Expected outcome:** Provide a discoverable way to scroll node content on touch devices after targeting the node, with an explicit decision about the respective roles of finger and pen input.
- **Unverified details:** Confirm the exact node type and sizing/overflow state, whether selection succeeds, and which interaction currently receives subsequent finger or pen gestures. Distinguish internal content scrolling from Canvas panning and text selection.
- **Trial decision:** Finger and pen use the approved three-state cycle on eligible read-only Notes. Editing and explicit drawing tools remain separate; actual device feedback will determine whether further changes are needed.
- **Future validation:** Verify access to the full overflowing content on iPad and large touchscreens, predictable transitions between content scrolling and Canvas interaction, and preservation of the existing mouse/trackpad workflow.

## Design references for later investigation

- [Canvas input interactions](../architecture/canvas-input-interactions.md)
- [Web architecture](../architecture/web-architecture.md)
