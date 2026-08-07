# Canvas Pointer Router

Status: Shipped — the authoritative current architecture is [`../architecture/canvas-input-interactions.md`](../architecture/canvas-input-interactions.md).
Last updated: 2026-07-19

This proposal records the design and migration of the single pointer-routing layer through which mouse, touch, and pen gestures are dispatched with explicit ownership and priority. The shipped contract and current implementation are documented in [`../architecture/canvas-input-interactions.md`](../architecture/canvas-input-interactions.md); this record retains the original problem statement, goals, tradeoffs, and rollout history.

## Shipped status

- **Steps 1–3 are implemented.** `PointerRouterCore` (ordered claim, observer broadcast, preempt) drives one capture-phase pointer stream via `useCanvasPointerRouter`. Viewport navigation, click-to-place, and lasso/frame all run through the router; the former JSX pointer fan-out in `Canvas.tsx` is gone. Verified behavior-preserving by a Playwright touch e2e suite (pinch in/out, one-finger pan, placement, frame, lasso) plus the full web unit suite.
- **Sketch stays an overlay (step 4 declined).** `SketchOverlay` is a self-contained full-screen overlay whose pointer handling is tightly coupled to its own SVG preview rendering. It already shares the two things that matter — the `canvasGestureSession` arbiter and `gesturePreviewStore` — so folding its dispatch into the router would split handling from rendering and add coupling for no arbitration gain. Its middle-mouse pan is a deliberate compensating duplicate of React Flow's `panOnDrag={[1]}` (the overlay swallows the events React Flow would otherwise pan on) and cannot be cheaply unified.
- **Validation completed before archival:** the capture-phase model, trusted pointer ordering, pen/finger routing, and multi-touch takeover were validated on iPad with Apple Pencil; the broader recommended hardware regression matrix remains documented in the architecture reference.

## Problem

Canvas pointer input is currently handled in at least five places that run in different event phases and coordinate only implicitly.

- `useCanvasGestures` installs capture-phase native listeners on the wrapper for trackpad pinch, two-finger pinch and pan, single-finger touch pan, and multi-touch selection cancel.
- `Canvas.tsx` attaches bubble-phase React handlers (`onPointerDown/Move/Up/Cancel`) that manually fan out to `useFrameDragToCreate`, `useCanvasLasso`, and an inline click-to-place branch.
- `SketchOverlay` mounts its own overlay listeners while the sketch tool is active.
- `useSketchHoverRouting` and `useAutoPanDuringSelection` add further pointer-driven behavior.

Coordination between these paths relies on two module-level singletons (`canvasGestureSession` for pan / lasso / sketch and `snapSession` for node drag and resize) plus `preventDefault` / `stopPropagation` timing across the capture and bubble phases. The result is correct today but hard to reason about: the full decision for "who owns this pointer" is not visible in any single location, and adding a new gesture means editing the capture-phase hook, the bubble-phase fan-out in `Canvas.tsx`, and possibly both arbiters. This is the maintainability risk flagged in the architecture review as "fragmented pointer entry points" and "manual fan-out".

## Goals

1. Provide one module that owns the canvas wrapper's pointer stream and dispatches every pointer event to registered gesture recognizers in a defined order.
2. Make gesture ownership and takeover priority explicit and inspectable in one place, consolidating the relationship between `canvasGestureSession` and `snapSession` behind the existing `canvasInteractionOwner` façade.
3. Replace the manual fan-out in `Canvas.tsx` so that adding, removing, or reordering a gesture is a single registration change.
4. Preserve the current behavior exactly, including input-specific activation distances, pending / locked / takeover transitions, single-touch navigation ownership, and full-lifecycle Pan / Pinch event suppression.
5. Keep all pure decision logic in testable functions (extending `canvasInputPolicy`) so recognizers stay thin.
6. Enable automated regression via a touch-emulated end-to-end project, so future pointer changes have a guardrail that unit tests cannot provide.

## Non-Goals

1. Replacing React Flow's own viewport, node-drag, or connection pointer handling.
2. Changing the input contract, activation thresholds, tool mapping, or any user-visible behavior.
3. Changing canvas commands, persisted data, or undo semantics.
4. Merging the internal state of `snapSession` into the router; the router consults it through the façade but does not own drag or resize math.

## Design overview

Introduce a `useCanvasPointerRouter` hook and a `PointerRecognizer` contract. The router owns exactly one set of capture-phase pointer listeners on the canvas wrapper and offers each event to an ordered list of recognizers. Each existing pointer concern (viewport navigation, frame drag-to-create, lasso, sketch, click-to-place) becomes a recognizer with the same behavior it has today; the router replaces both the ad-hoc capture listeners in `useCanvasGestures` and the bubble-phase fan-out in `Canvas.tsx`.

The router does not itself decide gesture semantics. It enforces the arbitration protocol — offer order, claim, ownership, and release — while each recognizer keeps its own domain logic. All cross-recognizer ownership questions route through `canvasInteractionOwner`, so there remains a single answer to "can a new gesture take over right now".

## Recognizer contract

```ts
type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

interface PointerRouterContext {
  wrapper: HTMLDivElement;
  rfInstance: ReactFlowInstance;
  inputMode: EffectiveInputMode;
}

interface PointerRecognizer {
  /** Stable id used for ordering, logging, and tests. */
  id: string;

  /**
   * Fast, side-effect-free gate. Returns true only when this recognizer
   * could own a gesture that starts from this pointerdown, given the
   * current tool, input mode, and event target. Pure — delegates to
   * `canvasInputPolicy` predicates. The router only calls `onDown` for
   * recognizers whose `canClaim` returns true.
   */
  canClaim(event: PointerEvent, ctx: PointerRouterContext): boolean;

  /**
   * Handle the initial pointerdown. Return `'claim'` to become the owner
   * of this pointer (the router routes its subsequent move/up/cancel to
   * this recognizer and stops offering the pointer to others), or
   * `'pass'` to let the router continue offering to lower-priority
   * recognizers.
   */
  onDown(event: PointerEvent, ctx: PointerRouterContext): 'claim' | 'pass';

  onMove?(event: PointerEvent, ctx: PointerRouterContext): void;
  onUp?(event: PointerEvent, ctx: PointerRouterContext): void;
  onCancel?(event: PointerEvent, ctx: PointerRouterContext): void;

  /**
   * Optional global observer. When present, the router forwards *every*
   * pointer event to these hooks regardless of ownership, before the
   * per-owner routing. A hook may call `ctx.preempt()` to seize
   * ownership of the pointer from the current owner (cancelling that
   * owner via `onCancel`). This models two-finger navigation taking over
   * an in-progress single-pointer gesture: viewport-navigation must track
   * every touch even while another recognizer owns the first finger, so
   * that the second finger can preempt into a pinch.
   */
  observe?: {
    onDown?(event: PointerEvent, ctx: PointerRouterObserverContext): void;
    onMove?(event: PointerEvent, ctx: PointerRouterObserverContext): void;
    onUp?(event: PointerEvent, ctx: PointerRouterObserverContext): void;
    onCancel?(event: PointerEvent, ctx: PointerRouterObserverContext): void;
  };
}
```

`PointerRouterObserverContext` extends `PointerRouterContext` with `preempt(): void`, which reassigns the current pointer's ownership to the observing recognizer and calls the displaced owner's `onCancel`. Ownership is still one recognizer per pointer id; the observer channel only lets a recognizer _watch_ pointers it does not own and _escalate_ to owning them.

Recognizers never call `addEventListener` themselves. They receive already-dispatched events from the router and use `event.preventDefault()` / `event.stopPropagation()` only when they own the pointer, exactly as the current code does.

## Event phase model

The router installs capture-phase listeners on the wrapper, matching today's `useCanvasGestures`. Capture is required because the router must be able to intercept a gesture before React Flow's own pane and d3-zoom listeners, which are attached on descendant elements (the pane and viewport) and therefore run after a wrapper capture listener. This is the same reason the current touch-navigation hook uses capture. The bubble-phase React handlers currently in `Canvas.tsx` are folded into recognizers so there is a single phase and a single ordering.

One deliberate consequence: recognizers that today rely on React's synthetic bubble handlers (frame drag, lasso, placement) will move to capture-phase native events. Their internal logic is unchanged, but the phase change must be validated on device, because capture-versus-bubble ordering interacts with React Flow's own handlers and with `setPointerCapture`.

## Ownership and takeover priority

The router offers each `pointerdown` to recognizers in a fixed priority order and stops at the first that returns `'claim'`. Priority encodes the current implicit rules:

| Priority | Recognizer            | Claims when (summary of today's behavior)                                                                                                                                                        |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | `viewport-navigation` | Touch pointer eligible for single-finger pan or two-finger pinch per `shouldOwnSingleTouchNavigation`; a second touch can take over pending pan / lasso / sketch via `canTouchTakeOverForPinch`. |
| 2        | `sketch`              | Sketch tool active and the pointer type matches the effective interaction mode.                                                                                                                  |
| 3        | `frame-drag`          | Frame creation pending and the target is not a panel.                                                                                                                                            |
| 4        | `lasso`               | Lasso tool active and the target is an empty pane (or a node tap on touch / pen).                                                                                                                |
| 5        | `click-to-place`      | A creation tool is pending and `canPlaceNodeWithPointer` accepts the pointer on an empty pane target.                                                                                            |

Cross-recognizer takeover — for example a second finger converting an in-progress lasso into a pinch — is expressed through the observer / `preempt()` channel above and remains governed by `canvasGestureSession` (pending versus locked) and `snapSession` (active node drag), both consulted only through `canvasInteractionOwner`. `viewport-navigation` registers an `observe` block so it tracks every touch pointer even when another recognizer owns the first finger; when the second touch lands and `canTouchTakeOverForPinch()` allows it, the observer calls `preempt()` to seize the gesture and cancel the displaced lasso or sketch preview. The router itself holds no gesture-specific state beyond the current owner per active pointer id and the set of observers.

An active node drag is not a router recognizer: it is driven by React Flow and tracked by `snapSession`. The router treats it as an external owner by asking `canvasInteractionOwner` before letting a touch take over, preserving the rule that a live drag rejects a second finger.

## Router responsibilities

- Maintain a `Map<pointerId, PointerRecognizer>` of active owners so move / up / cancel route only to the owner.
- Before per-owner routing, forward every pointer event to each recognizer's optional `observe` hooks so a recognizer can track pointers it does not own and call `preempt()` to seize them.
- Offer `pointerdown` to recognizers in priority order, calling `onDown` only for those whose `canClaim` passed, and record the first claimant.
- Route `pointermove`, `pointerup`, and `pointercancel` for an owned pointer to its owner, then clear the entry on up / cancel.
- Never mutate gesture state directly; recognizers own their own preview stores and session calls.
- Remain mounted across input-mode and tool-state renders, reading current options from a ref, so a re-render mid-gesture cannot drop an active owner. This preserves the property already documented for touch navigation.

## Incremental migration plan

Each step is behavior-preserving, independently committed, and verified by the existing unit suite plus manual device smoke where the phase changes.

1. Add the `PointerRecognizer` type and a DOM-independent `PointerRouterCore` (owner map, priority offer, observer broadcast, and `preempt`) with unit tests using synthetic recognizers. Not yet wired into `Canvas.tsx`; zero runtime behavior change.
2. Move two-finger pinch, single-finger pan, and multi-touch cancel out of `useCanvasGestures` into a `viewport-navigation` recognizer. Keep the trackpad-wheel handler where it is or move it alongside as a non-pointer concern. Verify pinch geometry and single-touch ownership tests still pass.
3. Convert `useCanvasLasso`, `useFrameDragToCreate`, and the inline placement branch into recognizers and delete the fan-out in `Canvas.tsx`.
4. Convert `SketchOverlay` pointer handling to a recognizer, or keep the overlay but route its pointers through the same registry, so sketch takeover uses the shared protocol.
5. Remove the now-empty capture wiring from `useCanvasGestures`, leaving it as a thin adapter or deleting it once all concerns have moved.

At every step the router and each recognizer must produce the same `preventDefault` / `stopPropagation` decisions as the code it replaces.

## Testing strategy

- Unit: keep `canvasInputPolicy`, `canvasGestureSession`, and the new `canvasInteractionOwner` predicates fully covered, and add router-level tests that assert offer order, claim-stops-offering, and owner routing for move / up / cancel using synthetic recognizers.
- End-to-end: add a Playwright project configured with `use: { hasTouch: true, isMobile: true }` and drive `page.touchscreen` for two-finger pinch, single-finger pan takeover, and lasso. This is the guardrail that unit tests cannot provide and that ad-hoc `Input.dispatchTouchEvent` against a non-touch context could not exercise.
- Device: the physical-device matrix already required by the input contract still applies — trusted pointer ordering, pen-tail eraser, palm behavior, and multi-touch transitions cannot be certified in emulation.

## Risks and open questions

1. Capture-phase migration of frame, lasso, and placement changes their ordering relative to React Flow's own handlers and `setPointerCapture`; this is the highest-risk part and needs device validation.
2. Recognizer priority hard-codes today's implicit precedence; any disagreement with the shipped behavior would surface as a subtle regression, so the priority table must be reviewed against `canvas-input-interactions.md` before implementation.
3. The trackpad-wheel handler is not a pointer concern; deciding whether it lives in the router or stays separate is an open call.
4. Sketch currently owns a full-screen overlay; whether it becomes a recognizer or stays an overlay that borrows the registry affects how takeover cancellation is wired.

## Acceptance

This proposal is ready to implement when the priority table and recognizer contract are approved and the touch-emulated end-to-end project is agreed as the automated guardrail. Implementation folds this document's contract into `../architecture/canvas-input-interactions.md` and this proposal is archived once the physical-device matrix has been validated.
