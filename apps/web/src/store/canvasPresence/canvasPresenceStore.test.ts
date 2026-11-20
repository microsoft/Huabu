// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCanvasPresenceStore } from './canvasPresenceStore';

import type { CanvasPresenceListener } from '@/store/canvasSyncSubscription';
import type { CanvasPresencePage } from '@huabu/shared';

const stream = vi.hoisted(() => ({
  listener: null as CanvasPresenceListener | null,
  canvasId: null as string | null,
  unsubscribe: vi.fn(),
}));
vi.mock('@/store/canvasStore/sync/pageId', () => ({ CANVAS_PAGE_ID: 'me' }));
vi.mock('@/store/canvasSyncSubscription', () => ({
  subscribeCanvasPresence: (
    canvasId: string,
    listener: CanvasPresenceListener,
  ) => {
    stream.canvasId = canvasId;
    stream.listener = listener;
    return stream.unsubscribe;
  },
}));

function page(
  pageId: string,
  overrides: Partial<CanvasPresencePage> = {},
): CanvasPresencePage {
  return {
    pageId,
    colorIndex: 0,
    label: 'Chrome · Mac',
    pointer: null,
    selectedNodeIds: [],
    draggingNodeIds: [],
    editingNodeIds: [],
    ...overrides,
  };
}

const store = () => useCanvasPresenceStore.getState();

afterEach(() => {
  store().disconnect();
  stream.listener = null;
  vi.clearAllMocks();
});

describe('canvas presence store', () => {
  it('takes the snapshot as the whole set and never keeps this page', () => {
    store().applyEvent({ op: 'update', page: page('stale') });
    store().applyEvent({
      op: 'snapshot',
      pages: [
        page('other', { pointer: { x: 3, y: 4 }, selectedNodeIds: ['n1'] }),
        page('me', { pointer: { x: 9, y: 9 } }),
      ],
    });
    expect(Object.keys(store().pages)).toEqual(['other']);
    expect(store().pages.other).not.toHaveProperty('pointer');
    expect(store().pointers).toEqual({ other: { x: 3, y: 4 } });

    store().applyEvent({ op: 'update', page: page('me') });
    store().applyEvent({
      op: 'pointer',
      pageId: 'me',
      pointer: { x: 1, y: 1 },
    });
    expect(Object.keys(store().pages)).toEqual(['other']);
    expect(store().pointers).toEqual({ other: { x: 3, y: 4 } });
  });

  it('keeps `pages` identical across pointer ticks so outlines do not re-render', () => {
    store().applyEvent({
      op: 'update',
      page: page('other', { selectedNodeIds: ['n1'] }),
    });
    const pages = store().pages;
    const notified = vi.fn();
    const stop = useCanvasPresenceStore.subscribe((state, previous) => {
      if (state.pages !== previous.pages) notified();
    });
    for (let tick = 0; tick < 5; tick += 1)
      store().applyEvent({
        op: 'pointer',
        pageId: 'other',
        pointer: { x: tick, y: tick },
      });
    // A heartbeat repeats the page unchanged apart from its pointer.
    store().applyEvent({
      op: 'update',
      page: page('other', {
        selectedNodeIds: ['n1'],
        pointer: { x: 8, y: 8 },
      }),
    });
    stop();
    expect(store().pages).toBe(pages);
    expect(notified).not.toHaveBeenCalled();
    expect(store().pointers).toEqual({ other: { x: 8, y: 8 } });
  });

  it('replaces a page when what it selects, drags or edits changes', () => {
    store().applyEvent({ op: 'update', page: page('other') });
    const before = store().pages;
    store().applyEvent({
      op: 'update',
      page: page('other', { draggingNodeIds: ['n1'] }),
    });
    expect(store().pages).not.toBe(before);
    expect(store().pages.other?.draggingNodeIds).toEqual(['n1']);
  });

  it('removes the pointer when it leaves the canvas and ignores an unknown page', () => {
    store().applyEvent({
      op: 'update',
      page: page('other', { pointer: { x: 1, y: 1 } }),
    });
    store().applyEvent({ op: 'pointer', pageId: 'other', pointer: null });
    store().applyEvent({
      op: 'pointer',
      pageId: 'unknown',
      pointer: { x: 1, y: 1 },
    });
    expect(store().pointers).toEqual({});
    expect(Object.keys(store().pages)).toEqual(['other']);
  });

  it('drops the page and its pointer on leave', () => {
    store().applyEvent({
      op: 'update',
      page: page('other', { pointer: { x: 1, y: 1 } }),
    });
    store().applyEvent({ op: 'leave', pageId: 'other' });
    expect(store().pages).toEqual({});
    expect(store().pointers).toEqual({});
  });

  it('follows one Space, announces on every snapshot, and clears when the stream drops', () => {
    const announce = vi.fn();
    store().connect('space-1', announce);
    expect(stream.canvasId).toBe('space-1');
    stream.listener?.onEvent({ op: 'snapshot', pages: [page('other')] });
    expect(announce).toHaveBeenCalledOnce();
    expect(Object.keys(store().pages)).toEqual(['other']);

    stream.listener?.onDisconnect();
    expect(store().pages).toEqual({});
    stream.listener?.onEvent({ op: 'snapshot', pages: [] });
    expect(announce).toHaveBeenCalledTimes(2);

    const first = stream.listener;
    store().connect('space-2');
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
    // A late frame from the Space we left is not applied.
    first?.onEvent({ op: 'update', page: page('ghost') });
    expect(store().pages).toEqual({});

    store().disconnect();
    expect(stream.unsubscribe).toHaveBeenCalledTimes(2);
    expect(store().canvasId).toBeNull();
  });
});
