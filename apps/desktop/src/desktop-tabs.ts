// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dialog, ipcMain, shell, WebContentsView } from 'electron';

import { isSameOrigin } from './server-target.js';
import {
  parseTabNavigation,
  parseTabSession,
  tabNavigationFromUrl,
  tabUrl,
} from './tab-session.js';
import { TITLE_BAR_HEIGHT } from './title-bar.js';

import type {
  DesktopHomeMenuPosition,
  DesktopTab,
  DesktopTabNavigation,
  DesktopTabReport,
  DesktopTabResult,
  DesktopTabsSnapshot,
} from '@huabu/shared/desktop-tabs' with { 'resolution-mode': 'import' };
import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from 'electron';

interface ContentTab {
  state: DesktopTab;
  view: WebContentsView | null;
  ready: boolean;
  completion: string | null;
  failureNotified: boolean;
  navigation?: DesktopTabNavigation;
}

interface DrainRequest {
  contentsId: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

const HOME_ID = 'home';
const CLOSE_TIMEOUT_MS = 15_000;
const PREFERENCE_KEYS = [
  'huabu.language',
  'huabu-sketch-tools',
  'huabu-chat-preferences',
  'huabu:world-enabled',
  'huabu.minimapEnabled',
];
const isLegacyStorageKey = (key: string) =>
  PREFERENCE_KEYS.includes(key) ||
  [
    'huabu-chat',
    'huabu-panel',
    'huabu-conversation-preparation',
    'huabu.conversationTitleDrafts',
  ].includes(key) ||
  (!key.includes('.desktop.') &&
    (key.startsWith('huabu.viewport.') ||
      key.startsWith('huabu.previewWorkspace.')));

export class DesktopCloseCancelledError extends Error {
  constructor() {
    super('Closing was cancelled. Unavailable Tabs were kept open.');
    this.name = 'DesktopCloseCancelledError';
  }
}

export class DesktopTabs {
  private tabs: ContentTab[] = [];
  private activeId = HOME_ID;
  private workspaceId: string | null = null;
  private busy = false;
  private homeMenuPosition: DesktopHomeMenuPosition | null = null;
  private drains = new Map<string, DrainRequest>();
  private closeInFlight = new Map<string, Promise<void>>();
  private sessions: Record<string, unknown> = {};
  private origin: string;
  private sessionPath: string;
  private workspaceChanging = false;
  private legacyStorage: Record<string, string> = {};
  private preferences: Record<string, string> = {};

  constructor(
    private win: BrowserWindow,
    private baseUrl: string,
    userData: string,
    private remote: boolean,
    private configureSession?: (value: Electron.Session) => void,
  ) {
    this.origin = new URL(baseUrl).origin;
    this.sessionPath = join(userData, 'desktop-tabs.json');
    try {
      const raw: unknown = JSON.parse(readFileSync(this.sessionPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid desktop Tab session file');
      }
      this.sessions = raw as Record<string, unknown>;
      const preferences = this.sessions.preferences;
      if (preferences !== undefined) {
        if (
          !preferences ||
          typeof preferences !== 'object' ||
          Array.isArray(preferences) ||
          Object.entries(preferences).some(
            ([key, value]) =>
              !PREFERENCE_KEYS.includes(key) ||
              typeof value !== 'string' ||
              value.length > 65_536,
          )
        ) {
          throw new Error('Invalid desktop preferences');
        }
        this.preferences = preferences as Record<string, string>;
      }
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        console.error('[desktop-tabs] Could not restore Tab sessions:', error);
        dialog.showErrorBox('Could not restore Tabs', String(error));
      }
    }
    this.tabs.push(this.newTab(null));
    this.ensureView(this.tabs[0]);
    win.on('resize', () => this.layout());
  }

  get snapshot(): DesktopTabsSnapshot {
    return {
      tabs: this.tabs.map((tab) => ({ ...tab.state })),
      activeId: this.activeId,
      workspaceId: this.workspaceId,
      busy: this.busy,
    };
  }

  get activeContents(): WebContents | null {
    return (
      this.tabs.find((tab) => tab.state.id === this.activeId)?.view
        ?.webContents ?? null
    );
  }

  owns(contents: WebContents): boolean {
    return (
      contents === this.win.webContents ||
      this.tabs.some((tab) => tab.view?.webContents === contents)
    );
  }

  isShell(contents: WebContents): boolean {
    return contents === this.win.webContents;
  }

  private contentTab(contents: WebContents): ContentTab {
    const tab = this.tabs.find((entry) => entry.view?.webContents === contents);
    if (!tab) throw new Error('This renderer does not own a content Tab');
    return tab;
  }

  private newTab(canvasId: string | null): ContentTab {
    return {
      state: {
        id: canvasId ? randomUUID() : HOME_ID,
        canvasId,
        title: canvasId ?? 'Home',
        loading: true,
        running: false,
        unread: false,
        error: null,
      },
      view: null,
      ready: false,
      completion: null,
      failureNotified: false,
    };
  }

  private ensureView(tab: ContentTab): void {
    if (tab.view) return;
    const canvasId = tab.state.canvasId;
    const view = new WebContentsView({
      webPreferences: {
        ...(canvasId
          ? {
              partition: `persist:huabu-space-${createHash('sha256')
                .update(JSON.stringify([this.sessionKey(), canvasId]))
                .digest('hex')}`,
            }
          : {}),
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        additionalArguments: [
          ...(this.remote ? ['--huabu-remote-server'] : []),
          `--huabu-desktop-role=${canvasId ? 'space' : 'home'}`,
          `--huabu-workspace-id=${encodeURIComponent(this.workspaceId ?? '')}`,
          `--huabu-canvas-id=${encodeURIComponent(canvasId ?? '')}`,
        ],
      },
    });
    if (canvasId) this.configureSession?.(view.webContents.session);
    tab.view = view;
    this.win.contentView.addChildView(view);
    const contents = view.webContents;
    this.guard(contents);
    contents.on(
      'did-fail-load',
      (_event, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === -3) return;
        this.fail(tab, description);
      },
    );
    contents.on('render-process-gone', (_event, details) => {
      tab.ready = false;
      const message = `Space renderer stopped: ${details.reason}`;
      this.fail(tab, message);
      for (const request of this.drains.values()) {
        if (request.contentsId === contents.id)
          request.reject(new Error(message));
      }
    });
    contents.on('before-input-event', (event, input) =>
      this.handleInput(event, input),
    );
    const initialTarget = tab.navigation ?? { canvasId };
    if (initialTarget.state === undefined) delete tab.navigation;
    void contents
      .loadURL(tabUrl(this.baseUrl, initialTarget))
      .catch((error: unknown) => this.fail(tab, String(error)));
    this.layout();
  }

  guard(contents: WebContents): void {
    const isApplicationLink = (url: string) => {
      if (!isSameOrigin(url, this.origin)) return false;
      const path = new URL(url).pathname;
      return (
        path === '/' ||
        path === '/spaces' ||
        path === '/setup' ||
        path.startsWith('/canvas/')
      );
    };
    contents.setWindowOpenHandler(({ url }) => {
      if (isApplicationLink(url)) {
        this.runAction(async () => this.open(tabNavigationFromUrl(url)));
        return { action: 'deny' };
      }
      if (/^https?:/i.test(url)) {
        void shell
          .openExternal(url)
          .catch((error: unknown) =>
            console.error(
              '[desktop-tabs] Could not open external link:',
              error,
            ),
          );
      }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isApplicationLink(url)) {
        event.preventDefault();
        this.runAction(async () => this.open(tabNavigationFromUrl(url)));
        return;
      }
      if (isSameOrigin(url, this.origin)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) {
        void shell
          .openExternal(url)
          .catch((error: unknown) =>
            console.error(
              '[desktop-tabs] Could not open external link:',
              error,
            ),
          );
      }
    });
  }

  handleInput(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown') return;
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    const key = input.key.toLowerCase();
    if (modifier && key === 't') {
      event.preventDefault();
      this.runAction(async () => this.activate(HOME_ID));
    } else if (modifier && key === 'w') {
      event.preventDefault();
      this.runAction(() => this.close(this.activeId));
    } else if (input.control && key === 'tab') {
      event.preventDefault();
      const index = this.tabs.findIndex(
        (tab) => tab.state.id === this.activeId,
      );
      const next =
        (index + (input.shift ? -1 : 1) + this.tabs.length) % this.tabs.length;
      this.runAction(async () => this.activate(this.tabs[next].state.id));
    } else if (input.key === 'F5' || (modifier && key === 'r')) {
      event.preventDefault();
      this.runAction(() => this.reload(this.activeId));
    } else if (
      input.key === 'F12' ||
      (modifier &&
        key === 'i' &&
        (process.platform === 'darwin' ? input.alt : input.shift))
    ) {
      event.preventDefault();
      this.activeContents?.toggleDevTools();
    }
  }

  private runAction(action: () => Promise<void>): void {
    void action().catch((error: unknown) => {
      console.error('[desktop-tabs] Tab action failed:', error);
      dialog.showErrorBox(
        'Tab action failed',
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private fail(tab: ContentTab, message: string): void {
    console.error('[desktop-tabs]', message);
    const notify = !tab.failureNotified;
    tab.failureNotified = true;
    tab.ready = false;
    tab.state.error = message;
    tab.state.loading = false;
    if (tab.state.id === HOME_ID && this.workspaceChanging) {
      this.workspaceChanging = false;
      this.resume();
    } else this.publish();
    if (notify)
      dialog.showErrorBox(
        'Space unavailable',
        `${tab.state.title}\n\n${message}`,
      );
  }

  layout(): void {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    for (const tab of this.tabs) {
      if (!tab.view) continue;
      tab.view.setVisible(tab.state.id === this.activeId);
      tab.view.setBounds({
        x: 0,
        y: TITLE_BAR_HEIGHT,
        width,
        height: Math.max(0, height - TITLE_BAR_HEIGHT),
      });
    }
  }

  private publish(): void {
    if (!this.win.webContents.isDestroyed()) {
      this.broadcast('tabs:state', this.snapshot);
    }
  }

  private sessionKey(): string {
    // A local Server's port may change between launches.
    return JSON.stringify([
      this.remote ? this.origin : 'local',
      this.workspaceId,
    ]);
  }

  private persist(
    tabs = this.tabs,
    activeId = this.activeId,
    preferences = this.preferences,
  ): void {
    const sessions: Record<string, unknown> = { ...this.sessions, preferences };
    if (this.workspaceId)
      sessions[this.sessionKey()] = {
        canvasIds: tabs.flatMap((tab) =>
          tab.state.canvasId ? [tab.state.canvasId] : [],
        ),
        activeCanvasId:
          tabs.find((tab) => tab.state.id === activeId)?.state.canvasId ?? null,
      };
    const temporary = `${this.sessionPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(sessions), { mode: 0o600 });
    renameSync(temporary, this.sessionPath);
    this.sessions = sessions;
  }

  activate(id: string, focus: 'content' | 'shell' = 'content'): void {
    if (this.busy)
      throw new Error('Tabs are saving. Try again after saving finishes.');
    const tab = this.tabs.find((entry) => entry.state.id === id);
    if (!tab) throw new Error('Tab no longer exists');
    this.ensureView(tab);
    this.persist(this.tabs, id);
    this.activeId = id;
    this.setHomeMenu(null);
    tab.state.unread = false;
    this.layout();
    if (focus === 'shell') this.win.webContents.focus();
    else tab.view?.webContents.focus();
    this.publish();
  }

  open(raw: unknown): void {
    if (this.busy)
      throw new Error('Tabs are saving. Try again after saving finishes.');
    const target = parseTabNavigation(raw);
    if (target.canvasId && !this.workspaceId)
      throw new Error('Workspace is not ready');
    let tab = this.tabs.find(
      (entry) => entry.state.canvasId === target.canvasId,
    );
    const created = !tab;
    if (!tab) {
      tab = this.newTab(target.canvasId);
      this.tabs.push(tab);
    }
    const hasIntent =
      target.search !== undefined ||
      target.hash !== undefined ||
      target.state !== undefined ||
      target.homePath !== undefined ||
      target.canvasId === null;
    if (!tab.view || hasIntent) tab.navigation = target;
    try {
      this.activate(tab.state.id);
    } catch (error) {
      if (created) {
        this.destroyTab(tab);
        this.tabs = this.tabs.filter((entry) => entry !== tab);
      }
      throw error;
    }
    if (tab.ready && tab.navigation) {
      tab.view?.webContents.send('tabs:navigate', tab.navigation);
      delete tab.navigation;
    }
  }

  ready(contents: WebContents): void {
    const tab = this.contentTab(contents);
    tab.ready = true;
    tab.state.loading = false;
    if (tab.navigation) {
      contents.send('tabs:navigate', tab.navigation);
      delete tab.navigation;
    }
    this.publish();
  }

  report(contents: WebContents, raw: unknown): void {
    const tab = this.contentTab(contents);
    if (!raw || typeof raw !== 'object') throw new Error('Invalid Tab status');
    const report = raw as DesktopTabReport;
    if (
      typeof report.title !== 'string' ||
      report.title.length > 512 ||
      typeof report.running !== 'boolean' ||
      typeof report.completion !== 'string' ||
      report.completion.length > 65_536 ||
      (report.error !== null && typeof report.error !== 'string')
    )
      throw new Error('Invalid Tab status');
    const previous = new Set(tab.completion?.split('\0'));
    if (
      tab.completion !== null &&
      report.completion.split('\0').some((id) => id && !previous.has(id)) &&
      this.activeId !== tab.state.id
    ) {
      tab.state.unread = true;
    }
    tab.completion = report.completion;
    tab.state.title = report.title;
    tab.state.running = report.running;
    // A load/crash error stays visible until an explicit reload.
    if (tab.ready) tab.state.error = report.error;
    this.publish();
  }

  workspaceReady(contents: WebContents, workspaceId: unknown): void {
    const tab = this.contentTab(contents);
    if (tab.state.id !== HOME_ID)
      throw new Error('Only Home can activate a Workspace');
    if (!tab.ready)
      throw new Error('Home is not ready to activate a Workspace');
    if (
      typeof workspaceId !== 'string' ||
      !workspaceId ||
      workspaceId.length > 256
    ) {
      throw new Error('Invalid Workspace identity');
    }
    if (this.workspaceChanging) {
      throw new Error(
        'Finish changing Workspace before registering its identity',
      );
    }
    if (this.workspaceId === workspaceId) return;
    if (this.tabs.length > 1)
      throw new Error(
        'Close existing Space Tabs before activating a Workspace',
      );
    this.workspaceId = workspaceId;
    const stored = this.sessions[this.sessionKey()];
    if (stored !== undefined) {
      const session = parseTabSession(stored);
      for (const canvasId of session.canvasIds)
        this.tabs.push(this.newTab(canvasId));
      const active = this.tabs.find(
        (entry) => entry.state.canvasId === session.activeCanvasId,
      );
      this.activate(active?.state.id ?? HOME_ID);
    }
    this.publish();
  }

  private async drain(tab: ContentTab): Promise<void> {
    const view = tab.view;
    if (!view) return;
    if (!tab.ready)
      throw new Error(
        `"${tab.state.title}" is not ready to save. Reload it before closing.`,
      );
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.drains.set(requestId, {
          contentsId: view.webContents.id,
          resolve,
          reject,
        });
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Saving "${tab.state.title}" timed out. The Tab was kept open.`,
              ),
            ),
          CLOSE_TIMEOUT_MS,
        );
        view.webContents.send('tabs:prepare-close', requestId);
      });
    } finally {
      clearTimeout(timer);
      this.drains.delete(requestId);
    }
  }

  finishDrain(contents: WebContents, requestId: unknown, raw: unknown): void {
    if (typeof requestId !== 'string') throw new Error('Invalid save request');
    const request = this.drains.get(requestId);
    if (!request || request.contentsId !== contents.id)
      throw new Error('Save request does not belong to this Tab');
    if (!raw || typeof raw !== 'object' || !('ok' in raw))
      throw new Error('Invalid save response');
    if (raw.ok === true) request.resolve();
    else if (
      raw.ok === false &&
      'error' in raw &&
      typeof raw.error === 'string'
    )
      request.reject(new Error(raw.error));
    else throw new Error('Invalid save response');
  }

  resume(): void {
    for (const tab of this.tabs) {
      if (tab.ready) tab.view?.webContents.send('tabs:resume');
    }
    this.busy = false;
    this.publish();
  }

  async prepareCloseAll(allowDiscardUnavailable = false): Promise<void> {
    if (this.busy) throw new Error('Another Tab operation is in progress');
    this.setHomeMenu(null);
    this.busy = true;
    this.publish();
    try {
      const results = await Promise.allSettled(
        this.tabs.map((tab) => this.drain(tab)),
      );
      const failed: { tab: ContentTab; error: unknown }[] = results.flatMap(
        (result, index) =>
          result.status === 'rejected'
            ? [{ tab: this.tabs[index], error: result.reason }]
            : [],
      );
      const blocking = failed.find(
        ({ tab }) => !allowDiscardUnavailable || tab.ready,
      );
      if (blocking) throw blocking.error;
      if (failed.length > 0) {
        const { response } = await dialog.showMessageBox(this.win, {
          type: 'warning',
          message: 'Close without saving unavailable pages?',
          detail: `${failed.map(({ tab }) => tab.state.title).join('\n')}\n\nThese pages cannot acknowledge saving. Unsaved changes may be lost. All other pages have been saved.`,
          buttons: ['Cancel', 'Discard unavailable pages and close'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response !== 1) throw new DesktopCloseCancelledError();
        // A page that recovered during the dialog must acknowledge its save.
        for (const { tab } of failed) {
          if (tab.ready) await this.drain(tab);
        }
      }
      this.persist();
    } catch (error) {
      this.resume();
      throw error;
    }
  }

  async beginWorkspaceChange(contents: WebContents): Promise<void> {
    if (this.contentTab(contents).state.id !== HOME_ID) {
      throw new Error('Switch Workspace from Home');
    }
    await this.prepareCloseAll();
    if (!this.contentTab(contents).ready) {
      this.resume();
      throw new Error(
        'Home became unavailable while preparing Workspace change',
      );
    }
    this.workspaceChanging = true;
    for (const tab of this.tabs.slice(1)) this.destroyTab(tab);
    this.tabs = this.tabs.slice(0, 1);
    this.activeId = HOME_ID;
    this.workspaceId = null;
    this.layout();
    this.publish();
  }

  endWorkspaceChange(contents: WebContents): void {
    if (
      this.contentTab(contents).state.id !== HOME_ID ||
      !this.workspaceChanging
    ) {
      throw new Error('No Workspace change belongs to this Tab');
    }
    this.workspaceChanging = false;
    this.resume();
  }

  close(id: string): Promise<void> {
    if (id === HOME_ID) return Promise.resolve();
    const existing = this.closeInFlight.get(id);
    if (existing) return existing;
    const task = this.closeTab(id).finally(() => this.closeInFlight.delete(id));
    this.closeInFlight.set(id, task);
    return task;
  }

  private async closeTab(id: string): Promise<void> {
    if (this.busy) throw new Error('Another Tab operation is in progress');
    const tab = this.tabs.find((entry) => entry.state.id === id);
    if (!tab) throw new Error('Tab no longer exists');
    this.setHomeMenu(null);
    this.busy = true;
    this.publish();
    try {
      if (!tab.ready && tab.state.error) {
        const result = await dialog.showMessageBox(this.win, {
          type: 'warning',
          message: 'Close this failed Tab?',
          detail:
            'The renderer is unavailable. Only previously saved content can be recovered.',
          buttons: ['Cancel', 'Close Tab'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (result.response !== 1) {
          this.resume();
          return;
        }
      } else {
        await this.drain(tab);
      }
      const index = this.tabs.indexOf(tab);
      const remaining = this.tabs.filter((entry) => entry !== tab);
      const activeId =
        this.activeId === id
          ? remaining[Math.max(0, index - 1)].state.id
          : this.activeId;
      const next = remaining.find((entry) => entry.state.id === activeId);
      if (!next) throw new Error('No remaining Tab can be activated');
      this.ensureView(next);
      this.persist(remaining, activeId);
      this.tabs = remaining;
      this.activeId = activeId;
      next.state.unread = false;
      this.destroyTab(tab);
      this.busy = false;
      this.layout();
      next.view?.webContents.focus();
      this.publish();
    } catch (error) {
      this.resume();
      this.activeId = id;
      this.layout();
      tab.view?.webContents.focus();
      this.publish();
      throw error;
    }
  }

  storageSnapshot(
    contents: WebContents,
    legacy: unknown,
  ): Record<string, string> {
    if (legacy !== undefined) {
      if (this.contentTab(contents).state.id !== HOME_ID)
        throw new Error('Only Home can initialize legacy storage');
      if (
        !legacy ||
        typeof legacy !== 'object' ||
        Array.isArray(legacy) ||
        JSON.stringify(legacy).length > 5_242_880 ||
        Object.entries(legacy).some(
          ([key, value]) =>
            !isLegacyStorageKey(key) || typeof value !== 'string',
        )
      ) {
        throw new Error('Invalid legacy desktop storage');
      }
      this.legacyStorage = legacy as Record<string, string>;
      for (const key of PREFERENCE_KEYS) {
        if (
          this.preferences[key] === undefined &&
          this.legacyStorage[key] !== undefined
        )
          this.preferences[key] = this.legacyStorage[key];
      }
    }
    return {
      ...Object.fromEntries(
        Object.entries(this.legacyStorage).filter(
          ([key]) => !PREFERENCE_KEYS.includes(key),
        ),
      ),
      ...this.preferences,
    };
  }

  setPreference(contents: WebContents, key: unknown, value: unknown): void {
    if (this.isShell(contents))
      throw new Error('Only content pages can update preferences');
    if (
      typeof key !== 'string' ||
      !PREFERENCE_KEYS.includes(key) ||
      (value !== null && (typeof value !== 'string' || value.length > 65_536))
    )
      throw new Error('Invalid application preference');
    if ((this.preferences[key] ?? null) === value) return;
    const preferences = { ...this.preferences };
    if (value === null) delete preferences[key];
    else preferences[key] = value;
    this.persist(this.tabs, this.activeId, preferences);
    this.preferences = preferences;
    for (const target of [
      this.win.webContents,
      ...this.tabs.flatMap((tab) => (tab.view ? [tab.view.webContents] : [])),
    ]) {
      if (target !== contents && !target.isDestroyed())
        target.send('tabs:preference', { key, value });
    }
  }
  async reload(id: string): Promise<void> {
    if (this.busy) throw new Error('Another Tab operation is in progress');
    const tab = this.tabs.find((entry) => entry.state.id === id);
    if (!tab?.view) throw new Error('Tab has not loaded');
    this.setHomeMenu(null);
    this.busy = true;
    this.publish();
    try {
      if (tab.ready) await this.drain(tab);
      tab.ready = false;
      tab.state.loading = true;
      tab.state.error = null;
      tab.failureNotified = false;
      tab.view.webContents.reload();
    } finally {
      this.resume();
    }
  }

  broadcast(channel: string, value: unknown): void {
    this.win.webContents.send(channel, value);
    for (const tab of this.tabs) {
      if (tab.view && !tab.view.webContents.isDestroyed())
        tab.view.webContents.send(channel, value);
    }
  }

  private setHomeMenu(position: DesktopHomeMenuPosition | null): void {
    if (!position && !this.homeMenuPosition) return;
    this.homeMenuPosition = position;
    this.win.webContents.send('tabs:home-menu', position);
    this.tabs
      .find((tab) => tab.state.id === HOME_ID)
      ?.view?.webContents.send('tabs:home-menu', position);
  }

  command(raw: unknown, sender?: WebContents): void {
    if (raw === 'close-home-menu' || raw === 'dismiss-home-menu') {
      if (
        !sender ||
        (!this.isShell(sender) && this.contentTab(sender).state.id !== HOME_ID)
      )
        throw new Error('Only Home or the desktop shell can dismiss its menu');
      this.setHomeMenu(null);
      if (raw === 'close-home-menu' && this.activeId === HOME_ID)
        this.win.webContents.focus();
      return;
    }
    if (
      raw &&
      typeof raw === 'object' &&
      'type' in raw &&
      raw.type === 'open-home-menu'
    ) {
      if (!sender || !this.isShell(sender))
        throw new Error('Only the desktop shell can open the Home menu');
      if (
        !('x' in raw) ||
        typeof raw.x !== 'number' ||
        !Number.isFinite(raw.x) ||
        raw.x < 0 ||
        raw.x > this.win.getContentSize()[0]
      )
        throw new Error('Invalid Home menu position');
      if (this.busy) throw new Error('Tabs are saving');
      if (this.homeMenuPosition) {
        this.setHomeMenu(null);
        this.win.webContents.focus();
        return;
      }
      const home = this.tabs.find((tab) => tab.state.id === HOME_ID);
      if (!home?.ready) throw new Error('Home is not ready');
      this.activate(HOME_ID);
      this.setHomeMenu({ x: raw.x });
      return;
    }
    if (raw !== 'open-settings') throw new Error('Unsupported desktop command');
    if (this.busy) throw new Error('Tabs are saving');
    const contents = this.activeContents;
    if (!contents) throw new Error('No active content page is available');
    this.setHomeMenu(null);
    contents.send('menu:command', raw);
  }

  private destroyTab(tab: ContentTab): void {
    if (!tab.view) return;
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close({ waitForBeforeUnload: false });
    tab.view = null;
  }

  dispose(): void {
    for (const request of this.drains.values())
      request.reject(new Error('Window was closed'));
    this.drains.clear();
    for (const tab of this.tabs) this.destroyTab(tab);
  }
}

export function registerDesktopTabsIpc(
  resolve: () => DesktopTabs | null,
): void {
  const requireOwner = (
    event: IpcMainInvokeEvent | IpcMainEvent,
  ): DesktopTabs => {
    const tabs = resolve();
    if (
      !tabs ||
      event.senderFrame !== event.sender.mainFrame ||
      !tabs.owns(event.sender)
    ) {
      throw new Error('Tab operation is not available to this renderer');
    }
    return tabs;
  };
  const action = (
    name: string,
    run: (
      tabs: DesktopTabs,
      event: IpcMainInvokeEvent,
      value: unknown,
    ) => void | Promise<void>,
  ) => {
    ipcMain.handle(
      name,
      async (event, value: unknown): Promise<DesktopTabResult> => {
        try {
          await run(requireOwner(event), event, value);
          return { ok: true };
        } catch (error) {
          console.error(`[desktop-tabs] ${name}:`, error);
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
  };
  ipcMain.handle('tabs:get-state', (event) => requireOwner(event).snapshot);
  for (const name of ['storage-snapshot', 'set-preference'] as const) {
    ipcMain.on(`tabs:${name}`, (event, ...args: unknown[]) => {
      try {
        const tabs = requireOwner(event);
        event.returnValue =
          name === 'storage-snapshot'
            ? { ok: true, values: tabs.storageSnapshot(event.sender, args[0]) }
            : (tabs.setPreference(event.sender, args[0], args[1]),
              { ok: true });
      } catch (error) {
        console.error(`[desktop-tabs] ${name}:`, error);
        event.returnValue = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }
  action('tabs:open', (tabs, _event, value) => tabs.open(value));
  for (const operation of ['activate', 'close', 'reload'] as const) {
    action(`tabs:${operation}`, (tabs, event, value) => {
      if (!tabs.isShell(event.sender)) {
        throw new Error('Only the desktop shell can address another Tab');
      }
      if (
        operation === 'activate' &&
        value &&
        typeof value === 'object' &&
        'id' in value &&
        typeof value.id === 'string' &&
        'focus' in value &&
        value.focus === 'shell'
      )
        return tabs.activate(value.id, 'shell');
      if (typeof value !== 'string') throw new Error('Invalid Tab identity');
      return tabs[operation](value);
    });
  }
  action('tabs:command', (tabs, event, value) =>
    tabs.command(value, event.sender),
  );
  action('tabs:workspace-ready', (tabs, event, value) =>
    tabs.workspaceReady(event.sender, value),
  );
  action('tabs:begin-workspace-change', (tabs, event) =>
    tabs.beginWorkspaceChange(event.sender),
  );
  action('tabs:end-workspace-change', (tabs, event) =>
    tabs.endWorkspaceChange(event.sender),
  );
  const listen = (
    name: string,
    run: (tabs: DesktopTabs, event: IpcMainEvent, args: unknown[]) => void,
  ) => {
    ipcMain.on(name, (event, ...args: unknown[]) => {
      try {
        run(requireOwner(event), event, args);
      } catch (error) {
        console.error(`[desktop-tabs] ${name}:`, error);
      }
    });
  };
  listen('tabs:ready', (tabs, event) => tabs.ready(event.sender));
  listen('tabs:report', (tabs, event, args) =>
    tabs.report(event.sender, args[0]),
  );
  listen('tabs:finish-close', (tabs, event, args) =>
    tabs.finishDrain(event.sender, args[0], args[1]),
  );
}
