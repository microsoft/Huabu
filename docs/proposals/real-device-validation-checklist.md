# Real-Device Validation Checklist — Canvas Touch/Pen

Status: In-Progress (scratch checklist for manual hardware validation)
Last updated: 2026-07-18

Derived from the interaction contract in [`touch-and-pen-canvas-interactions.md`](./touch-and-pen-canvas-interactions.md) and the remaining "physical-device validation" items in [`canvas-pointer-router.md`](./canvas-pointer-router.md). Use on real touch + pen hardware. Tick each row; record failures with device + browser.

> Recommended order: land the frame double-handling fix (role-based eligibility) first, then run one full pass — otherwise §4 will fail on the current build by design.

## 0. Preconditions

- [ ] A device with both pen and touch (Surface / iPad+Pencil / Android + stylus). Open the app over LAN in the tablet browser.
- [ ] Confirm you can switch, in **Settings → General**: Device mode `Auto / Desktop / Touch`, and Touch interaction mode `Pen / Finger`. Set the mode before each section.
- [ ] Record browser + version + OS + pen hardware per device (matrix at the end).

## 1. Router internals (mode-independent)

- [ ] **Pointer event ordering / no loss**: rapid taps and drags never drop a down/up, jam a gesture, or reorder events.
- [ ] **setPointerCapture**: while dragging, the pointer sliding over other nodes keeps firing move/up (test frame drag, lasso, node drag).
- [ ] **Palm / accidental touch**: a palm resting while the pen hovers or writes produces no extra gesture.
- [ ] **Multi-touch takeover transitions**: a single-finger pending gesture + a second finger transitions smoothly into a two-finger pinch, no jump, no residue.
- [ ] **Post pan/pinch suppression**: after a pan/zoom ends and the pointer lifts, no stray selection, click, or placement fires.
- [ ] **Activation thresholds**: a light tap is a tap (no drag); only past-threshold movement counts as a drag; pen feels most sensitive, touch least.

## 2. Pen mode (pen manipulates, fingers navigate)

- [ ] Pen taps a node → selects; **a finger tapping a node → does NOT select**.
- [ ] Pen taps an unselected node then drags → **selects only, does not move** (first gesture never moves).
- [ ] Pen drags a selected node → moves; with a multi-selection, dragging any already-selected node → moves the group.
- [ ] **One finger dragging on a node → pans the viewport** (in pen mode a finger pans even starting over a node).
- [ ] Pen dragging from empty canvas → may pan (default state); **the pen does not zoom**.
- [ ] Two fingers → pinch zoom + pan.
- [ ] Pen taps empty canvas → clears selection.
- [ ] Lasso: enable the Lasso tool, **pen draws on empty canvas → lasso**; meanwhile **one finger → pans, two fingers → pinch, without leaving Lasso**.
- [ ] Sketch draw: **pen draws (with pressure)**; **one finger does not draw**.
- [ ] Sketch erase: pen in eraser mode erases; if the browser exposes a pen tail, verify the tail eraser (mark N/A if unimplemented).
- [ ] Sketch navigate: touch navigation can cancel an **uncommitted** pen stroke before it locks; a **locked** stroke keeps ownership until it ends.
- [ ] Node content scroll: pen scrolls scrollable content regions; finger drag is still canvas navigation.
- [ ] Text edit: pen places the caret / selects text / handwriting input (if supported).
- [ ] Links & controls: pen taps operate on-canvas links, buttons, media controls; fingers operate application chrome.

## 3. Finger mode (one finger both manipulates and navigates)

- [ ] One finger taps a node → selects; tapping an unselected node then dragging → **selects only, does not move**.
- [ ] One finger drags a selected node → moves; with a multi-selection, dragging any already-selected node → moves the group.
- [ ] One finger drags empty canvas → pans; two fingers → pinch zoom + pan.
- [ ] One finger taps empty canvas → clears selection.
- [ ] Lasso: one finger draws on empty canvas → lasso; **a second finger during the draw cancels the pending lasso and switches to two-finger navigation**.
- [ ] Sketch draw: one finger draws; **a second finger before the stroke locks cancels the stroke and only navigates**.
- [ ] Sketch erase: one finger eraser.
- [ ] Node content scroll: content regions own one-finger scroll and **must not move the node**.
- [ ] Text edit: one finger places the caret and invokes the keyboard.

## 4. Known defects / regression focus

- [ ] ⚠️ **Touch + Pen mode + Frame tool + finger drag**: expected "**pan the viewport only, do NOT create a frame**". **Expected to FAIL on the current build** (it both pans and may create a stray frame on lift). Confirm the repro on real hardware; note whether a frame was actually created.
- [ ] Placement (Text/Note/Question tool armed): a **past-threshold drag places nothing** (only a tap places).
- [ ] After a second finger takes over a lasso, the original pending lasso leaves no residue and no stray selection.
- [ ] With the Sketch tool active, middle-click / two-finger viewport operations still work (the overlay swallows events but pan/zoom still function).

## 5. Device mode (Desktop vs Touch UI adaptation)

- [ ] Touch device mode: the toolbar shows only Lasso (no Select/Pan); hit targets are larger; hover affordances are sensible.
- [ ] Auto mode: after the first pen contact, pen behavior engages automatically; manual Pen/Finger override takes effect.
- [ ] Desktop (mouse) tool model and keyboard shortcuts are unaffected (regression).

## 6. Results matrix (one row per device)

| Device / OS | Browser + version | Pen hardware | §1 internals | §2 Pen | §3 Finger | §4 defects | Notes |
| ----------- | ----------------- | ------------ | ------------ | ------ | --------- | ---------- | ----- |
|             |                   |              |              |        |           |            |       |
