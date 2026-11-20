// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEditingTracker,
  EDIT_IDLE_RELEASE_MS,
  EDIT_RELEASE_CAP_MS,
} from './editingTracker';

function setup() {
  const page = {
    focused: null as string | null,
    active: true,
    heldElsewhere: false,
  };
  const reports: Array<string | null> = [];
  const local: Array<string | null> = [];
  const saves: Array<{ nodeId: string; settle: () => void }> = [];
  const yielded: string[] = [];
  const tracker = createEditingTracker({
    focusedNodeId: () => page.focused,
    pageActive: () => page.active,
    report: (id) => reports.push(id),
    setLocal: (id) => local.push(id),
    save: (nodeId) =>
      new Promise<void>((resolve) => {
        saves.push({ nodeId, settle: resolve });
      }),
    yieldIfHeldElsewhere: (id) => {
      if (!page.heldElsewhere) return false;
      yielded.push(id);
      // The caller blurs the control.
      page.focused = null;
      return true;
    },
  });
  const focus = (id: string | null) => {
    page.focused = id;
    tracker.sync();
  };
  return { page, reports, local, saves, yielded, tracker, focus };
}

const settled = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('editing tracker', () => {
  it('reports the node as soon as its text control has focus', () => {
    const { reports, local, focus } = setup();
    focus('n1');
    focus('n1');
    expect(reports).toEqual(['n1']);
    expect(local.at(-1)).toBe('n1');
  });

  it('releases the node only after what was typed has been saved', async () => {
    const { reports, local, saves, focus } = setup();
    focus('n1');
    focus(null);

    // This page may be locked out again at once; the others wait for the save.
    expect(local.at(-1)).toBeNull();
    expect(saves.map((save) => save.nodeId)).toEqual(['n1']);
    expect(reports).toEqual(['n1']);

    saves[0].settle();
    await settled();
    expect(reports).toEqual(['n1', null]);
  });

  it('releases after a bounded wait when the save does not settle', async () => {
    const { reports, saves, focus } = setup();
    focus('n1');
    focus(null);

    await vi.advanceTimersByTimeAsync(EDIT_RELEASE_CAP_MS - 1);
    expect(reports).toEqual(['n1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toEqual(['n1', null]);

    // The late answer does not report twice.
    saves[0].settle();
    await settled();
    expect(reports).toEqual(['n1', null]);
  });

  it('keeps the lock when the person is back in the node before the release went out', async () => {
    const { reports, saves, focus } = setup();
    focus('n1');
    focus(null);
    focus('n1');
    saves[0].settle();
    await vi.advanceTimersByTimeAsync(EDIT_RELEASE_CAP_MS);

    expect(reports).toEqual(['n1', 'n1']);
  });

  it('moves the report straight to another node and saves the one left', () => {
    const { reports, saves, focus } = setup();
    focus('n1');
    focus('n2');

    expect(reports).toEqual(['n1', 'n2']);
    expect(saves.map((save) => save.nodeId)).toEqual(['n1']);
  });

  it('stops holding the lock when the page loses focus or is hidden, and takes it back on return', async () => {
    const { page, reports, saves, tracker, focus } = setup();
    focus('n1');

    // The caret stays in the editor of a window nobody is looking at.
    page.active = false;
    tracker.sync();
    saves[0].settle();
    await settled();
    expect(reports).toEqual(['n1', null]);

    page.active = true;
    tracker.sync();
    expect(reports).toEqual(['n1', null, 'n1']);
  });

  it('stops holding the lock after a time without input, and takes it back with the next input', async () => {
    const { reports, saves, tracker, focus } = setup();
    focus('n1');

    // Typing keeps it.
    await vi.advanceTimersByTimeAsync(EDIT_IDLE_RELEASE_MS - 1_000);
    tracker.activity();
    await vi.advanceTimersByTimeAsync(EDIT_IDLE_RELEASE_MS - 1_000);
    expect(reports).toEqual(['n1']);

    await vi.advanceTimersByTimeAsync(1_000);
    saves[0].settle();
    await settled();
    expect(reports).toEqual(['n1', null]);

    tracker.activity();
    expect(reports).toEqual(['n1', null, 'n1']);
  });

  it('gives the control up instead of resuming when another page took the node meanwhile', async () => {
    const { page, reports, local, saves, yielded, tracker, focus } = setup();
    focus('n1');
    page.active = false;
    tracker.sync();
    saves[0].settle();
    await settled();

    page.heldElsewhere = true;
    page.active = true;
    tracker.sync();

    expect(yielded).toEqual(['n1']);
    expect(reports).toEqual(['n1', null]);
    expect(local.at(-1)).toBeNull();
  });

  it('does not take a node another page is editing when a control of it gets focus', () => {
    const { page, reports, local, yielded, focus } = setup();
    page.heldElsewhere = true;
    focus('n1');
    expect(yielded).toEqual(['n1']);
    expect(reports).toEqual([]);
    expect(local).not.toContain('n1');
  });

  it('does not ask whether a node is held elsewhere while this page still reports it', () => {
    const { page, yielded, tracker, focus } = setup();
    focus('n1');
    page.heldElsewhere = true;
    // A window focus event while the page never stopped editing.
    tracker.sync();
    expect(yielded).toEqual([]);
  });

  it('reports nothing after it is stopped', async () => {
    const { reports, saves, tracker, focus } = setup();
    focus('n1');
    focus(null);
    tracker.stop();
    saves[0].settle();
    await vi.advanceTimersByTimeAsync(EDIT_RELEASE_CAP_MS);
    focus('n2');
    expect(reports).toEqual(['n1']);
  });
});
