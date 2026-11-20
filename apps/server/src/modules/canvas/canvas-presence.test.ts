// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

import { createCanvasPresenceHub } from './canvas-presence.js';

import type { CanvasPresenceEventData } from '@huabu/shared';

function hubAt(options: Parameters<typeof createCanvasPresenceHub>[0] = {}) {
  const clock = { now: 1_000 };
  const hub = createCanvasPresenceHub({ now: () => clock.now, ...options });
  return { hub, clock };
}

function listen(
  hub: ReturnType<typeof createCanvasPresenceHub>,
  space: string,
  pageId?: string,
) {
  const events: CanvasPresenceEventData[] = [];
  const stop = hub.subscribe(space, pageId, (event) => events.push(event));
  return { events, stop };
}

describe('canvas presence hub', () => {
  let active: ReturnType<typeof createCanvasPresenceHub> | undefined;
  afterEach(() => {
    active?.reset();
    active = undefined;
    vi.useRealTimers();
  });

  it('relays a report to the other pages of the Space, never to its author', () => {
    const { hub } = hubAt();
    active = hub;
    const a = listen(hub, 'space', 'page-a');
    const b = listen(hub, 'space', 'page-b');
    const anonymous = listen(hub, 'space');
    const elsewhere = listen(hub, 'other-space', 'page-c');

    expect(
      hub.report('space', {
        pageId: 'page-a',
        label: 'Chrome · macOS',
        pointer: { x: 10, y: 20 },
        selectedNodeIds: ['n1'],
      }),
    ).toBe('accepted');

    const page = {
      pageId: 'page-a',
      colorIndex: 0,
      label: 'Chrome · macOS',
      pointer: { x: 10, y: 20 },
      selectedNodeIds: ['n1'],
      draggingNodeIds: [],
      editingNodeIds: [],
    };
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([{ op: 'update', page }]);
    expect(anonymous.events).toEqual([{ op: 'update', page }]);
    expect(elsewhere.events).toEqual([]);
    expect(hub.snapshot('space', 'page-b')).toEqual([page]);
    expect(hub.snapshot('space', 'page-a')).toEqual([]);
    expect(hub.snapshot('other-space')).toEqual([]);
  });

  it('sends a pointer-only change as a small pointer event and keeps the rest', () => {
    const { hub } = hubAt();
    active = hub;
    hub.report('space', { pageId: 'page-a', selectedNodeIds: ['n1'] });
    const b = listen(hub, 'space', 'page-b');

    hub.report('space', { pageId: 'page-a', pointer: { x: 1, y: 2 } });
    hub.report('space', { pageId: 'page-a', pointer: { x: 1, y: 2 } });
    hub.report('space', { pageId: 'page-a', selectedNodeIds: ['n1'] });
    hub.report('space', { pageId: 'page-a', pointer: null });
    hub.report('space', { pageId: 'page-a', draggingNodeIds: ['n1'] });

    expect(b.events).toEqual([
      { op: 'pointer', pageId: 'page-a', pointer: { x: 1, y: 2 } },
      { op: 'pointer', pageId: 'page-a', pointer: null },
      {
        op: 'update',
        page: expect.objectContaining({
          pointer: null,
          selectedNodeIds: ['n1'],
          draggingNodeIds: ['n1'],
        }),
      },
    ]);
  });

  it('gives present pages different colours and reuses a freed one', () => {
    const { hub } = hubAt();
    active = hub;
    for (const pageId of ['a', 'b', 'c']) hub.report('space', { pageId });
    expect(hub.snapshot('space').map((page) => page.colorIndex)).toEqual([
      0, 1, 2,
    ]);
    hub.leave('space', 'b');
    hub.report('space', { pageId: 'd' });
    expect(
      hub.snapshot('space').find((page) => page.pageId === 'd')?.colorIndex,
    ).toBe(1);
    // A page keeps its colour for as long as it stays.
    hub.report('space', { pageId: 'c', pointer: { x: 0, y: 0 } });
    expect(
      hub.snapshot('space').find((page) => page.pageId === 'c')?.colorIndex,
    ).toBe(2);
  });

  it('drops a page on explicit leave and tells the others once', () => {
    const { hub } = hubAt();
    active = hub;
    hub.report('space', { pageId: 'page-a' });
    const b = listen(hub, 'space', 'page-b');
    hub.leave('space', 'page-a');
    hub.leave('space', 'page-a');
    expect(b.events).toEqual([{ op: 'leave', pageId: 'page-a' }]);
    expect(hub.snapshot('space')).toEqual([]);
  });

  it('drops a page when its last stream closes, not while another is open', () => {
    const { hub } = hubAt();
    active = hub;
    const first = listen(hub, 'space', 'page-a');
    const second = listen(hub, 'space', 'page-a');
    const b = listen(hub, 'space', 'page-b');
    hub.report('space', { pageId: 'page-a' });
    b.events.length = 0;

    first.stop();
    expect(b.events).toEqual([]);
    expect(hub.snapshot('space')).toHaveLength(1);
    second.stop();
    expect(b.events).toEqual([{ op: 'leave', pageId: 'page-a' }]);
    expect(hub.snapshot('space')).toEqual([]);
  });

  it('expires a page that stopped reporting and keeps one that did not', () => {
    const { hub, clock } = hubAt({ expiryMs: 30_000 });
    active = hub;
    hub.report('space', { pageId: 'crashed' });
    hub.report('space', { pageId: 'alive' });
    const b = listen(hub, 'space', 'page-b');

    clock.now += 20_000;
    hub.report('space', { pageId: 'alive' });
    clock.now += 10_000;
    hub.sweep();

    expect(b.events).toEqual([{ op: 'leave', pageId: 'crashed' }]);
    expect(hub.snapshot('space').map((page) => page.pageId)).toEqual(['alive']);
  });

  it('sweeps on its own timer while pages are present', () => {
    vi.useFakeTimers();
    const hub = createCanvasPresenceHub({ expiryMs: 3_000 });
    active = hub;
    hub.report('space', { pageId: 'crashed' });
    const b = listen(hub, 'space', 'page-b');
    vi.advanceTimersByTime(4_000);
    expect(b.events).toEqual([{ op: 'leave', pageId: 'crashed' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses reports beyond the per-page rate and accepts again next second', () => {
    const { hub, clock } = hubAt({ maxReportsPerSecond: 3 });
    active = hub;
    const results = [0, 1, 2, 3].map((x) =>
      hub.report('space', { pageId: 'page-a', pointer: { x, y: 0 } }),
    );
    expect(results).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'rate-limited',
    ]);
    expect(hub.snapshot('space')[0]?.pointer).toEqual({ x: 2, y: 0 });
    clock.now += 1_000;
    expect(
      hub.report('space', { pageId: 'page-a', pointer: { x: 9, y: 0 } }),
    ).toBe('accepted');
  });

  it('refuses a new page once the Space is full, but not a present one', () => {
    const { hub } = hubAt({ maxPagesPerSpace: 2 });
    active = hub;
    expect(hub.report('space', { pageId: 'a' })).toBe('accepted');
    expect(hub.report('space', { pageId: 'b' })).toBe('accepted');
    expect(hub.report('space', { pageId: 'c' })).toBe('full');
    expect(hub.report('space', { pageId: 'a' })).toBe('accepted');
    expect(hub.report('other', { pageId: 'c' })).toBe('accepted');
  });

  it('does not let a caller mutate stored presence through what it was given', () => {
    const { hub } = hubAt();
    active = hub;
    const ids = ['n1'];
    hub.report('space', { pageId: 'page-a', selectedNodeIds: ids });
    ids.push('n2');
    hub.snapshot('space')[0]?.selectedNodeIds.push('n3');
    expect(hub.snapshot('space')[0]?.selectedNodeIds).toEqual(['n1']);
  });

  it('keeps colour indexes inside the shared palette size', () => {
    const { hub } = hubAt();
    active = hub;
    for (let index = 0; index < 20; index += 1)
      hub.report('space', { pageId: `p${index}` });
    for (const page of hub.snapshot('space'))
      expect(page.colorIndex).toBeLessThan(CANVAS_PRESENCE_LIMITS.colorCount);
  });
});

describe('presence entries belong to the principal that reported them', () => {
  let active: ReturnType<typeof createCanvasPresenceHub> | undefined;
  afterEach(() => {
    active?.reset();
    active = undefined;
  });

  const alice = { principalId: 'alice', displayName: 'Alice' };
  const mallory = { principalId: 'mallory', displayName: 'Mallory' };
  function start(options: Parameters<typeof createCanvasPresenceHub>[0] = {}) {
    let minted = 0;
    const made = hubAt({
      createPublicId: () => `public-${(minted += 1)}`,
      ...options,
    });
    active = made.hub;
    return made;
  }
  /** What a viewer of `principalId` receives. */
  function watch(
    hub: ReturnType<typeof createCanvasPresenceHub>,
    principalId: string,
    pageId?: string,
  ) {
    const events: CanvasPresenceEventData[] = [];
    hub.subscribe('space', pageId, (event) => events.push(event), principalId);
    return events;
  }

  it('does not let another principal overwrite a page by quoting its page id', () => {
    const { hub } = start();
    hub.report(
      'space',
      {
        pageId: 'page-a',
        label: 'Alice laptop',
        pointer: { x: 1, y: 2 },
        selectedNodeIds: ['n1'],
      },
      alice,
    );
    expect(
      hub.report(
        'space',
        {
          pageId: 'page-a',
          label: 'Not Alice',
          pointer: { x: 900, y: 900 },
          selectedNodeIds: ['other'],
          editingNodeIds: ['n1'],
        },
        mallory,
      ),
    ).toBe('accepted');

    // Alice's other device sees her page as she reported it, and Mallory's
    // as a second, separate page.
    const seen = hub.snapshot('space', 'page-a2', 'alice');
    expect(seen).toHaveLength(2);
    expect(seen.find((page) => page.pageId === 'page-a')).toMatchObject({
      label: 'Alice laptop',
      pointer: { x: 1, y: 2 },
      selectedNodeIds: ['n1'],
      editingNodeIds: [],
    });
    expect(seen.find((page) => page.pageId !== 'page-a')).toMatchObject({
      label: 'Not Alice',
      displayName: 'Mallory',
    });
  });

  it('does not let another principal evict a page with leave', () => {
    const { hub } = start();
    hub.report('space', { pageId: 'page-a', label: 'A' }, alice);
    hub.leave('space', 'page-a', 'mallory');
    hub.leave('space', 'page-a');
    expect(hub.snapshot('space', undefined, 'alice')).toHaveLength(1);
    // Nor by closing a stream opened under the same page id.
    const stop = hub.subscribe('space', 'page-a', () => undefined, 'mallory');
    stop();
    expect(hub.snapshot('space', undefined, 'alice')).toHaveLength(1);

    hub.leave('space', 'page-a', 'alice');
    expect(hub.snapshot('space', undefined, 'alice')).toEqual([]);
  });

  it("does not let another principal use up a page's rate window", () => {
    const { hub } = start({ maxReportsPerSecond: 3 });
    hub.report('space', { pageId: 'page-a' }, alice);
    for (let index = 0; index < 10; index += 1)
      hub.report(
        'space',
        { pageId: 'page-a', pointer: { x: index, y: 0 } },
        mallory,
      );
    expect(
      hub.report('space', { pageId: 'page-a', pointer: { x: 1, y: 1 } }, alice),
    ).toBe('accepted');
  });

  it('limits what one principal may send across all its pages', () => {
    const { hub, clock } = start({
      maxReportsPerSecond: 100,
      maxReportsPerPrincipalPerSecond: 5,
    });
    const results = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((pageId) =>
      hub.report('space', { pageId }, mallory),
    );
    expect(results.slice(0, 5)).toEqual(Array(5).fill('accepted'));
    expect(results[5]).toBe('rate-limited');
    // Another principal is not affected.
    expect(hub.report('space', { pageId: 'page-a' }, alice)).toBe('accepted');
    clock.now += 1_000;
    expect(hub.report('space', { pageId: 'p6' }, mallory)).toBe('accepted');
  });

  it('does not let one principal take every place of the Space', () => {
    const { hub } = start({ maxPagesPerSpace: 6, maxPagesPerPrincipal: 4 });
    const results = Array.from({ length: 6 }, (_, index) =>
      hub.report('space', { pageId: `squat-${index}` }, mallory),
    );
    expect(results).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'principal-full',
      'principal-full',
    ]);
    expect(hub.report('space', { pageId: 'page-a' }, alice)).toBe('accepted');
    // A page that is present keeps reporting.
    expect(
      hub.report('space', { pageId: 'squat-0', label: 'still here' }, mallory),
    ).toBe('accepted');
  });

  it('takes the edit lock only from a caller who may write the Space', () => {
    const { hub } = start();
    const others = watch(hub, 'alice', 'page-a');
    const reader = { ...mallory, mayHoldEditLock: false };
    expect(
      hub.report(
        'space',
        {
          pageId: 'page-m',
          pointer: { x: 4, y: 5 },
          selectedNodeIds: ['n1'],
          editingNodeIds: Array.from({ length: 200 }, (_, i) => `n${i}`),
        },
        reader,
      ),
    ).toBe('accepted');
    // The viewer is shown, with its pointer and selection, and locks nothing.
    expect(others).toEqual([
      {
        op: 'update',
        page: expect.objectContaining({
          pointer: { x: 4, y: 5 },
          selectedNodeIds: ['n1'],
          editingNodeIds: [],
        }),
      },
    ]);

    // A lock held while the caller could write ends when it no longer can.
    hub.report('space', { pageId: 'page-m', editingNodeIds: ['n9'] }, mallory);
    expect(hub.snapshot('space', undefined, 'alice')[0].editingNodeIds).toEqual(
      ['n9'],
    );
    hub.report('space', { pageId: 'page-m', editingNodeIds: ['n9'] }, reader);
    expect(hub.snapshot('space', undefined, 'alice')[0].editingNodeIds).toEqual(
      [],
    );
  });

  it("shows another principal's page under a server-assigned id and the identity's name; its own pages as reported", () => {
    const { hub } = start();
    const sameOwner = watch(hub, 'alice', 'page-a2');
    const other = watch(hub, 'mallory', 'page-m');
    hub.report('space', { pageId: 'page-a', label: 'Laptop' }, alice);
    hub.report('space', { pageId: 'page-a', pointer: { x: 1, y: 1 } }, alice);
    hub.leave('space', 'page-a', 'alice');

    expect(sameOwner).toEqual([
      { op: 'update', page: expect.objectContaining({ pageId: 'page-a' }) },
      { op: 'pointer', pageId: 'page-a', pointer: { x: 1, y: 1 } },
      { op: 'leave', pageId: 'page-a' },
    ]);
    expect(sameOwner[0]).not.toHaveProperty('page.displayName');
    expect(other).toEqual([
      {
        op: 'update',
        page: expect.objectContaining({
          pageId: 'public-1',
          displayName: 'Alice',
          label: 'Laptop',
        }),
      },
      { op: 'pointer', pageId: 'public-1', pointer: { x: 1, y: 1 } },
      { op: 'leave', pageId: 'public-1' },
    ]);
    // The page id Alice's page uses is never sent to another principal.
    expect(JSON.stringify(other)).not.toContain('page-a');
  });
});
