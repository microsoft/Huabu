// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  PointerRouterCore,
  type PointerRecognizer,
  type RoutablePointerEvent,
} from './pointerRouter';

interface Ctx {
  tag: string;
}

interface Evt extends RoutablePointerEvent {
  pointerId: number;
}

const ev = (pointerId: number): Evt => ({ pointerId });

/** Records the hook calls a recognizer receives, for assertions. */
function spyRecognizer(
  id: string,
  opts: {
    claims?: boolean;
    canClaim?: boolean;
    observe?: boolean;
    preemptOnDown?: boolean;
    preemptOnMove?: boolean;
  } = {},
): PointerRecognizer<Evt, Ctx> & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    calls,
    canClaim: () => opts.canClaim ?? true,
    onDown: (e) => {
      calls.push(`down:${e.pointerId}`);
      return opts.claims === false ? 'pass' : 'claim';
    },
    onMove: (e) => calls.push(`move:${e.pointerId}`),
    onUp: (e) => calls.push(`up:${e.pointerId}`),
    onCancel: (e) => calls.push(`cancel:${e.pointerId}`),
    ...(opts.observe
      ? {
          observe: {
            onDown: (e, ctx) => {
              calls.push(`obs-down:${e.pointerId}`);
              if (opts.preemptOnDown) ctx.preempt();
            },
            onMove: (e, ctx) => {
              calls.push(`obs-move:${e.pointerId}`);
              if (opts.preemptOnMove) ctx.preempt();
            },
            onUp: (e) => calls.push(`obs-up:${e.pointerId}`),
          },
        }
      : {}),
  };
}

const ctx: Ctx = { tag: 'ctx' };

describe('PointerRouterCore', () => {
  it('offers pointerdown in order and stops at the first claimant', () => {
    const a = spyRecognizer('a', { canClaim: false });
    const b = spyRecognizer('b', { claims: true });
    const c = spyRecognizer('c', { claims: true });
    const router = new PointerRouterCore([a, b, c], () => ctx);

    router.handleDown(ev(1));

    // `a` gated out by canClaim, `b` claims, `c` never offered.
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual(['down:1']);
    expect(c.calls).toEqual([]);
    expect(router.ownerOf(1)?.id).toBe('b');
  });

  it('falls through to the next recognizer when one passes', () => {
    const a = spyRecognizer('a', { claims: false });
    const b = spyRecognizer('b', { claims: true });
    const router = new PointerRouterCore([a, b], () => ctx);

    router.handleDown(ev(1));

    expect(a.calls).toEqual(['down:1']);
    expect(b.calls).toEqual(['down:1']);
    expect(router.ownerOf(1)?.id).toBe('b');
  });

  it('routes move / up only to the owner and clears on up', () => {
    const a = spyRecognizer('a', { claims: true });
    const b = spyRecognizer('b', { claims: true });
    const router = new PointerRouterCore([a, b], () => ctx);

    router.handleDown(ev(1));
    router.handleMove(ev(1));
    router.handleUp(ev(1));

    expect(a.calls).toEqual(['down:1', 'move:1', 'up:1']);
    expect(b.calls).toEqual([]);
    expect(router.ownerOf(1)).toBeNull();
  });

  it('routes cancel to the owner and clears ownership', () => {
    const a = spyRecognizer('a', { claims: true });
    const router = new PointerRouterCore([a], () => ctx);

    router.handleDown(ev(1));
    router.handleCancel(ev(1));

    expect(a.calls).toEqual(['down:1', 'cancel:1']);
    expect(router.ownerOf(1)).toBeNull();
  });

  it('keeps separate owners per pointer id', () => {
    const only = spyRecognizer('only', { claims: true });
    const router = new PointerRouterCore([only], () => ctx);

    router.handleDown(ev(1));
    router.handleDown(ev(2));
    router.handleMove(ev(2));
    router.handleUp(ev(1));

    expect(only.calls).toEqual(['down:1', 'down:2', 'move:2', 'up:1']);
    expect(router.ownerOf(1)).toBeNull();
    expect(router.ownerOf(2)?.id).toBe('only');
  });

  it('broadcasts every event to observers regardless of ownership', () => {
    const owner = spyRecognizer('owner', { claims: true });
    const watcher = spyRecognizer('watcher', {
      canClaim: false,
      observe: true,
    });
    const router = new PointerRouterCore([owner, watcher], () => ctx);

    router.handleDown(ev(1));
    router.handleMove(ev(1));
    router.handleUp(ev(1));

    // Watcher never owns the pointer but sees all three events.
    expect(watcher.calls).toEqual(['obs-down:1', 'obs-move:1', 'obs-up:1']);
    expect(owner.calls).toEqual(['down:1', 'move:1', 'up:1']);
  });

  it('lets an observer preempt the current owner and cancel it', () => {
    const owner = spyRecognizer('owner', { claims: true });
    const watcher = spyRecognizer('watcher', {
      canClaim: false,
      observe: true,
      preemptOnDown: true,
    });
    // Owner is offered first; watcher observes the same down and preempts.
    const router = new PointerRouterCore([owner, watcher], () => ctx);

    router.handleDown(ev(1));

    // Observers run before claim offering, so the owner never claims:
    // watcher seizes the pointer on the observed down.
    expect(watcher.calls).toEqual(['obs-down:1']);
    expect(router.ownerOf(1)?.id).toBe('watcher');
    // Owner was never offered onDown because preempt seized the pointer first.
    expect(owner.calls).toEqual([]);

    router.handleMove(ev(1));
    router.handleUp(ev(1));
    expect(router.ownerOf(1)).toBeNull();
  });

  it('preempts an already-established owner mid-gesture', () => {
    const owner = spyRecognizer('owner', { claims: true });
    const watcher = spyRecognizer('watcher', {
      canClaim: false,
      observe: true,
      preemptOnMove: true,
    });
    const router = new PointerRouterCore([owner, watcher], () => ctx);

    router.handleDown(ev(1));
    expect(router.ownerOf(1)?.id).toBe('owner');

    router.handleMove(ev(1));
    // Displaced owner is cancelled; watcher now owns the pointer. Because the
    // observer preempts during the broadcast that precedes owner routing, the
    // displaced owner receives cancel but not this event's onMove.
    expect(owner.calls).toEqual(['down:1', 'cancel:1']);
    expect(router.ownerOf(1)?.id).toBe('watcher');
  });

  it('lets an observer cancel another pointer owner during takeover', () => {
    const owner = spyRecognizer('owner', { claims: true });
    const watcher: PointerRecognizer<Evt, Ctx> = {
      id: 'watcher',
      canClaim: () => false,
      onDown: () => 'pass',
      observe: {
        onDown: (event, observerCtx) => {
          if (event.pointerId === 2) observerCtx.cancelPointer(1);
        },
      },
    };
    const router = new PointerRouterCore([watcher, owner], () => ctx);

    router.handleDown(ev(1));
    expect(router.ownerOf(1)?.id).toBe('owner');

    router.handleDown(ev(2));

    expect(owner.calls).toEqual(['down:1', 'cancel:1', 'down:2']);
    expect(router.ownerOf(1)).toBeNull();
    expect(router.ownerOf(2)?.id).toBe('owner');
  });

  it('does nothing when the context is null', () => {
    const a = spyRecognizer('a', { claims: true });
    const router = new PointerRouterCore<Evt, Ctx>([a], () => null);

    router.handleDown(ev(1));
    router.handleMove(ev(1));
    router.handleUp(ev(1));

    expect(a.calls).toEqual([]);
    expect(router.ownerOf(1)).toBeNull();
  });
});
