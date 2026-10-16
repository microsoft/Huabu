// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface DesktopTabContext {
  role: 'shell' | 'home' | 'space';
  workspaceId: string | null;
  canvasId: string | null;
}

export interface DesktopTabNavigation {
  canvasId: string | null;
  search?: string;
  hash?: string;
  state?: unknown;
  homePath?: '/spaces' | '/setup';
}

export interface DesktopTab {
  id: string;
  canvasId: string | null;
  title: string;
  loading: boolean;
  running: boolean;
  unread: boolean;
  error: string | null;
}

export interface DesktopTabsSnapshot {
  tabs: DesktopTab[];
  activeId: string;
  workspaceId: string | null;
  busy: boolean;
}

export type DesktopTabResult = { ok: true } | { ok: false; error: string };

export interface DesktopHomeMenuPosition {
  x: number;
}

export type DesktopTabCommand =
  | 'open-settings'
  | 'close-home-menu'
  | 'dismiss-home-menu'
  | ({ type: 'open-home-menu' } & DesktopHomeMenuPosition);

export interface DesktopTabReport {
  title: string;
  running: boolean;
  completion: string;
  error: string | null;
}

export type DesktopPreferenceKey =
  | 'huabu.language'
  | 'huabu-sketch-tools'
  | 'huabu-chat-preferences'
  | 'huabu:world-enabled'
  | 'huabu.minimapEnabled';

export interface DesktopPreferenceChange {
  key: DesktopPreferenceKey;
  value: string | null;
}

export interface DesktopTabsApi {
  context: DesktopTabContext;
  storageSnapshot: (
    legacy?: Record<string, string>,
  ) =>
    | { ok: true; values: Record<string, string> }
    | { ok: false; error: string };
  setPreference: (
    key: DesktopPreferenceKey,
    value: string | null,
  ) => DesktopTabResult;
  onPreference: (
    callback: (change: DesktopPreferenceChange) => void,
  ) => () => void;
  getState: () => Promise<DesktopTabsSnapshot>;
  onState: (callback: (state: DesktopTabsSnapshot) => void) => () => void;
  open: (target: DesktopTabNavigation) => Promise<DesktopTabResult>;
  activate: (id: string) => Promise<DesktopTabResult>;
  close: (id: string) => Promise<DesktopTabResult>;
  reload: (id: string) => Promise<DesktopTabResult>;
  command: (command: DesktopTabCommand) => Promise<DesktopTabResult>;
  onHomeMenu: (
    callback: (position: DesktopHomeMenuPosition | null) => void,
  ) => () => void;
  ready: () => void;
  report: (report: DesktopTabReport) => void;
  workspaceReady: (workspaceId: string) => Promise<DesktopTabResult>;
  beginWorkspaceChange: () => Promise<DesktopTabResult>;
  endWorkspaceChange: () => Promise<DesktopTabResult>;
  onNavigate: (callback: (target: DesktopTabNavigation) => void) => () => void;
  onPrepareClose: (callback: (requestId: string) => void) => () => void;
  finishPrepareClose: (requestId: string, result: DesktopTabResult) => void;
  onResume: (callback: () => void) => () => void;
}
