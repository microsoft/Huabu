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

/** Pre-workspace Chat state used to seed a Canvas opened for the first time. */
export type LegacyChatSeed = {
  chatThreadId?: string;
  questionNodeId?: string;
};

export type BeforePreviewTabRemoved = (tabId: string) => void;

function commitWorkspace(
  state: PreviewWorkspaceState,
  workspace: CanvasPreviewWorkspace,
  beforeTabRemoved?: BeforePreviewTabRemoved,
): Partial<PreviewWorkspaceState> {
  const removedTabIds = Object.keys(state.workspace.tabs).filter(
    (tabId) => !workspace.tabs[tabId],
  );
  for (const tabId of removedTabIds) beforeTabRemoved?.(tabId);

  return {
    workspace,
    ...(state.nodeFocusRequest && !workspace.tabs[state.nodeFocusRequest.tabId]
      ? { nodeFocusRequest: null }
      : {}),
    ...(state.chatOpenRequest && !workspace.tabs[state.chatOpenRequest.tabId]
      ? { chatOpenRequest: null }
      : {}),
  };
}

export type PreviewWorkspaceState = {
  /** Canvas whose layout is currently in memory; `''` before the first load. */
  canvasId: string;
  workspace: CanvasPreviewWorkspace;
  /** One-shot request to focus the editable surface of a specific tab. */
  nodeFocusRequest: { tabId: string; nonce: number } | null;
  /** Runtime-only sequence that keeps focus request identities monotonic. */
  nodeFocusRequestSeq: number;
  /** One-shot request controlling a Chat tab's initial scroll position. */
  chatOpenRequest: {
    tabId: string;
    position: 'last-user' | 'bottom';
    nonce: number;
  } | null;
  /** Runtime-only sequence that keeps Chat open requests monotonic. */
  chatOpenRequestSeq: number;

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
    beforeTabRemoved?: BeforePreviewTabRemoved,
  ) => string;
  closeTab: (tabId: string, beforeTabRemoved?: BeforePreviewTabRemoved) => void;
  activateTab: (tabId: string) => void;
  promoteTab: (tabId: string) => void;
  moveTab: (
    tabId: string,
    destination: { groupId: string; index?: number },
    beforeTabRemoved?: BeforePreviewTabRemoved,
  ) => void;
  replaceTabTarget: (tabId: string, target: PreviewTarget) => void;
  mergeGroups: (beforeTabRemoved?: BeforePreviewTabRemoved) => void;
  setActiveGroup: (groupId: string) => void;
  setSplitRatio: (ratio: number) => void;
  requestNodeFocus: (tabId: string) => void;
  consumeNodeFocusRequest: (tabId: string, nonce: number) => void;
  requestChatOpen: (tabId: string, position: 'last-user' | 'bottom') => void;
  consumeChatOpenRequest: (tabId: string, nonce: number) => void;
  /** Drops tabs whose node no longer exists and repairs dangling ids. */
  validate: (liveNodeIds: ReadonlySet<string>) => void;
};

export const usePreviewWorkspaceStore = create<PreviewWorkspaceState>(
  (set, get) => ({
    canvasId: '',
    workspace: createEmptyWorkspace(),
    nodeFocusRequest: null,
    nodeFocusRequestSeq: 0,
    chatOpenRequest: null,
    chatOpenRequestSeq: 0,

    loadForCanvas: (canvasId, legacy) => {
      const current = get();
      if (current.canvasId === canvasId) return;
      if (current.canvasId) current.flush();

      const workspace =
        readWorkspace(canvasId) ??
        (legacy ? seedWorkspaceFromLegacyChat(canvasId, legacy) : null) ??
        createEmptyWorkspace();

      set({
        canvasId,
        workspace,
        nodeFocusRequest: null,
        chatOpenRequest: null,
      });
    },

    flush: () => {
      const { canvasId, workspace } = get();
      if (canvasId) writeWorkspace(canvasId, workspace);
    },

    openPreviewTarget: (target, options, beforeTabRemoved) => {
      const state = get();
      const opened = openTarget(state.workspace, target, options);
      if (!opened.tabId) return '';
      set(commitWorkspace(state, opened.workspace, beforeTabRemoved));
      return opened.tabId;
    },

    closeTab: (tabId, beforeTabRemoved) => {
      const state = get();
      const workspace = closeTab(state.workspace, tabId);
      set(commitWorkspace(state, workspace, beforeTabRemoved));
    },

    activateTab: (tabId) =>
      set({ workspace: activateTab(get().workspace, tabId) }),

    promoteTab: (tabId) =>
      set({ workspace: promoteTab(get().workspace, tabId) }),

    moveTab: (tabId, destination, beforeTabRemoved) => {
      const state = get();
      const workspace = moveTab(state.workspace, tabId, destination);
      set(commitWorkspace(state, workspace, beforeTabRemoved));
    },

    replaceTabTarget: (tabId, target) => {
      set({ workspace: replaceTabTarget(get().workspace, tabId, target) });
    },

    mergeGroups: (beforeTabRemoved) => {
      const state = get();
      const workspace = mergeGroups(state.workspace);
      set(commitWorkspace(state, workspace, beforeTabRemoved));
    },

    setActiveGroup: (groupId) =>
      set({ workspace: setActiveGroup(get().workspace, groupId) }),

    setSplitRatio: (ratio) =>
      set({ workspace: setSplitRatio(get().workspace, ratio) }),

    requestNodeFocus: (tabId) =>
      set((state) => {
        const nonce = state.nodeFocusRequestSeq + 1;
        return {
          nodeFocusRequest: { tabId, nonce },
          nodeFocusRequestSeq: nonce,
        };
      }),

    consumeNodeFocusRequest: (tabId, nonce) =>
      set((state) =>
        state.nodeFocusRequest?.tabId === tabId &&
        state.nodeFocusRequest.nonce === nonce
          ? { nodeFocusRequest: null }
          : {},
      ),

    requestChatOpen: (tabId, position) =>
      set((state) => {
        const nonce = state.chatOpenRequestSeq + 1;
        return {
          chatOpenRequest: { tabId, position, nonce },
          chatOpenRequestSeq: nonce,
        };
      }),

    consumeChatOpenRequest: (tabId, nonce) =>
      set((state) =>
        state.chatOpenRequest?.tabId === tabId &&
        state.chatOpenRequest.nonce === nonce
          ? { chatOpenRequest: null }
          : {},
      ),

    validate: (liveNodeIds) => {
      const state = get();
      const { canvasId, workspace } = state;
      if (!canvasId) return;
      const validated = validateWorkspace(workspace, canvasId, liveNodeIds);
      set(commitWorkspace(state, validated));
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
