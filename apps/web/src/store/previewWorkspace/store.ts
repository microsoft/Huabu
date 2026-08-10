// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preview Workspace store.
 *
 * The zustand binding for the pure model in `./model.ts`, plus the lifecycle
 * that moves a workspace between `./persistence.ts` and memory. Every action
 * here is a thin delegation to a reducer: the topology rules live in the
 * model so they stay testable without React, and this layer only owns which
 * Canvas is loaded and when the record is flushed.
 *
 * Per `docs/proposals/unified-preview-workspace.md` §12, layout is written on
 * Canvas change and page unload rather than on every mutation, so switching
 * tabs never touches storage.
 */

import { create } from 'zustand';

import {
  activateTab,
  closeTab,
  createEmptyWorkspace,
  enforceTabLimit,
  findTabByTarget,
  groupOfTab,
  mergeGroups,
  moveTab,
  openTarget,
  promoteTab,
  replaceTabTarget,
  setActiveGroup,
  setSplitRatio,
  validateWorkspace,
  type CanvasPreviewWorkspace,
  type OpenPreviewTargetOptions,
  type PreviewTab,
  type PreviewTarget,
} from './model';
import {
  readWorkspace,
  seedWorkspaceFromLegacyChat,
  writeWorkspace,
} from './persistence';

/**
 * Per-group tab cap backing the most-recently-used eviction of §9.2. A
 * constant in the first version, deliberately not a user setting.
 */
export const MAX_TABS_PER_GROUP = 12;

/** Pre-workspace Chat state used to seed a Canvas opened for the first time. */
export type LegacyChatSeed = {
  chatThreadId?: string;
  questionNodeId?: string;
};

export type PreviewWorkspaceState = {
  /** Canvas whose layout is currently in memory; `''` before the first load. */
  canvasId: string;
  workspace: CanvasPreviewWorkspace;

  /**
   * Loads a Canvas's layout, flushing the outgoing Canvas first. Falls back
   * to the legacy Chat seed, then to an empty workspace, so a Canvas that
   * predates the workspace does not present an empty right side.
   */
  loadForCanvas: (canvasId: string, legacy?: LegacyChatSeed) => void;
  /** Writes the in-memory layout for the loaded Canvas. */
  flush: () => void;

  openPreviewTarget: (
    target: PreviewTarget,
    options?: OpenPreviewTargetOptions,
    protectedTabIds?: ReadonlySet<string>,
  ) => string;
  closeTab: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  promoteTab: (tabId: string) => void;
  moveTab: (
    tabId: string,
    destination: { groupId: string; index?: number },
  ) => void;
  replaceTabTarget: (tabId: string, target: PreviewTarget) => void;
  mergeGroups: () => void;
  setActiveGroup: (groupId: string) => void;
  setSplitRatio: (ratio: number) => void;
  /** Drops tabs whose node no longer exists and repairs dangling ids. */
  validate: (liveNodeIds: ReadonlySet<string>) => void;
};

export const usePreviewWorkspaceStore = create<PreviewWorkspaceState>(
  (set, get) => ({
    canvasId: '',
    workspace: createEmptyWorkspace(),

    loadForCanvas: (canvasId, legacy) => {
      const current = get();
      if (current.canvasId === canvasId) return;
      if (current.canvasId) current.flush();

      const workspace =
        readWorkspace(canvasId) ??
        (legacy ? seedWorkspaceFromLegacyChat(canvasId, legacy) : null) ??
        createEmptyWorkspace();

      set({ canvasId, workspace });
    },

    flush: () => {
      const { canvasId, workspace } = get();
      if (canvasId) writeWorkspace(canvasId, workspace);
    },

    openPreviewTarget: (target, options, protectedTabIds) => {
      const opened = openTarget(get().workspace, target, options);
      if (!opened.tabId) return '';
      // The active tab of each group is exempt, so eviction cannot remove the
      // tab just opened. Stream and unsettled-content exemptions arrive with
      // their renderers.
      set({
        workspace: enforceTabLimit(
          opened.workspace,
          MAX_TABS_PER_GROUP,
          protectedTabIds,
        ),
      });
      return opened.tabId;
    },

    closeTab: (tabId) => set({ workspace: closeTab(get().workspace, tabId) }),

    activateTab: (tabId) =>
      set({ workspace: activateTab(get().workspace, tabId) }),

    promoteTab: (tabId) =>
      set({ workspace: promoteTab(get().workspace, tabId) }),

    moveTab: (tabId, destination) =>
      set({ workspace: moveTab(get().workspace, tabId, destination) }),

    replaceTabTarget: (tabId, target) =>
      set({ workspace: replaceTabTarget(get().workspace, tabId, target) }),

    mergeGroups: () => set({ workspace: mergeGroups(get().workspace) }),

    setActiveGroup: (groupId) =>
      set({ workspace: setActiveGroup(get().workspace, groupId) }),

    setSplitRatio: (ratio) =>
      set({ workspace: setSplitRatio(get().workspace, ratio) }),

    validate: (liveNodeIds) => {
      const { canvasId, workspace } = get();
      if (!canvasId) return;
      set({ workspace: validateWorkspace(workspace, canvasId, liveNodeIds) });
    },
  }),
);

// ─── Selectors ──────────────────────────────────────────────────────────────

/** The active tab of the focused group, or `null` when the group is empty. */
export function selectActiveTab(
  state: PreviewWorkspaceState,
): PreviewTab | null {
  const { workspace } = state;
  const group = workspace.groups.find((g) => g.id === workspace.activeGroupId);
  const activeTabId = group?.activeTabId;
  return activeTabId ? (workspace.tabs[activeTabId] ?? null) : null;
}

/**
 * The node the focused group is showing, mirroring what `expandedNodeId`
 * meant before the workspace owned presentation. `null` while the focused
 * group shows an unbound Chat or nothing at all.
 */
export function selectActiveNodeId(
  state: PreviewWorkspaceState,
): string | null {
  const target = selectActiveTab(state)?.target;
  return target?.kind === 'node' ? target.nodeId : null;
}

/** The group currently rendering `tabId`, or `null` when it is not open. */
export function selectGroupOfTab(
  state: PreviewWorkspaceState,
  tabId: string,
): string | null {
  return groupOfTab(state.workspace, tabId)?.id ?? null;
}

/**
 * Whether a node of the loaded Canvas has a tab anywhere in the workspace.
 * Broader than "is being shown": a tab in the inactive group still owns
 * editor state its node must not be mutated behind.
 */
export function selectIsNodeOpen(
  state: PreviewWorkspaceState,
  nodeId: string,
): boolean {
  if (!state.canvasId) return false;
  return (
    findTabByTarget(state.workspace, {
      kind: 'node',
      canvasId: state.canvasId,
      nodeId,
    }) !== null
  );
}
