// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface DesktopTabContext {
  role: 'shell' | 'home' | 'space';
  workspaceId: string | null;
  canvasId: string | null;
}

export interface DesktopTabNavigation {
  canvasId: string | null;
  openIn?: 'new-tab' | 'current-tab';
  search?: string;
  hash?: string;
  state?: unknown;
  homePath?: '/spaces' | '/setup';
}

export interface DesktopTabActivation {
  id: string;
  focus: 'shell';
}

/**
 * What a person has not seen yet, from least to most pressing: a turn that
 * ended, one that failed, one that waits for their approval.
 */
export type DesktopTabAttention = 'done' | 'error' | 'approval';

export interface DesktopTab {
  id: string;
  canvasId: string | null;
  title: string;
  loading: boolean;
  running: boolean;
  /** The most pressing thing in the Space the person has not seen. */
  attention: DesktopTabAttention | null;
  /** How many of the Space's conversations hold something not seen. */
  unseen: number;
  error: string | null;
}

export interface DesktopTabsSnapshot {
  tabs: DesktopTab[];
  activeId: string;
  workspaceId: string | null;
  busy: boolean;
  canChangeWorkspace: boolean;
}

export type DesktopTabResult =
  | { ok: true }
  | { ok: false; error: string; cancelled?: true };

export interface DesktopHomeMenuPosition {
  x: number;
}

export type DesktopTabCommand =
  | 'new-tab'
  | 'open-settings'
  | 'close-home-menu'
  | 'dismiss-home-menu'
  | {
      type: 'end-space-deletion';
      deletedCanvasIds: string[];
    }
  | { type: 'move-tab'; id: string; index: number }
  | { type: 'sync-workspace-capabilities'; canChangeWorkspace: boolean }
  | {
      type: 'sync-space-titles';
      workspaceId: string;
      titles: Record<string, string>;
    }
  | { type: 'begin-space-deletion'; canvasId: string; canvasIds?: string[] }
  | ({ type: 'open-home-menu' } & DesktopHomeMenuPosition);

export interface DesktopTabReport {
  title: string;
  running: boolean;
  error: string | null;
  /** The most pressing thing in the Space the person has not seen. */
  attention: DesktopTabAttention | null;
  /** How many of the Space's conversations hold something not seen. */
  unseen: number;
}

/**
 * Something an Agent did in a Space that the person may not have seen: a
 * turn ended, failed, or waits for an approval. The content page words it
 * and sends only what the person's preferences allow; main shows it as a
 * system notification unless the person is looking at the Space.
 */
export interface DesktopTabNotice {
  /** What it is about. A later notice with the same key replaces this one. */
  key: string;
  title: string;
  body: string;
  /** The nodes to bring into view when the notice is opened. */
  nodeIds: string[];
}

export type DesktopPreferenceKey =
  | 'huabu.language'
  | 'huabu-sketch-tools'
  | 'huabu-chat-preferences'
  | 'huabu.recentConversationAgentProfile.v1'
  | 'huabu:world-enabled'
  | 'huabu.minimapEnabled'
  | 'huabu.notifyTurnDone'
  | 'huabu.notifyNeedsYou';

export interface DesktopPreferenceChange {
  key: DesktopPreferenceKey;
  value: string | null;
}

export interface DesktopTabsApi {
  context: DesktopTabContext;
  getPreference: (
    key: DesktopPreferenceKey,
  ) => { ok: true; value: string | null } | { ok: false; error: string };
  storageSnapshot: (
    legacy?: Record<string, string>,
  ) =>
    | { ok: true; values: Record<string, string> }
    | { ok: false; error: string };
  setPreference: (
    key: DesktopPreferenceKey,
    value: string | null,
    expectedValue?: string | null,
  ) => DesktopTabResult;
  onPreference: (
    callback: (change: DesktopPreferenceChange) => void,
  ) => () => void;
  getState: () => Promise<DesktopTabsSnapshot>;
  onState: (callback: (state: DesktopTabsSnapshot) => void) => () => void;
  open: (target: DesktopTabNavigation) => Promise<DesktopTabResult>;
  activate: (
    target: string | DesktopTabActivation,
  ) => Promise<DesktopTabResult>;
  close: (id: string) => Promise<DesktopTabResult>;
  reload: (id: string) => Promise<DesktopTabResult>;
  command: (command: DesktopTabCommand) => Promise<DesktopTabResult>;
  onHomeMenu: (
    callback: (position: DesktopHomeMenuPosition | null) => void,
  ) => () => void;
  ready: () => void;
  report: (report: DesktopTabReport) => void;
  notify: (notice: DesktopTabNotice) => void;
  workspaceReady: (workspaceId: string) => Promise<DesktopTabResult>;
  beginWorkspaceChange: () => Promise<DesktopTabResult>;
  endWorkspaceChange: () => Promise<DesktopTabResult>;
  onNavigate: (callback: (target: DesktopTabNavigation) => void) => () => void;
  onPrepareClose: (
    callback: (
      request: string | { requestId: string; reason: 'space-deletion' },
    ) => void,
  ) => () => void;
  onSpacesDeleted: (
    callback: (result: {
      workspaceId: string;
      deletedCanvasIds: string[];
    }) => void,
  ) => () => void;
  keepPrepareCloseAlive: (requestId: string) => void;
  onClosePrepared: (callback: () => void) => () => void;
  finishPrepareClose: (requestId: string, result: DesktopTabResult) => void;
  onResume: (callback: () => void) => () => void;
}
