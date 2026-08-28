// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  activateTab,
  activeTabOfGroup,
  closeTab,
  conversationInOtherGroup,
  createEmptyWorkspace,
  findTabByTarget,
  groupOfTab,
  isSamePreviewTarget,
  mergeGroups,
  moveTab,
  openTarget,
  promoteTab,
  replaceTabTarget,
  setActiveGroup,
  setSplitRatio,
  validateWorkspace,
  type CanvasPreviewWorkspace,
  type PreviewTarget,
} from './model';

const CANVAS = 'canvas-1';

function node(nodeId: string, canvasId = CANVAS): PreviewTarget {
  return { kind: 'node', canvasId, nodeId };
}

function chat(threadId: string, canvasId = CANVAS): PreviewTarget {
  return { kind: 'chat', canvasId, threadId };
}

/** Deterministic ids so assertions can name tabs and groups directly. */
function open(
  workspace: CanvasPreviewWorkspace,
  target: PreviewTarget,
  tabId: string,
  options?: Parameters<typeof openTarget>[2],
  groupId = `g-${tabId}`,
) {
  return openTarget(workspace, target, options, { tabId, groupId });
}

function emptyWorkspace() {
  return createEmptyWorkspace('g1');
}

describe('conversationInOtherGroup', () => {
  it('returns the unbound Chat visible beside the source node', () => {
    const source = open(emptyWorkspace(), node('pdf'), 'pdf').workspace;
    const workspace = open(source, chat('thread-chat'), 'chat', {
      openToSide: true,
    }).workspace;

    expect(
      conversationInOtherGroup(workspace, node('pdf'), () => undefined),
    ).toEqual({ tabId: 'chat', threadId: 'thread-chat' });
  });

  it('resolves a Question Chat visible beside the source node', () => {
    const source = open(emptyWorkspace(), node('pdf'), 'pdf').workspace;
    const workspace = open(source, node('question'), 'question', {
      openToSide: true,
    }).workspace;

    expect(
      conversationInOtherGroup(workspace, node('pdf'), (nodeId) =>
        nodeId === 'question' ? 'thread-question' : undefined,
      ),
    ).toEqual({ tabId: 'question', threadId: 'thread-question' });
  });

  it('returns null in a single group or when the other target is not Chat', () => {
    const single = open(emptyWorkspace(), node('pdf'), 'pdf').workspace;
    const split = open(single, node('note'), 'note', {
      openToSide: true,
    }).workspace;

    expect(
      conversationInOtherGroup(single, node('pdf'), () => undefined),
    ).toBeNull();
    expect(
      conversationInOtherGroup(split, node('pdf'), () => undefined),
    ).toBeNull();
    expect(
      conversationInOtherGroup(split, node('missing'), () => 'thread-note'),
    ).toBeNull();
  });
});

function tabIdsOf(workspace: CanvasPreviewWorkspace, groupIndex: number) {
  return workspace.groups[groupIndex].tabIds;
}

describe('isSamePreviewTarget', () => {
  it('compares node targets by canvas and node', () => {
    expect(isSamePreviewTarget(node('a'), node('a'))).toBe(true);
    expect(isSamePreviewTarget(node('a'), node('b'))).toBe(false);
    expect(isSamePreviewTarget(node('a'), node('a', 'canvas-2'))).toBe(false);
  });

  it('compares chat targets by canvas and thread', () => {
    expect(isSamePreviewTarget(chat('t1'), chat('t1'))).toBe(true);
    expect(isSamePreviewTarget(chat('t1'), chat('t2'))).toBe(false);
  });

  it('never equates a node with a chat', () => {
    expect(isSamePreviewTarget(node('a'), chat('a'))).toBe(false);
  });
});

describe('openTarget', () => {
  it('opens into the active group and focuses the new tab', () => {
    const { workspace, tabId } = open(emptyWorkspace(), node('a'), 't1');

    expect(tabId).toBe('t1');
    expect(tabIdsOf(workspace, 0)).toEqual(['t1']);
    expect(workspace.groups[0].activeTabId).toBe('t1');
    expect(workspace.activeGroupId).toBe('g1');
  });

  it('reveals an already-open target instead of duplicating it', () => {
    const first = open(emptyWorkspace(), node('a'), 't1').workspace;
    const second = open(first, node('b'), 't2').workspace;
    const again = open(second, node('a'), 't3');

    expect(again.tabId).toBe('t1');
    expect(Object.keys(again.workspace.tabs)).toHaveLength(2);
    expect(again.workspace.groups[0].activeTabId).toBe('t1');
  });

  it('creates the side group and puts the target there', () => {
    const first = open(emptyWorkspace(), node('a'), 't1').workspace;
    const { workspace, tabId } = open(first, node('b'), 't2', {
      openToSide: true,
    });

    expect(workspace.groups).toHaveLength(2);
    expect(tabIdsOf(workspace, 0)).toEqual(['t1']);
    expect(tabIdsOf(workspace, 1)).toEqual([tabId]);
    expect(workspace.activeGroupId).toBe(workspace.groups[1].id);
  });

  it('moves an existing tab to the side rather than cloning it', () => {
    const first = open(emptyWorkspace(), node('a'), 't1').workspace;
    const second = open(first, node('b'), 't2').workspace;
    const sided = open(second, node('a'), 'unused', { openToSide: true });

    expect(sided.tabId).toBe('t1');
    expect(Object.keys(sided.workspace.tabs)).toHaveLength(2);
    expect(tabIdsOf(sided.workspace, 0)).toEqual(['t2']);
    expect(tabIdsOf(sided.workspace, 1)).toEqual(['t1']);
  });

  it('reveals a target that already lives in the other group', () => {
    const first = open(emptyWorkspace(), node('a'), 't1').workspace;
    const sided = open(first, node('b'), 't2', { openToSide: true }).workspace;
    const back = setActiveGroup(sided, sided.groups[0].id);

    const again = open(back, node('b'), 'unused');

    expect(again.tabId).toBe('t2');
    expect(Object.keys(again.workspace.tabs)).toHaveLength(2);
    expect(again.workspace.activeGroupId).toBe(again.workspace.groups[1].id);
  });

  it('never grows past two groups', () => {
    const a = open(emptyWorkspace(), node('a'), 't1').workspace;
    const b = open(a, node('b'), 't2', { openToSide: true }).workspace;
    const c = open(b, node('c'), 't3', { openToSide: true }).workspace;

    expect(c.groups).toHaveLength(2);
  });
});

describe('transient tabs', () => {
  it('reuses the group inspection slot in place', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const second = open(first, node('b'), 'unused', { transient: true });

    expect(second.tabId).toBe('t1');
    expect(Object.keys(second.workspace.tabs)).toEqual(['t1']);
    expect(second.workspace.tabs['t1'].target).toEqual(node('b'));
    expect(tabIdsOf(second.workspace, 0)).toEqual(['t1']);
  });

  it('appends rather than reusing when the open is permanent', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const second = open(first, node('b'), 't2').workspace;

    expect(tabIdsOf(second, 0)).toEqual(['t1', 't2']);
    expect(second.tabs['t1'].transient).toBe(true);
    expect(second.tabs['t2'].transient).toBe(false);
  });

  it('stops being reusable once promoted', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const promoted = promoteTab(first, 't1');
    const second = open(promoted, node('b'), 't2', { transient: true });

    expect(second.tabId).toBe('t2');
    expect(tabIdsOf(second.workspace, 0)).toEqual(['t1', 't2']);
  });

  it('promotes the slot when its target is revisited explicitly', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const revisited = open(first, node('a'), 'unused').workspace;

    expect(revisited.tabs['t1'].transient).toBe(false);
  });

  it('keeps the slot transient when its target is browsed again', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const revisited = open(first, node('a'), 'unused', {
      transient: true,
    }).workspace;

    expect(revisited.tabs['t1'].transient).toBe(true);
  });

  it('keeps a transient tab transient when moving it to the side', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const second = open(first, node('b'), 't2').workspace;
    const sided = open(second, node('a'), 'unused', {
      transient: true,
      openToSide: true,
    }).workspace;

    expect(sided.tabs['t1'].transient).toBe(true);
    expect(sided.groups).toHaveLength(2);
    expect(tabIdsOf(sided, 0)).toEqual(['t2']);
    expect(tabIdsOf(sided, 1)).toEqual(['t1']);
  });

  it('keeps each group inspection slot separate', () => {
    const a = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const b = open(a, node('b'), 't2', {
      transient: true,
      openToSide: true,
    }).workspace;

    expect(Object.keys(b.tabs)).toHaveLength(2);
    expect(tabIdsOf(b, 0)).toEqual(['t1']);
    expect(tabIdsOf(b, 1)).toEqual(['t2']);
  });
});

describe('replaceTabTarget', () => {
  it('converts a chat tab into a node tab in place', () => {
    const first = open(emptyWorkspace(), chat('thread-1'), 't1').workspace;
    const converted = replaceTabTarget(first, 't1', node('question-1'));

    expect(converted.tabs['t1'].target).toEqual(node('question-1'));
    expect(tabIdsOf(converted, 0)).toEqual(['t1']);
    expect(converted.groups[0].activeTabId).toBe('t1');
  });

  it('refuses a conversion that would duplicate an open target', () => {
    const a = open(emptyWorkspace(), chat('thread-1'), 't1').workspace;
    const b = open(a, node('question-1'), 't2').workspace;

    expect(replaceTabTarget(b, 't1', node('question-1'))).toBe(b);
  });
});

describe('closeTab', () => {
  it('activates the nearest remaining tab in the same group', () => {
    let ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    ws = open(ws, node('b'), 't2').workspace;
    ws = open(ws, node('c'), 't3').workspace;
    ws = activateTab(ws, 't2');

    const closed = closeTab(ws, 't2');
    expect(tabIdsOf(closed, 0)).toEqual(['t1', 't3']);
    expect(closed.groups[0].activeTabId).toBe('t3');
  });

  it('falls back to the previous tab when closing the last one', () => {
    let ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    ws = open(ws, node('b'), 't2').workspace;

    const closed = closeTab(ws, 't2');
    expect(closed.groups[0].activeTabId).toBe('t1');
  });

  it('leaves the other group untouched when closing an inactive tab', () => {
    let ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    ws = open(ws, node('b'), 't2').workspace;
    ws = activateTab(ws, 't1');

    const closed = closeTab(ws, 't2');
    expect(closed.groups[0].activeTabId).toBe('t1');
  });

  it('removes a group once its last tab closes', () => {
    const a = open(emptyWorkspace(), node('a'), 't1').workspace;
    const b = open(a, node('b'), 't2', { openToSide: true }).workspace;

    const closed = closeTab(b, 't2');
    expect(closed.groups).toHaveLength(1);
    expect(closed.activeGroupId).toBe('g1');
    expect(closed.splitRatio).toBe(0.5);
  });

  it('keeps the sole group when the workspace empties', () => {
    const ws = open(emptyWorkspace(), node('a'), 't1').workspace;

    const closed = closeTab(ws, 't1');
    expect(closed.groups).toHaveLength(1);
    expect(closed.groups[0].tabIds).toEqual([]);
    expect(closed.groups[0].activeTabId).toBeNull();
  });
});

describe('moveTab', () => {
  it('reorders within a group', () => {
    let ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    ws = open(ws, node('b'), 't2').workspace;
    ws = open(ws, node('c'), 't3').workspace;

    const moved = moveTab(ws, 't3', { groupId: 'g1', index: 0 });
    expect(tabIdsOf(moved, 0)).toEqual(['t3', 't1', 't2']);
  });

  it('moves across groups at the requested index', () => {
    let ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    ws = open(ws, node('b'), 't2').workspace;
    ws = open(ws, node('c'), 't3', { openToSide: true }).workspace;
    const sideGroupId = ws.groups[1].id;

    const moved = moveTab(ws, 't2', { groupId: sideGroupId, index: 0 });
    expect(moved.groups).toHaveLength(2);
    expect(tabIdsOf(moved, 0)).toEqual(['t1']);
    expect(tabIdsOf(moved, 1)).toEqual(['t2', 't3']);
    expect(moved.groups[0].activeTabId).toBe('t1');
  });

  it('replaces the destination transient tab with the moved one', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const split = open(first, node('b'), 't2', {
      transient: true,
      openToSide: true,
    }).workspace;
    const sideGroupId = split.groups[1].id;

    const moved = moveTab(split, 't1', { groupId: sideGroupId });

    expect(moved.groups).toHaveLength(1);
    expect(moved.tabs['t1'].transient).toBe(true);
    expect(moved.tabs['t2']).toBeUndefined();
    expect(moved.groups[0].tabIds).toEqual(['t1']);
  });

  it('collapses the source group when its last tab leaves', () => {
    const a = open(emptyWorkspace(), node('a'), 't1').workspace;
    const b = open(a, node('b'), 't2', { openToSide: true }).workspace;
    const sideGroupId = b.groups[1].id;

    const moved = moveTab(b, 't1', { groupId: sideGroupId });
    expect(moved.groups).toHaveLength(1);
    expect(moved.groups[0].tabIds).toEqual(['t2', 't1']);
  });

  it('ignores an unknown destination group', () => {
    const ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    expect(moveTab(ws, 't1', { groupId: 'nope' })).toBe(ws);
  });
});

describe('mergeGroups', () => {
  it('folds the side group back into the first', () => {
    const a = open(emptyWorkspace(), node('a'), 't1').workspace;
    const b = open(a, node('b'), 't2', { openToSide: true }).workspace;

    const merged = mergeGroups(b);
    expect(merged.groups).toHaveLength(1);
    expect(merged.groups[0].tabIds).toEqual(['t1', 't2']);
    expect(merged.activeGroupId).toBe('g1');
  });

  it('drops older transient tabs when merging groups', () => {
    const first = open(emptyWorkspace(), node('a'), 't1', {
      transient: true,
    }).workspace;
    const split = open(first, node('b'), 't2', {
      transient: true,
      openToSide: true,
    }).workspace;

    const merged = mergeGroups(split);

    expect(merged.tabs['t1']).toBeUndefined();
    expect(merged.tabs['t2'].transient).toBe(true);
    expect(merged.groups[0].tabIds).toEqual(['t2']);
  });

  it('is a no-op with a single group', () => {
    const ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    expect(mergeGroups(ws)).toBe(ws);
  });
});

describe('setSplitRatio', () => {
  it('clamps to a usable range and rejects non-numbers', () => {
    const ws = emptyWorkspace();
    expect(setSplitRatio(ws, 0.05).splitRatio).toBe(0.2);
    expect(setSplitRatio(ws, 0.95).splitRatio).toBe(0.8);
    expect(setSplitRatio(ws, 0.35).splitRatio).toBeCloseTo(0.35);
    expect(setSplitRatio(ws, Number.NaN)).toBe(ws);
  });
});

describe('validateWorkspace', () => {
  it('drops tabs whose node is gone and repairs focus', () => {
    let ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    ws = open(ws, node('b'), 't2').workspace;
    ws = open(ws, chat('thread-1'), 't3').workspace;

    const validated = validateWorkspace(ws, CANVAS, new Set(['a']));

    expect(Object.keys(validated.tabs).sort()).toEqual(['t1', 't3']);
    expect(validated.groups[0].activeTabId).toBe('t3');
  });

  it('leaves nodes belonging to another canvas alone', () => {
    const ws = open(emptyWorkspace(), node('x', 'canvas-2'), 't1').workspace;

    const validated = validateWorkspace(ws, CANVAS, new Set());
    expect(Object.keys(validated.tabs)).toEqual(['t1']);
  });

  it('removes a group left empty by validation', () => {
    const a = open(emptyWorkspace(), node('a'), 't1').workspace;
    const b = open(a, node('b'), 't2', { openToSide: true }).workspace;

    const validated = validateWorkspace(b, CANVAS, new Set(['a']));
    expect(validated.groups).toHaveLength(1);
    expect(validated.groups[0].tabIds).toEqual(['t1']);
    expect(validated.activeGroupId).toBe('g1');
  });
});

describe('lookups', () => {
  it('resolves tabs, groups, and active tabs', () => {
    let ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    ws = open(ws, node('b'), 't2', { openToSide: true }).workspace;
    const sideGroupId = ws.groups[1].id;

    expect(findTabByTarget(ws, node('a'))?.id).toBe('t1');
    expect(findTabByTarget(ws, node('zz'))).toBeNull();
    expect(groupOfTab(ws, 't2')?.id).toBe(sideGroupId);
    expect(groupOfTab(ws, 'nope')).toBeNull();
    expect(activeTabOfGroup(ws, sideGroupId)?.id).toBe('t2');
    expect(activeTabOfGroup(ws, 'nope')).toBeNull();
  });

  it('ignores activation of an unknown tab', () => {
    const ws = open(emptyWorkspace(), node('a'), 't1').workspace;
    expect(activateTab(ws, 'nope')).toBe(ws);
    expect(setActiveGroup(ws, 'nope')).toBe(ws);
  });
});
