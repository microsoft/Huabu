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
