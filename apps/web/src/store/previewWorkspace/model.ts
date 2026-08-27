// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preview Workspace model.
 *
 * Pure data + reducers for the tabbed / split right-side workspace described
 * in `docs/proposals/unified-preview-workspace.md`. This module owns no
 * React, no zustand, and no storage so the whole topology is testable as
 * plain function calls.
 *
 * The target is the sole source of resource identity. Nothing here stores a
 * derived key alongside it, because a duplicated identity can drift from the
 * fields it was derived from.
 */

import { createId } from '@huabu/shared';

/** The business resource a tab renders. */
export type PreviewTarget =
  | { kind: 'node'; canvasId: string; nodeId: string }
  | { kind: 'chat'; canvasId: string; threadId: string };

export type PreviewTab = {
  id: string;
  target: PreviewTarget;
  /**
   * A transient tab is the group's reusable inspection slot: the next
   * transient open replaces its target instead of appending a tab. Promoted
   * to permanent by an explicit gesture (edit, double-click, or Pin). Moving
   * it with Open to Side preserves its transient state.
   */
  transient: boolean;
  /** Monotonic activation stamp used to restore recent-target ordering. */
  lastActiveSeq: number;
};

export type PreviewGroup = {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
};

export type CanvasPreviewWorkspace = {
  tabs: Record<string, PreviewTab>;
  /** One or two groups, laid out left to right. */
  groups: PreviewGroup[];
  activeGroupId: string;
  /** Width share of the first group when two groups are present. */
  splitRatio: number;
  /** Source for `lastActiveSeq`; kept in state so ordering is deterministic. */
  activationSeq: number;
};

/** The first version renders at most two horizontally arranged groups. */
export const MAX_PREVIEW_GROUPS = 2;

export const DEFAULT_SPLIT_RATIO = 0.5;

/** Keeps both groups wide enough to stay useful when the split is dragged. */
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

export type OpenPreviewTargetOptions = {
  /** Group to open into. Defaults to the active group. */
  groupId?: string;
  /** Place the target in the other group, creating it when absent. */
  openToSide?: boolean;
  /** Open into the group's reusable inspection slot. */
  transient?: boolean;
};

/**
 * Semantic identity for targets. This is the only authority on "are these
 * two tabs the same thing"; `tab.id` must never be used for that comparison.
 */
export function isSamePreviewTarget(
  left: PreviewTarget,
  right: PreviewTarget,
): boolean {
  if (left.kind !== right.kind || left.canvasId !== right.canvasId) {
    return false;
  }

  if (left.kind === 'node' && right.kind === 'node') {
    return left.nodeId === right.nodeId;
  }

  return (
    left.kind === 'chat' &&
    right.kind === 'chat' &&
    left.threadId === right.threadId
  );
}

export function createEmptyWorkspace(
  groupId: string = createId('previewgroup'),
): CanvasPreviewWorkspace {
  return {
    tabs: {},
    groups: [{ id: groupId, tabIds: [], activeTabId: null }],
    activeGroupId: groupId,
    splitRatio: DEFAULT_SPLIT_RATIO,
    activationSeq: 0,
  };
}

export function findTabByTarget(
  workspace: CanvasPreviewWorkspace,
  target: PreviewTarget,
): PreviewTab | null {
  for (const tab of Object.values(workspace.tabs)) {
    if (isSamePreviewTarget(tab.target, target)) return tab;
  }
  return null;
}

export function groupOfTab(
  workspace: CanvasPreviewWorkspace,
  tabId: string,
): PreviewGroup | null {
  return workspace.groups.find((g) => g.tabIds.includes(tabId)) ?? null;
}

export function activeTabOfGroup(
  workspace: CanvasPreviewWorkspace,
  groupId: string,
): PreviewTab | null {
  const group = workspace.groups.find((g) => g.id === groupId);
  const activeTabId = group?.activeTabId;
  return activeTabId ? (workspace.tabs[activeTabId] ?? null) : null;
}

export function conversationInOtherGroup(
  workspace: CanvasPreviewWorkspace,
  sourceTarget: PreviewTarget,
  threadIdForNode: (nodeId: string) => string | undefined,
): { tabId: string; threadId: string } | null {
  if (workspace.groups.length !== 2) return null;

  const sourceTab = findTabByTarget(workspace, sourceTarget);
  const sourceGroup = sourceTab ? groupOfTab(workspace, sourceTab.id) : null;
  if (!sourceGroup) return null;
  const otherGroup = workspace.groups.find(
    (group) => group.id !== sourceGroup.id,
  );
  const tab = otherGroup ? activeTabOfGroup(workspace, otherGroup.id) : null;
  if (!tab) return null;
  const threadId =
    tab.target.kind === 'chat'
      ? tab.target.threadId
      : threadIdForNode(tab.target.nodeId);
  return threadId ? { tabId: tab.id, threadId } : null;
}

function mapGroup(
  workspace: CanvasPreviewWorkspace,
  groupId: string,
  update: (group: PreviewGroup) => PreviewGroup,
): PreviewGroup[] {
  return workspace.groups.map((g) => (g.id === groupId ? update(g) : g));
}

/**
 * Marks a tab active in its own group and focuses that group. Bumps the
 * activation stamp so recent-target lookups have a deterministic order.
 */
export function activateTab(
  workspace: CanvasPreviewWorkspace,
  tabId: string,
): CanvasPreviewWorkspace {
  const group = groupOfTab(workspace, tabId);
  if (!group) return workspace;

  const nextSeq = workspace.activationSeq + 1;
  return {
    ...workspace,
    tabs: {
      ...workspace.tabs,
      [tabId]: { ...workspace.tabs[tabId], lastActiveSeq: nextSeq },
    },
    groups: mapGroup(workspace, group.id, (g) => ({
      ...g,
      activeTabId: tabId,
    })),
    activeGroupId: group.id,
    activationSeq: nextSeq,
  };
}

/** Promotes a transient tab to a permanent one. */
export function promoteTab(
  workspace: CanvasPreviewWorkspace,
  tabId: string,
): CanvasPreviewWorkspace {
  const tab = workspace.tabs[tabId];
  if (!tab || !tab.transient) return workspace;
  return {
    ...workspace,
    tabs: { ...workspace.tabs, [tabId]: { ...tab, transient: false } },
  };
}

/** Repairs the one-transient-tab-per-group invariant by dropping older slots. */
export function repairTransientTabs(
  workspace: CanvasPreviewWorkspace,
  preferredTabId?: string,
): CanvasPreviewWorkspace {
  let tabs = workspace.tabs;
  let groups = workspace.groups;

  for (const group of groups) {
    const transientIds = group.tabIds.filter((tabId) => tabs[tabId]?.transient);
    if (transientIds.length <= 1) continue;

    const keeper =
      preferredTabId && transientIds.includes(preferredTabId)
        ? preferredTabId
        : transientIds.reduce((latestId, tabId) =>
            tabs[tabId].lastActiveSeq > tabs[latestId].lastActiveSeq
              ? tabId
              : latestId,
          );

    const removedIds = new Set(
      transientIds.filter((tabId) => tabId !== keeper),
    );
    if (tabs === workspace.tabs) tabs = { ...workspace.tabs };
    for (const tabId of removedIds) delete tabs[tabId];

    groups = groups.map((candidate) =>
      candidate.id === group.id
        ? {
            ...candidate,
            tabIds: candidate.tabIds.filter((tabId) => !removedIds.has(tabId)),
            activeTabId:
              candidate.activeTabId && removedIds.has(candidate.activeTabId)
                ? keeper
                : candidate.activeTabId,
          }
        : candidate,
    );
  }

  return tabs === workspace.tabs ? workspace : { ...workspace, tabs, groups };
}

function ensureSideGroup(
  workspace: CanvasPreviewWorkspace,
  fromGroupId: string,
  newGroupId: string,
): { workspace: CanvasPreviewWorkspace; sideGroupId: string } {
  const existing = workspace.groups.find((g) => g.id !== fromGroupId);
  if (existing) return { workspace, sideGroupId: existing.id };
  if (workspace.groups.length >= MAX_PREVIEW_GROUPS) {
    return { workspace, sideGroupId: fromGroupId };
  }

  const sideGroup: PreviewGroup = {
    id: newGroupId,
    tabIds: [],
    activeTabId: null,
  };
  return {
    workspace: { ...workspace, groups: [...workspace.groups, sideGroup] },
    sideGroupId: newGroupId,
  };
}

/**
 * Opens a target, honouring the one-tab-per-target rule.
 *
 * A target that is already open is revealed rather than duplicated, even when
 * its tab lives in the other group. Open to Side moves that single tab
 * instead of creating a second instance.
 */
export function openTarget(
  workspace: CanvasPreviewWorkspace,
  target: PreviewTarget,
  options: OpenPreviewTargetOptions = {},
  newIds: { tabId?: string; groupId?: string } = {},
): { workspace: CanvasPreviewWorkspace; tabId: string } {
  const requestedGroupId = options.groupId ?? workspace.activeGroupId;
  const baseGroupId = workspace.groups.some((g) => g.id === requestedGroupId)
    ? requestedGroupId
    : workspace.activeGroupId;

  let next = repairTransientTabs(workspace);
  let destinationGroupId = baseGroupId;

  if (options.openToSide) {
    const ensured = ensureSideGroup(
      next,
      baseGroupId,
      newIds.groupId ?? createId('previewgroup'),
    );
    next = ensured.workspace;
    destinationGroupId = ensured.sideGroupId;
  }

  const existing = findTabByTarget(next, target);
  if (existing) {
    // Revealing leaves a tab where it is; only Open to Side relocates it.
    if (options.openToSide) {
      const currentGroup = groupOfTab(next, existing.id);
      if (currentGroup && currentGroup.id !== destinationGroupId) {
        next = moveTab(next, existing.id, { groupId: destinationGroupId });
      }
    }
    // A permanent open promotes an existing inspection slot. Repeated
    // transient opens only reveal it; keeping it requires an explicit Pin.
    if (!options.transient) next = promoteTab(next, existing.id);
    return { workspace: activateTab(next, existing.id), tabId: existing.id };
  }

  const destination = next.groups.find((g) => g.id === destinationGroupId);
  if (!destination) return { workspace, tabId: '' };

  // A transient open reuses the group's inspection slot in place, keeping its
  // tab id and strip position so browsing never grows the strip.
  if (options.transient) {
    const reusableId = destination.tabIds.find(
      (id) => next.tabs[id]?.transient,
    );
    if (reusableId) {
      next = {
        ...next,
        tabs: {
          ...next.tabs,
          [reusableId]: { ...next.tabs[reusableId], target },
        },
      };
      return { workspace: activateTab(next, reusableId), tabId: reusableId };
    }
  }

  const tabId = newIds.tabId ?? createId('previewtab');
  next = {
    ...next,
    tabs: {
      ...next.tabs,
      [tabId]: {
        id: tabId,
        target,
        transient: options.transient ?? false,
        lastActiveSeq: next.activationSeq,
      },
    },
    groups: mapGroup(next, destinationGroupId, (g) => ({
      ...g,
      tabIds: [...g.tabIds, tabId],
    })),
  };

  return { workspace: activateTab(next, tabId), tabId };
}

/**
 * Swaps a tab's target while keeping its identity, position, and focus.
 * Used when an unbound Chat is saved as a Question node.
 */
export function replaceTabTarget(
  workspace: CanvasPreviewWorkspace,
  tabId: string,
  target: PreviewTarget,
): CanvasPreviewWorkspace {
  const tab = workspace.tabs[tabId];
  if (!tab) return workspace;

  const duplicate = findTabByTarget(workspace, target);
  if (duplicate && duplicate.id !== tabId) return workspace;

  return {
    ...workspace,
    tabs: { ...workspace.tabs, [tabId]: { ...tab, target, transient: false } },
  };
}

function withoutEmptyGroups(
  workspace: CanvasPreviewWorkspace,
): CanvasPreviewWorkspace {
  if (workspace.groups.length <= 1) return workspace;

  const remaining = workspace.groups.filter((g) => g.tabIds.length > 0);
  if (remaining.length === workspace.groups.length) return workspace;
  // Never drop the last group: an empty workspace still needs a focus target.
  const groups = remaining.length > 0 ? remaining : [workspace.groups[0]];

  return {
    ...workspace,
    groups,
    activeGroupId: groups.some((g) => g.id === workspace.activeGroupId)
      ? workspace.activeGroupId
      : groups[0].id,
    splitRatio:
      groups.length === 1 ? DEFAULT_SPLIT_RATIO : workspace.splitRatio,
  };
}

/**
 * Closes a tab and hands focus to the nearest remaining tab in its group.
 * Emptying one of two groups removes that group.
 */
export function closeTab(
  workspace: CanvasPreviewWorkspace,
  tabId: string,
): CanvasPreviewWorkspace {
  const group = groupOfTab(workspace, tabId);
  if (!group) return workspace;

  const index = group.tabIds.indexOf(tabId);
  const tabIds = group.tabIds.filter((id) => id !== tabId);
  const tabs = { ...workspace.tabs };
  delete tabs[tabId];

  const nextActiveTabId =
    group.activeTabId === tabId
      ? (tabIds[Math.min(index, tabIds.length - 1)] ?? null)
      : group.activeTabId;

  return withoutEmptyGroups({
    ...workspace,
    tabs,
    groups: mapGroup(workspace, group.id, (g) => ({
      ...g,
      tabIds,
      activeTabId: nextActiveTabId,
    })),
  });
}

/** Reorders a tab within its group or moves it to the other group. */
export function moveTab(
  workspace: CanvasPreviewWorkspace,
  tabId: string,
  destination: { groupId: string; index?: number },
): CanvasPreviewWorkspace {
  const from = groupOfTab(workspace, tabId);
  const to = workspace.groups.find((g) => g.id === destination.groupId);
  if (!from || !to) return workspace;

  const fromTabIds = from.tabIds.filter((id) => id !== tabId);
  const targetTabIds = from.id === to.id ? fromTabIds : [...to.tabIds];
  const index = Math.max(
    0,
    Math.min(destination.index ?? targetTabIds.length, targetTabIds.length),
  );
  targetTabIds.splice(index, 0, tabId);

  const groups = workspace.groups.map((g) => {
    if (g.id === to.id) {
      return {
        ...g,
        tabIds: targetTabIds,
        activeTabId: g.activeTabId ?? tabId,
      };
    }
    if (g.id === from.id) {
      const activeTabId =
        g.activeTabId === tabId
          ? (fromTabIds[
              Math.min(from.tabIds.indexOf(tabId), fromTabIds.length - 1)
            ] ?? null)
          : g.activeTabId;
      return { ...g, tabIds: fromTabIds, activeTabId };
    }
    return g;
  });

  return repairTransientTabs(
    withoutEmptyGroups({ ...workspace, groups }),
    tabId,
  );
}

/** Folds every tab back into the first group. */
export function mergeGroups(
  workspace: CanvasPreviewWorkspace,
): CanvasPreviewWorkspace {
  if (workspace.groups.length <= 1) return workspace;

  const [first, ...rest] = workspace.groups;
  const merged: PreviewGroup = {
    ...first,
    tabIds: [...first.tabIds, ...rest.flatMap((g) => g.tabIds)],
    activeTabId:
      first.activeTabId ?? rest.find((g) => g.activeTabId)?.activeTabId ?? null,
  };

  return repairTransientTabs({
    ...workspace,
    groups: [merged],
    activeGroupId: merged.id,
    splitRatio: DEFAULT_SPLIT_RATIO,
  });
}

export function setActiveGroup(
  workspace: CanvasPreviewWorkspace,
  groupId: string,
): CanvasPreviewWorkspace {
  if (!workspace.groups.some((g) => g.id === groupId)) return workspace;
  return { ...workspace, activeGroupId: groupId };
}

export function setSplitRatio(
  workspace: CanvasPreviewWorkspace,
  ratio: number,
): CanvasPreviewWorkspace {
  if (!Number.isFinite(ratio)) return workspace;
  return {
    ...workspace,
    splitRatio: Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio)),
  };
}

/**
 * Drops tabs whose node no longer exists in the Canvas and repairs any
 * dangling active ids. `chat` targets are not validated here: an unbound
 * thread has no Canvas node to check against.
 */
export function validateWorkspace(
  workspace: CanvasPreviewWorkspace,
  canvasId: string,
  liveNodeIds: ReadonlySet<string>,
): CanvasPreviewWorkspace {
  const staleTabIds = Object.values(workspace.tabs)
    .filter(
      (tab) =>
        tab.target.kind === 'node' &&
        tab.target.canvasId === canvasId &&
        !liveNodeIds.has(tab.target.nodeId),
    )
    .map((tab) => tab.id);

  let next = staleTabIds.reduce((ws, tabId) => closeTab(ws, tabId), workspace);

  const groups = next.groups.map((g) => {
    const tabIds = g.tabIds.filter((id) => next.tabs[id]);
    const activeTabId =
      g.activeTabId && tabIds.includes(g.activeTabId)
        ? g.activeTabId
        : (tabIds[0] ?? null);
    return { ...g, tabIds, activeTabId };
  });

  next = withoutEmptyGroups({
    ...next,
    groups,
    activeGroupId: groups.some((g) => g.id === next.activeGroupId)
      ? next.activeGroupId
      : groups[0].id,
  });

  return repairTransientTabs(next);
}
