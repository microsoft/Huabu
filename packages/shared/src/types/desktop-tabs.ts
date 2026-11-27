// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The version of everything the desktop app and the web app say to each other
 * through `window.electronBridge`. The two are built and updated separately:
 * a desktop app can load the pages of a Server newer or older than itself.
 * The desktop app exposes the number it was built with and the web app
 * compares it with its own, so a mismatch is told to the person instead of
 * showing up as a feature that quietly stopped working.
 *
 * Add one whenever a message either side sends changes in a way the other
 * side's older build would reject or misread. A desktop app that exposes no
 * number predates this constant and counts as 0.
 */
export const DESKTOP_BRIDGE_PROTOCOL = 1;

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
  /**
   * The conversations it tells of. A later notice that tells of any of them
   * replaces this one.
   */
  keys: string[];
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
