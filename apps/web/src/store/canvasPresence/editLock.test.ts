// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/components/Common/Toast';

import { useCanvasPresenceStore } from './canvasPresenceStore';
import {
  canStartEditing,
  editLockHolder,
  selectEditLockHolder,
} from './editLock';

import type { CanvasPresencePage } from '@huabu/shared';

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(() => 'toast-id'),
}));
vi.mock('@/i18n', () => ({
  i18n: {
    t: (key: string, values?: { label?: string }) =>
      values?.label ? `${key}(${values.label})` : key,
  },
}));
vi.mock('@/store/canvasStore/sync/pageId', () => ({ CANVAS_PAGE_ID: 'me' }));
vi.mock('@/store/canvasSyncSubscription', () => ({
  subscribeCanvasPresence: () => () => {},
}));

function page(
  pageId: string,
  overrides: Partial<CanvasPresencePage> = {},
): CanvasPresencePage {
  return {
    pageId,
    colorIndex: 0,
    label: `Device ${pageId}`,
    pointer: null,
    selectedNodeIds: [],
    draggingNodeIds: [],
    editingNodeIds: [],
    ...overrides,
  };
}

const store = () => useCanvasPresenceStore.getState();
const update = (value: CanvasPresencePage) =>
  store().applyEvent({ op: 'update', page: value });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.mocked(toast).mockClear();
  useCanvasPresenceStore.setState({
    canvasId: 'space',
    pages: {},
    pointers: {},
    localEditingNodeId: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('edit lock', () => {
  it('is held by a page that is editing the node, and by nothing less', () => {
    expect(editLockHolder('n1')).toBeNull();
    update(page('a', { selectedNodeIds: ['n1'], draggingNodeIds: ['n1'] }));
    // Selecting or moving a node is not editing it.
    expect(editLockHolder('n1')).toBeNull();

    update(page('a', { editingNodeIds: ['n1'] }));
    expect(editLockHolder('n1')?.pageId).toBe('a');
    expect(editLockHolder('n2')).toBeNull();
    expect(editLockHolder(null)).toBeNull();
  });

  it('is released when the other page stops editing, leaves, or the stream drops', () => {
    update(page('a', { editingNodeIds: ['n1'] }));
    update(page('a', { editingNodeIds: [] }));
    expect(editLockHolder('n1')).toBeNull();

    update(page('a', { editingNodeIds: ['n1'] }));
    store().applyEvent({ op: 'leave', pageId: 'a' });
    expect(editLockHolder('n1')).toBeNull();

    update(page('a', { editingNodeIds: ['n1'] }));
    // What the store does when the Canvas Sync stream ends or fails.
    store().clear();
    expect(editLockHolder('n1')).toBeNull();

    update(page('a', { editingNodeIds: ['n1'] }));
    store().applyEvent({ op: 'snapshot', pages: [] });
    expect(editLockHolder('n1')).toBeNull();
  });

  it('never locks a page out of the node it is itself editing', () => {
    update(page('a', { editingNodeIds: ['n1'] }));
    store().setLocalEditingNodeId('n1');
    expect(editLockHolder('n1')).toBeNull();
    expect(canStartEditing('n1')).toBe(true);

    // Editing another node does not lift the lock on this one.
    store().setLocalEditingNodeId('n2');
    expect(editLockHolder('n1')?.pageId).toBe('a');
  });

  it('names one holder consistently when several pages report the node', () => {
    const pages = {
      b: page('b', { editingNodeIds: ['n1'] }),
      a: page('a', { editingNodeIds: ['n1'] }),
    };
    expect(
      selectEditLockHolder({ pages, localEditingNodeId: null }, 'n1')?.pageId,
    ).toBe('a');
  });

  it('refuses to start editing with one hint per attempt, naming the other page', () => {
    expect(canStartEditing('n1')).toBe(true);
    expect(toast).not.toHaveBeenCalled();

    update(page('a', { editingNodeIds: ['n1'], displayName: ' Mei ' }));
    expect(canStartEditing('n1')).toBe(false);
    // The second click of a double-click is the same attempt.
    expect(canStartEditing('n1')).toBe(false);
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      'canvasPresence.editLocked(Mei)',
      { tone: 'info' },
    );

    vi.advanceTimersByTime(2_000);
    update(page('a', { editingNodeIds: ['n1'], label: '  ' }));
    expect(canStartEditing('n1')).toBe(false);
    expect(toast).toHaveBeenLastCalledWith(
      'canvasPresence.editLocked(canvasPresence.anotherDevice)',
      { tone: 'info' },
    );
  });
});
