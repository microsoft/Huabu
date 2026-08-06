// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * DOM-independent core of the canvas pointer router.
 *
 * The router owns pointer arbitration for the canvas: it offers each
 * `pointerdown` to an ordered list of recognizers, records the first that
 * claims the pointer, and routes that pointer's later move / up / cancel
 * events only to its owner. A recognizer may additionally register an
 * `observe` block to watch *every* pointer event regardless of ownership
 * and call `preempt()` to seize a pointer from its current owner. That
 * observer channel is what lets two-finger viewport navigation take over
 * an in-progress single-pointer gesture (e.g. a pending lasso).
 *
 * This module is intentionally free of the DOM and React so the
 * arbitration protocol can be unit-tested with plain event-like objects.
 * The React hook that installs capture-phase listeners and supplies the
 * live context lives separately.
 *
 * See `docs/architecture/canvas-input-interactions.md` §6.
 */

export type ClaimResult = 'claim' | 'pass';

/** Minimal shape the core needs from a pointer event. */
export interface RoutablePointerEvent {
  pointerId: number;
}

/** Extra capability handed to `observe` hooks. */
export interface PreemptContext {
  /**
   * Reassign the current pointer's ownership to the observing recognizer,
   * cancelling the displaced owner via its `onCancel`. No-op when the
   * observer already owns the pointer.
   */
  preempt(): void;

  /** Cancel and release the current owner of another tracked pointer. */
  cancelPointer(pointerId: number): void;
}

export interface PointerRecognizer<E extends RoutablePointerEvent, C> {
  /** Stable id used for ordering, logging, and tests. */
  id: string;

  /**
   * Side-effect-free gate. The router only calls `onDown` for recognizers
   * whose `canClaim` returns true for this pointerdown.
   */
  canClaim(event: E, ctx: C): boolean;

  /**
   * Handle the initial pointerdown. Return `'claim'` to own the pointer,
   * or `'pass'` to let the router keep offering to lower-priority
   * recognizers.
   */
  onDown(event: E, ctx: C): ClaimResult;

  onMove?(event: E, ctx: C): void;
  onUp?(event: E, ctx: C): void;
  onCancel?(event: E, ctx: C): void;

  /**
   * Optional global observer. When present, the router forwards every
   * pointer event to these hooks before per-owner routing, regardless of
   * ownership. A hook may call `ctx.preempt()` to seize the pointer.
   */
  observe?: {
    onDown?(event: E, ctx: C & PreemptContext): void;
    onMove?(event: E, ctx: C & PreemptContext): void;
    onUp?(event: E, ctx: C & PreemptContext): void;
    onCancel?(event: E, ctx: C & PreemptContext): void;
  };
}

type ObserveHook = 'onDown' | 'onMove' | 'onUp' | 'onCancel';

export class PointerRouterCore<E extends RoutablePointerEvent, C> {
  private readonly owners = new Map<number, PointerRecognizer<E, C>>();
  private readonly events = new Map<number, E>();

  constructor(
    private readonly recognizers: readonly PointerRecognizer<E, C>[],
    private readonly getContext: () => C | null,
  ) {}

  /** Recognizer currently owning `pointerId`, or `null`. Test/introspection. */
  ownerOf(pointerId: number): PointerRecognizer<E, C> | null {
    return this.owners.get(pointerId) ?? null;
  }

  handleDown(event: E): void {
    const ctx = this.getContext();
    if (ctx === null) return;
    this.events.set(event.pointerId, event);

    this.broadcast('onDown', event, ctx);
    // An observer may have already seized the pointer via preempt().
    if (this.owners.has(event.pointerId)) return;

    for (const recognizer of this.recognizers) {
      if (!recognizer.canClaim(event, ctx)) continue;
      if (recognizer.onDown(event, ctx) === 'claim') {
        this.owners.set(event.pointerId, recognizer);
        return;
      }
    }
  }

  handleMove(event: E): void {
    const ctx = this.getContext();
    if (ctx === null) return;
    this.events.set(event.pointerId, event);
    this.broadcast('onMove', event, ctx);
    this.owners.get(event.pointerId)?.onMove?.(event, ctx);
  }

  handleUp(event: E): void {
    const ctx = this.getContext();
    if (ctx === null) return;
    this.broadcast('onUp', event, ctx);
    const owner = this.owners.get(event.pointerId);
    if (owner) {
      this.owners.delete(event.pointerId);
      owner.onUp?.(event, ctx);
    }
    this.events.delete(event.pointerId);
  }

  handleCancel(event: E): void {
    const ctx = this.getContext();
    if (ctx === null) return;
    this.broadcast('onCancel', event, ctx);
    const owner = this.owners.get(event.pointerId);
    if (owner) {
      this.owners.delete(event.pointerId);
      owner.onCancel?.(event, ctx);
    }
    this.events.delete(event.pointerId);
  }

  private broadcast(hook: ObserveHook, event: E, ctx: C): void {
    for (const recognizer of this.recognizers) {
      const fn = recognizer.observe?.[hook];
      if (!fn) continue;
      const observerCtx: C & PreemptContext = {
        ...ctx,
        preempt: () => this.preempt(recognizer, event, ctx),
        cancelPointer: (pointerId) => this.cancelPointer(pointerId, ctx),
      };
      fn(event, observerCtx);
    }
  }

  private preempt(recognizer: PointerRecognizer<E, C>, event: E, ctx: C): void {
    const current = this.owners.get(event.pointerId);
    if (current === recognizer) return;
    if (current) current.onCancel?.(event, ctx);
    this.owners.set(event.pointerId, recognizer);
  }

  private cancelPointer(pointerId: number, ctx: C): void {
    const owner = this.owners.get(pointerId);
    const event = this.events.get(pointerId);
    if (!owner || !event) return;
    this.owners.delete(pointerId);
    owner.onCancel?.(event, ctx);
  }
}
