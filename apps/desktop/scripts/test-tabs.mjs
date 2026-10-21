// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/* global window, document, getComputedStyle */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import getPort from 'get-port';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const desktopRequire = createRequire(
  new URL('../package.json', import.meta.url),
);
const webRequire = createRequire(
  new URL('../../web/package.json', import.meta.url),
);
const serverRequire = createRequire(
  new URL('../../server/package.json', import.meta.url),
);
const { _electron } = webRequire('@playwright/test');
const temporary = mkdtempSync(join(tmpdir(), 'huabu-desktop-tabs-smoke-'));
const workspace = join(temporary, 'workspace');
const nextWorkspace = join(temporary, 'next-workspace');
mkdirSync(workspace);
mkdirSync(nextWorkspace);
const serverPort = await getPort();
const webPort = await getPort({ exclude: [serverPort] });
const serverOrigin = `http://127.0.0.1:${serverPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const instance = `tabs-smoke-${randomBytes(6).toString('hex')}`;
const environment = {
  ...process.env,
  SERVER_PORT: String(serverPort),
  VITE_PORT: String(webPort),
  VITE_API_PROXY_TARGET: serverOrigin,
  HUABU_DATA_DIR: join(temporary, 'data'),
  HUABU_WORKSPACE: '',
  HUABU_SECRET_KEY: randomBytes(32).toString('base64'),
  HUABU_BASIC_AUTH_USER: '',
  HUABU_BASIC_AUTH_PASS: '',
};
delete environment.ELECTRON_RUN_AS_NODE;
let electron;
let userData;
const children = [];
let logs = '';

function start(script, args, cwd) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      logs = (logs + chunk).slice(-20_000);
    });
  }
  return child;
}

async function waitFor(check, description, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    const failed = children.find((child) => child.exitCode !== null);
    if (failed) throw new Error(`Server exited while ${description}:\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out ${description}:\n${logs}`);
}

async function request(path, method = 'GET', body) {
  const response = await fetch(`${serverOrigin}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(
    response.ok,
    true,
    `${method} ${path}: ${await response.clone().text()}`,
  );
  return response.json();
}

async function launch() {
  electron = await _electron.launch({
    executablePath: desktopRequire('electron'),
    args: [
      join(repo, 'apps/desktop'),
      `--user-data-dir=${join(temporary, 'chromium')}`,
    ],
    env: {
      ...environment,
      EXTERNAL_SERVER_URL: serverOrigin,
      WEB_DEV_SERVER_URL: webOrigin,
      HUABU_INSTANCE: instance,
      HUABU_DEVTOOLS: '0',
    },
    timeout: 60_000,
  });
  electron.context().setDefaultTimeout(30_000);
  electron.context().setDefaultNavigationTimeout(30_000);
  electron.process().stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-20_000);
  });
  await electron.evaluate(({ dialog }) => {
    globalThis.tabsSmokeUnexpectedErrors = [];
    dialog.showErrorBox = (title, message) => {
      globalThis.tabsSmokeUnexpectedErrors.push({ title, message });
      console.error('[tabs-smoke] Unexpected native error:', title, message);
    };
  });
  const shell = await waitFor(
    () =>
      electron
        .context()
        .pages()
        .find((page) => page.url().includes('/_desktop')),
    'loading desktop Shell',
  );
  await shell.waitForFunction(() => Boolean(window.electronBridge?.tabs));
  await electron
    .evaluate(({ app, BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.closeDevTools();
      return app.getPath('userData');
    })
    .then((path) => {
      userData = path;
    });
  await waitFor(async () => {
    const state = await shell.evaluate(() =>
      window.electronBridge.tabs.getState(),
    );
    return state.workspaceId ? state : null;
  }, 'initializing Workspace');
  return shell;
}

async function content(canvasId) {
  const page = await waitFor(
    () =>
      electron
        .context()
        .pages()
        .find((entry) => entry.url().includes(`/canvas/${canvasId}`)),
    `loading Space ${canvasId}`,
  );
  await waitFor(
    () =>
      page.evaluate(async (id) => {
        const { default: store } = await import('/src/store/canvasStore.ts');
        return store.getState().canvasId === id && !store.getState().isLoading;
      }, canvasId),
    `hydrating Space ${canvasId}`,
  );
  await page.locator('.react-flow').waitFor({ state: 'visible' });
  console.log(`Hydrated Space ${canvasId}`);
  return page;
}

async function open(shell, canvasId) {
  const result = await shell.evaluate(
    (id) => window.electronBridge.tabs.open({ canvasId: id }),
    canvasId,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return content(canvasId);
}

async function closeElectron() {
  if (!electron) return;
  const running = electron;
  electron = undefined;
  let timer;
  try {
    await Promise.race([
      running.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Electron did not quit after the save barrier')),
          40_000,
        );
      }),
    ]);
  } catch (error) {
    if (running.process().exitCode === null) running.process().kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

try {
  start(
    serverRequire.resolve('tsx/cli'),
    ['src/server.ts'],
    join(repo, 'apps/server'),
  );
  start(
    join(dirname(webRequire.resolve('vite/package.json')), 'bin/vite.js'),
    ['--host', '127.0.0.1', '--strictPort'],
    join(repo, 'apps/web'),
  );
  await waitFor(async () => {
    try {
      return (
        (await fetch(`${serverOrigin}/api/workspace`)).ok &&
        (await fetch(webOrigin)).ok
      );
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return false;
    }
  }, 'starting isolated Server and Vite');
  await request('/workspace', 'PUT', { path: nextWorkspace });
  await request('/workspace', 'PUT', { path: workspace });
  const spaces = await Promise.all(
    ['A', 'B', 'C', 'D', 'E'].map((letter) =>
      request('/canvas', 'POST', { title: `Tabs smoke ${letter}` }),
    ),
  );
  let shell = await launch();
  const home = await waitFor(
    () =>
      electron
        .context()
        .pages()
        .find((page) => page.url().includes('/spaces')),
    'loading Home',
  );
  await home.locator('main h1').waitFor({ state: 'visible' });
  await home.evaluate(() => {
    localStorage.setItem('huabu.language', 'zh-CN');
    localStorage.setItem('huabu.recentConversationAgentProfile.v1', 'huabu');
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({
        state: { inputModePreference: 'finger' },
        version: 2,
      }),
    );
  });
  assert.equal(
    (await shell.evaluate(() => window.electronBridge.tabs.reload('home'))).ok,
    true,
  );
  await home.locator('main h1').waitFor({ state: 'visible' });
  await waitFor(
    () =>
      shell.evaluate(async () => {
        const { i18n } = await import('/src/i18n/index.ts');
        return i18n.language === 'zh-CN';
      }),
    'notifying an already loaded Shell after legacy preference migration',
  );
  assert.equal(
    JSON.parse(readFileSync(join(userData, 'desktop-tabs.json'), 'utf8'))
      .preferences['huabu.language'],
    'zh-CN',
    'Migration must persist before legacy storage is cleared',
  );
  assert.deepEqual(
    await home.evaluate(async () => {
      const { useToolStore } = await import('/src/store/toolStore.ts');
      const { getDefaultAgentBinding } =
        await import('/src/store/acpProfilesStore.ts');
      return {
        input: useToolStore.getState().inputModePreference,
        binding: getDefaultAgentBinding(),
        agentReplica: localStorage.getItem(
          'huabu.recentConversationAgentProfile.v1',
        ),
        languageReplica: localStorage.getItem('huabu.language'),
        toolsReplica: localStorage.getItem('huabu-sketch-tools'),
      };
    }),
    {
      input: 'finger',
      binding: { kind: 'internal' },
      agentReplica: null,
      languageReplica: null,
      toolsReplica: null,
    },
  );
  assert.equal(
    await home.locator('header').count(),
    0,
    'Desktop Home must not repeat the standalone brand header',
  );
  const workspaceLabels = await home.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return {
      switcher: i18n.t('workspace.switcher'),
      home: i18n.t('navigation.home'),
    };
  });
  const workspaceTrigger = shell.getByRole('button', {
    name: workspaceLabels.switcher,
    exact: true,
  });
  async function assertTabIconSizes() {
    await shell.getByRole('tab').first().waitFor({ state: 'visible' });
    const chrome = await shell.evaluate(() => {
      const strip = document.querySelector('[role="tablist"]')?.parentElement;
      if (!strip) throw new Error('Tab strip was not rendered');
      const controls = Array.from(strip.querySelectorAll('button')).flatMap(
        (button) => {
          const icon = button.querySelector('svg');
          if (!icon) return [];
          const glyph = icon.getBoundingClientRect();
          const target = button.getBoundingClientRect();
          return [
            {
              label: button.getAttribute('aria-label'),
              width: glyph.width,
              height: glyph.height,
              targetWidth: target.width,
              targetHeight: target.height,
            },
          ];
        },
      );
      return { height: strip.getBoundingClientRect().height, controls };
    });
    assert.equal(
      chrome.height,
      36,
      'The title strip must retain its existing height',
    );
    assert.ok(
      chrome.controls.length >= 4,
      'The persistent chrome icons must be present',
    );
    for (const control of chrome.controls) {
      assert.equal(control.width, 16, `${control.label} must use a 16px icon`);
      assert.equal(control.height, 16, `${control.label} must use a 16px icon`);
      assert.ok(
        control.targetWidth >= 28 && control.targetHeight >= 28,
        `${control.label} must have at least a 28px click target`,
      );
    }
  }
  await assertTabIconSizes();
  await workspaceTrigger.hover();
  await home.waitForTimeout(350);
  assert.equal(
    await home.getByRole('tooltip').count(),
    0,
    'Workspace hover must not show the old path/count tooltip',
  );
  await workspaceTrigger.press('ArrowDown');
  const workspaceMenu = home.getByRole('menu', {
    name: workspaceLabels.switcher,
    exact: true,
  });
  await workspaceMenu.waitFor({ state: 'visible' });
  assert.equal(await workspaceMenu.locator('[aria-current="true"]').count(), 1);
  const menuPresentation = await workspaceMenu.evaluate((menu) => {
    const bounds = menu.parentElement.getBoundingClientRect();
    const path = menu.querySelector('[aria-current="true"] span.text-xs');
    if (!path) throw new Error('Current Workspace path is missing');
    return {
      width: bounds.width,
      left: bounds.left,
      right: bounds.right,
      viewportWidth: window.innerWidth,
      pathClipped:
        path.scrollWidth > path.clientWidth &&
        getComputedStyle(path).textOverflow === 'ellipsis',
      itemFocused: document.activeElement?.getAttribute('role') === 'menuitem',
    };
  });
  assert.ok(
    menuPresentation.width <= 321,
    'Workspace menu must stay within its 320px width',
  );
  assert.ok(
    menuPresentation.left >= 0 &&
      menuPresentation.right <= menuPresentation.viewportWidth,
    'Workspace menu must stay inside the viewport',
  );
  assert.ok(
    menuPresentation.pathClipped,
    'Long Workspace paths must truncate within the panel',
  );
  assert.ok(
    menuPresentation.itemFocused,
    'Opening by keyboard must focus a menu item',
  );
  if (process.env.HUABU_TABS_SCREENSHOT) {
    await home.screenshot({
      path: process.env.HUABU_TABS_SCREENSHOT.replace(
        /\.png$/,
        '-workspace-menu.png',
      ),
    });
  }
  await workspaceMenu.press('Escape');
  await workspaceMenu.waitFor({ state: 'hidden' });
  await waitFor(
    () =>
      shell.evaluate(
        (label) => document.activeElement?.getAttribute('aria-label') === label,
        workspaceLabels.switcher,
      ),
    'restoring Workspace trigger focus after Escape',
  );
  const settingsLabels = await home.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return { open: i18n.t('settings.open'), title: i18n.t('settings.title') };
  });
  assert.equal(
    await home
      .getByRole('button', { name: settingsLabels.open, exact: true })
      .count(),
    0,
  );
  assert.equal(
    await shell
      .getByRole('button', { name: settingsLabels.open, exact: true })
      .count(),
    1,
  );
  const workspacePosition = await workspaceTrigger.evaluate(
    (button, settingsLabel) => {
      const strip = button.parentElement;
      const settings = button.previousElementSibling;
      if (!strip || !settings)
        throw new Error('Workspace action has no Settings neighbor');
      return {
        afterSettings: settings.getAttribute('aria-label') === settingsLabel,
        gap:
          button.getBoundingClientRect().left -
          settings.getBoundingClientRect().right,
        right: button.getBoundingClientRect().right,
        expectedRight:
          strip.getBoundingClientRect().right -
          parseFloat(getComputedStyle(strip).paddingRight),
      };
    },
    settingsLabels.open,
  );
  assert.ok(
    workspacePosition.afterSettings &&
      workspacePosition.gap >= 0 &&
      workspacePosition.gap <= 8,
    'Workspace must appear immediately to the right of Settings',
  );
  assert.ok(
    Math.abs(workspacePosition.right - workspacePosition.expectedRight) <= 1,
    'Workspace must be the rightmost application action',
  );
  async function openSettingsFromShell(page) {
    await shell
      .getByRole('button', { name: settingsLabels.open, exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      const { useSettingsUiStore } =
        await import('/src/store/settingsUiStore.ts');
      if (!useSettingsUiStore.getState().isOpen)
        throw new Error('Settings did not open in the active content page');
      useSettingsUiStore.getState().close();
    });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await openSettingsFromShell(home);
  const createLabel = await home.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return i18n.t('actions.newCanvas');
  });
  await home.getByRole('button', { name: createLabel, exact: true }).click();
  const createdTab = await waitFor(async () => {
    const snapshot = await shell.evaluate(() =>
      window.electronBridge.tabs.getState(),
    );
    return snapshot.tabs.find(
      (tab) =>
        tab.id === snapshot.activeId &&
        tab.canvasId &&
        !spaces.some((space) => space.canvasId === tab.canvasId),
    );
  }, 'opening a Space created from retained Home');
  await content(createdTab.canvasId);
  await shell.evaluate(() =>
    window.electronBridge.tabs.open({ canvasId: null }),
  );
  await home
    .locator(`a[href="/canvas/${createdTab.canvasId}"]`)
    .waitFor({ state: 'visible' });
  const deletionLabels = await home.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return {
      remove: i18n.t('canvasList.deleteCanvas'),
      confirm: i18n.t('actions.delete'),
      blocked: i18n.t('desktopTabs.closeBeforeDeleting'),
    };
  });
  const createdCard = home
    .locator(`a[href="/canvas/${createdTab.canvasId}"]`)
    .locator('..');
  await createdCard.hover();
  await createdCard
    .getByRole('button', { name: deletionLabels.remove, exact: true })
    .click();
  await home
    .getByText(deletionLabels.blocked, { exact: true })
    .waitFor({ state: 'visible' });
  assert.equal(
    await home.getByRole('dialog').count(),
    0,
    'An open Space must not enter delete confirmation',
  );
  assert.ok(
    (
      await shell.evaluate(() => window.electronBridge.tabs.getState())
    ).tabs.some((tab) => tab.id === createdTab.id),
    'Refusing deletion must keep the open Space Tab',
  );
  await request(`/canvas/${createdTab.canvasId}`);
  assert.equal(
    (
      await shell.evaluate(
        (id) => window.electronBridge.tabs.close(id),
        createdTab.id,
      )
    ).ok,
    true,
    'The Space created from Home must save and close normally',
  );
  await createdCard.hover();
  await createdCard
    .getByRole('button', { name: deletionLabels.remove, exact: true })
    .click();
  const deleteDialog = home.getByRole('dialog');
  await deleteDialog.waitFor({ state: 'visible' });
  await deleteDialog
    .getByRole('button', { name: deletionLabels.confirm, exact: true })
    .click();
  await home
    .locator(`a[href="/canvas/${createdTab.canvasId}"]`)
    .waitFor({ state: 'detached' });
  await waitFor(
    async () =>
      !(await shell.evaluate(() => window.electronBridge.tabs.getState())).busy,
    'releasing the closed-Space deletion guard',
  );
  assert.equal(
    (await fetch(`${serverOrigin}/api/canvas/${createdTab.canvasId}`)).status,
    404,
    'Closing the Tab must allow deleting the Space from Home',
  );
  if (process.env.HUABU_TABS_SCREENSHOT) {
    await home.screenshot({
      path: process.env.HUABU_TABS_SCREENSHOT.replace(/\.png$/, '-home.png'),
    });
  }
  await home.locator(`a[href="/canvas/${spaces[0].canvasId}"]`).click();
  const a = await content(spaces[0].canvasId);
  await assertTabIconSizes();
  await openSettingsFromShell(a);
  assert.equal(
    await workspaceTrigger.count(),
    1,
    'Workspace action must remain available in a Space',
  );
  await shell
    .getByRole('tab', { name: workspaceLabels.home, exact: true })
    .click();
  await workspaceTrigger.waitFor({ state: 'visible' });
  assert.equal(
    await workspaceMenu.count(),
    0,
    'Home navigation must not open a Workspace menu',
  );
  await shell.getByRole('tab', { name: 'Tabs smoke A', exact: true }).click();
  await workspaceTrigger.click();
  await workspaceMenu.waitFor({ state: 'visible' });
  assert.equal(
    (await shell.evaluate(() => window.electronBridge.tabs.getState()))
      .activeId,
    'home',
  );
  await shell.getByRole('tab', { name: 'Tabs smoke A', exact: true }).click();
  await workspaceMenu.waitFor({ state: 'hidden' });
  a.on('console', (message) => {
    if (message.type() === 'error')
      logs = (logs + `\n[Space A] ${message.text()}`).slice(-20_000);
  });
  const authored = await a.evaluate(async () => {
    const { default: canvas } = await import('/src/store/canvasStore.ts');
    const { useChatStore } = await import('/src/store/chatStore.ts');
    canvas.getState().addNode({
      id: 'tabs-smoke-note',
      nodeType: 'note',
      data: { label: 'Smoke Note', content: '# Smoke Note\nInitial content' },
      placementPoint: { x: 100, y: 100 },
    });
    useChatStore.getState().setDraft('tabs-smoke-chat', 'Space A unsent draft');
    canvas.getState().selectNodes(['tabs-smoke-note']);
    const instance = canvas.getState().rfInstance;
    if (!instance) throw new Error('Canvas viewport is not initialized');
    await instance.setViewport({ x: 120, y: 80, zoom: 0.8 });
    return {
      ids: canvas.getState().nodes.map((node) => node.id),
      canvasId: canvas.getState().canvasId,
      isLoading: canvas.getState().isLoading,
      viewport: instance.getViewport(),
    };
  });
  assert.ok(authored.ids.includes('tabs-smoke-note'), JSON.stringify(authored));
  assert.equal(authored.isLoading, false, JSON.stringify(authored));
  const b = await open(shell, spaces[1].canvasId);
  await waitFor(
    () =>
      a.evaluate(async () => {
        const { useDesktopTabStore } =
          await import('/src/store/desktopTabStore.ts');
        return !useDesktopTabStore.getState().isActive;
      }),
    'marking retained Space A inactive while Space B is selected',
  );
  await b.evaluate(async () => {
    const { useChatStore } = await import('/src/store/chatStore.ts');
    useChatStore
      .getState()
      .setDraft('tabs-smoke-chat', 'Space B independent draft');
  });
  const beforeSwitch = performance.now();
  await open(shell, spaces[0].canvasId);
  const switchMs = performance.now() - beforeSwitch;
  await waitFor(
    () =>
      a.evaluate(async () => {
        const { useDesktopTabStore } =
          await import('/src/store/desktopTabStore.ts');
        return useDesktopTabStore.getState().isActive;
      }),
    'reactivating retained Space A for result acknowledgement',
  );
  const retained = await a.evaluate(async () => {
    const { default: canvas } = await import('/src/store/canvasStore.ts');
    const { useChatStore, selectThreadDraft } =
      await import('/src/store/chatStore.ts');
    return {
      draft: selectThreadDraft(useChatStore.getState(), 'tabs-smoke-chat'),
      canvasId: canvas.getState().canvasId,
      ids: canvas.getState().nodes.map((node) => node.id),
      selected: canvas
        .getState()
        .nodes.filter((node) => node.selected)
        .map((node) => node.id),
      canUndo: canvas.getState().canUndo,
      viewport: canvas.getState().rfInstance?.getViewport(),
    };
  });
  assert.equal(retained.draft, 'Space A unsent draft');
  assert.equal(retained.canvasId, spaces[0].canvasId);
  assert.ok(retained.ids.includes('tabs-smoke-note'), JSON.stringify(retained));
  assert.deepEqual(retained.selected, ['tabs-smoke-note']);
  assert.equal(retained.canUndo, true);
  assert.deepEqual(retained.viewport, authored.viewport);
  const history = await a.evaluate(async () => {
    const { default: canvas, saveCanvasForSubmission } =
      await import('/src/store/canvasStore.ts');
    const canvasId = canvas.getState().canvasId;
    await saveCanvasForSubmission(canvasId);
    await canvas.getState().undo();
    await saveCanvasForSubmission(canvasId);
    const afterUndo = canvas.getState().nodes.map((node) => node.id);
    await canvas.getState().redo();
    await saveCanvasForSubmission(canvasId);
    return {
      afterUndo,
      afterRedo: canvas.getState().nodes.map((node) => node.id),
    };
  });
  assert.equal(history.afterUndo.includes('tabs-smoke-note'), false);
  assert.equal(history.afterRedo.includes('tabs-smoke-note'), true);
  assert.equal(
    await b.evaluate(async () => {
      const { useChatStore, selectThreadDraft } =
        await import('/src/store/chatStore.ts');
      return selectThreadDraft(useChatStore.getState(), 'tabs-smoke-chat');
    }),
    'Space B independent draft',
  );
  await a.evaluate(async () => {
    const { useChatPreferencesStore } =
      await import('/src/store/chatPreferencesStore.ts');
    useChatPreferencesStore.getState().setRecentTurnCount(7);
  });
  await waitFor(
    () =>
      b.evaluate(async () => {
        const { useChatPreferencesStore } =
          await import('/src/store/chatPreferencesStore.ts');
        return useChatPreferencesStore.getState().recentTurnCount === 7;
      }),
    'synchronizing preferences across partitions',
  );
  assert.deepEqual(
    await b.evaluate(async () => {
      const { getDefaultAgentBinding } =
        await import('/src/store/acpProfilesStore.ts');
      return getDefaultAgentBinding();
    }),
    { kind: 'internal' },
    'Fresh Space partitions must retain the migrated Built-In Agent selection',
  );
  await a.evaluate(async () => {
    const { useAcpProfilesStore } =
      await import('/src/store/acpProfilesStore.ts');
    useAcpProfilesStore
      .getState()
      .rememberConversationAgent('tabs-smoke-profile');
  });
  await waitFor(
    () =>
      b.evaluate(async () => {
        const { useAcpProfilesStore } =
          await import('/src/store/acpProfilesStore.ts');
        return (
          useAcpProfilesStore.getState().recentConversationProfileId ===
          'tabs-smoke-profile'
        );
      }),
    'synchronizing the recent conversational Agent across Space partitions',
  );
  await a.evaluate(async () => {
    const { rememberConversationAgentBinding } =
      await import('/src/store/acpProfilesStore.ts');
    rememberConversationAgentBinding({ kind: 'internal' });
  });
  await waitFor(
    () =>
      b.evaluate(async () => {
        const { getDefaultAgentBinding } =
          await import('/src/store/acpProfilesStore.ts');
        return getDefaultAgentBinding().kind === 'internal';
      }),
    'restoring the explicit Built-In Agent choice across partitions',
  );
  await b.evaluate(async () => {
    const { useToolStore } = await import('/src/store/toolStore.ts');
    useToolStore.getState().observePen();
  });
  await electron.evaluate(({ ipcMain }, canvasId) => {
    globalThis.tabsSmokeLegacyReads = 0;
    globalThis.tabsSmokeToolReads = 0;
    globalThis.tabsSmokeLegacyReadListener = () => {
      globalThis.tabsSmokeLegacyReads++;
    };
    globalThis.tabsSmokeToolReadListener = (event, key) => {
      if (
        key === 'huabu-sketch-tools' &&
        event.sender.getURL().includes(`/canvas/${canvasId}`)
      )
        globalThis.tabsSmokeToolReads++;
    };
    ipcMain.on('tabs:storage-snapshot', globalThis.tabsSmokeLegacyReadListener);
    ipcMain.on('tabs:get-preference', globalThis.tabsSmokeToolReadListener);
  }, spaces[1].canvasId);
  try {
    await b.evaluate(async () => {
      const { useToolStore } = await import('/src/store/toolStore.ts');
      for (let stroke = 0; stroke < 100; stroke++) {
        useToolStore.getState().observePen();
      }
    });
    assert.deepEqual(
      await electron.evaluate(() => ({
        legacy: globalThis.tabsSmokeLegacyReads,
        tools: globalThis.tabsSmokeToolReads,
      })),
      { legacy: 0, tools: 0 },
      'Repeated known pen input must not perform synchronous preference IPC',
    );
    await b.evaluate(async () => {
      const { useToolStore } = await import('/src/store/toolStore.ts');
      const next =
        useToolStore.getState().inputModePreference === 'pen'
          ? 'finger'
          : 'pen';
      useToolStore.getState().setInputModePreference(next);
    });
    assert.deepEqual(
      await electron.evaluate(() => ({
        legacy: globalThis.tabsSmokeLegacyReads,
        tools: globalThis.tabsSmokeToolReads,
      })),
      { legacy: 0, tools: 1 },
      'A preference edit must read one key rather than the full legacy snapshot',
    );
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      ipcMain.removeListener(
        'tabs:storage-snapshot',
        globalThis.tabsSmokeLegacyReadListener,
      );
      ipcMain.removeListener(
        'tabs:get-preference',
        globalThis.tabsSmokeToolReadListener,
      );
    });
  }
  await electron.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('/_desktop'),
    );
    app.focus({ steal: true });
    win.show();
    win.focus();
    win.webContents.focus();
  });
  const nativeFocusAvailable = await electron.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getFocusedWindow() !== null,
  );
  if (!nativeFocusAvailable)
    console.log(
      'Native focus assertions skipped: the test environment did not activate the fixture window.',
    );
  await shell.getByRole('tab', { name: 'Tabs smoke A', exact: true }).focus();
  for (const [key, label] of [
    ['End', 'Tabs smoke B'],
    ['ArrowLeft', 'Tabs smoke A'],
    ['Home', workspaceLabels.home],
    ['ArrowRight', 'Tabs smoke A'],
  ]) {
    await shell.keyboard.press(key);
    await waitFor(
      () =>
        shell
          .getByRole('tab', { name: label, exact: true })
          .evaluate(
            (button) =>
              button.getAttribute('aria-selected') === 'true' &&
              document.activeElement === button,
          ),
      `keeping keyboard focus after ${key}`,
    );
    if (nativeFocusAvailable)
      await waitFor(
        () =>
          electron.evaluate(({ BrowserWindow, webContents }) =>
            BrowserWindow.getAllWindows().some(
              (win) =>
                win.webContents.getURL().includes('/_desktop') &&
                win.webContents === webContents.getFocusedWebContents(),
            ),
          ),
        `retaining native Shell focus after ${key}`,
      );
  }
  await shell.getByRole('tab', { name: 'Tabs smoke A', exact: true }).click();
  if (process.platform === 'darwin' && nativeFocusAvailable) {
    const beforeMenu = await electron.evaluate(
      ({ BrowserWindow, webContents, Menu }) => {
        const win = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('/_desktop'),
        );
        const settings = Menu.getApplicationMenu()
          ?.items.flatMap((item) => item.submenu?.items ?? [])
          .find((item) => item.accelerator === 'CmdOrCtrl+,');
        if (!win || !settings) throw new Error('Missing native Settings menu');
        win.webContents.focus();
        const before = webContents.getFocusedWebContents()?.getURL();
        settings.click(settings, win, {});
        return before;
      },
    );
    await a.getByRole('dialog').waitFor({ state: 'visible' });
    assert.equal(beforeMenu?.includes('/_desktop'), true);
    assert.equal(
      await electron.evaluate(
        ({ webContents }, canvasId) =>
          webContents
            .getFocusedWebContents()
            ?.getURL()
            .includes(`/canvas/${canvasId}`),
        spaces[0].canvasId,
      ),
      true,
      'Native Settings must focus content before receiving keyboard input',
    );
    await a.keyboard.press('Escape');
    await a.getByRole('dialog').waitFor({ state: 'hidden' });
    console.log('Native Settings menu transferred focus from Shell to content');
  }
  const languageLabel = await a.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return i18n.t('settings.language');
  });
  const generalLabel = await a.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return i18n.t('settings.general');
  });
  await shell
    .getByRole('button', { name: settingsLabels.open, exact: true })
    .click();
  await a.getByRole('dialog').waitFor({ state: 'visible' });
  if (nativeFocusAvailable) {
    assert.equal(
      await electron.evaluate(({ webContents }, canvasId) => {
        return (
          webContents
            .getFocusedWebContents()
            ?.getURL()
            .includes(`/canvas/${canvasId}`) ?? false
        );
      }, spaces[0].canvasId),
      true,
      'Opening Settings must transfer native focus before any content click',
    );
    await a.keyboard.press('Escape');
    await a.getByRole('dialog').waitFor({ state: 'hidden' });
    await shell
      .getByRole('button', { name: settingsLabels.open, exact: true })
      .click();
    await a.getByRole('dialog').waitFor({ state: 'visible' });
  }
  await a.getByRole('button', { name: generalLabel, exact: true }).click();
  await a.getByRole('button', { name: languageLabel, exact: true }).click();
  await a.getByRole('option', { name: 'English', exact: true }).click();
  await a.evaluate(async () => {
    const { useSettingsUiStore } =
      await import('/src/store/settingsUiStore.ts');
    useSettingsUiStore.getState().close();
  });
  for (const page of [b, shell]) {
    await waitFor(
      () =>
        page.evaluate(async () => {
          const { i18n } = await import('/src/i18n/index.ts');
          return i18n.language === 'en';
        }),
      'synchronizing language into background content and Shell',
    );
  }
  await electron.evaluate(({ ipcMain }) => {
    globalThis.tabsSmokePreferenceWrites = [];
    globalThis.tabsSmokePreferenceListener = (_event, key, value) => {
      if (key === 'huabu.language' || key === 'huabu:world-enabled')
        globalThis.tabsSmokePreferenceWrites.push({ key, value });
    };
    ipcMain.on('tabs:set-preference', globalThis.tabsSmokePreferenceListener);
  });
  await b.evaluate(() => {
    globalThis.tabsSmokePreferenceNotifications = 0;
    globalThis.tabsSmokeUnsubscribePreferences =
      window.electronBridge.tabs.onPreference(() => {
        globalThis.tabsSmokePreferenceNotifications++;
      });
  });
  try {
    await a.evaluate(async () => {
      const { useWorkspaceStore } =
        await import('/src/store/workspaceStore.ts');
      const { writeApplicationPreference } =
        await import('/src/utils/desktopStorage.ts');
      useWorkspaceStore.getState().setWorldEnabled(true);
      useWorkspaceStore.getState().setWorldEnabled(false);
      writeApplicationPreference('huabu.language', 'zh-CN');
      writeApplicationPreference('huabu.language', 'en');
    });
    await waitFor(
      () => b.evaluate(() => globalThis.tabsSmokePreferenceNotifications >= 4),
      'applying queued preference notifications',
    );
    assert.deepEqual(
      await electron.evaluate(() => globalThis.tabsSmokePreferenceWrites),
      [
        { key: 'huabu:world-enabled', value: 'true' },
        { key: 'huabu:world-enabled', value: 'false' },
        { key: 'huabu.language', value: 'zh-CN' },
        { key: 'huabu.language', value: 'en' },
      ],
      'Incoming notifications must not write preferences back to main',
    );
    assert.deepEqual(
      await b.evaluate(async () => {
        const { i18n } = await import('/src/i18n/index.ts');
        const { useWorkspaceStore } =
          await import('/src/store/workspaceStore.ts');
        return {
          world: useWorkspaceStore.getState().worldEnabled,
          language: i18n.language,
        };
      }),
      { world: false, language: 'en' },
    );
    await b.evaluate(async () => {
      const { writeApplicationPreference } =
        await import('/src/utils/desktopStorage.ts');
      writeApplicationPreference('huabu.language', 'en');
    });
    await electron.evaluate(({ webContents }, canvasId) => {
      const target = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes(`/canvas/${canvasId}`));
      if (!target) throw new Error('Missing preference recipient');
      target.send('tabs:preference', {
        key: 'huabu.language',
        value: 'zh-CN',
      });
    }, spaces[1].canvasId);
    await waitFor(
      () => b.evaluate(() => globalThis.tabsSmokePreferenceNotifications >= 5),
      'processing a stale notification after a successful local write',
    );
    assert.deepEqual(
      await b.evaluate(async () => {
        const { i18n } = await import('/src/i18n/index.ts');
        const { readApplicationPreference } =
          await import('/src/utils/desktopStorage.ts');
        return {
          stored: readApplicationPreference('huabu.language'),
          replica: localStorage.getItem('huabu.language'),
          language: i18n.language,
        };
      }),
      { stored: 'en', replica: null, language: 'en' },
      'A stale notification must reread main instead of reverting the local preference',
    );
    for (const page of [a, b, shell]) {
      assert.deepEqual(
        await page.evaluate(() =>
          [
            'huabu.language',
            'huabu-sketch-tools',
            'huabu-chat-preferences',
            'huabu.recentConversationAgentProfile.v1',
            'huabu:world-enabled',
            'huabu.minimapEnabled',
          ].filter((key) => localStorage.getItem(key) !== null),
        ),
        [],
        'Desktop preference synchronization must not create localStorage replicas',
      );
    }
    assert.deepEqual(
      await b.evaluate(() => {
        const tabs = window.electronBridge.tabs;
        const snapshot = tabs.getPreference('huabu-sketch-tools');
        if (!snapshot.ok) throw new Error(snapshot.error);
        const before = snapshot.value;
        const result = tabs.setPreference(
          'huabu-sketch-tools',
          JSON.stringify({ state: { inputModePreference: 'pen' }, version: 3 }),
          'stale snapshot',
        );
        const after = tabs.getPreference('huabu-sketch-tools');
        if (!after.ok) throw new Error(after.error);
        return {
          rejected: !result.ok,
          unchanged: after.value === before,
        };
      }),
      { rejected: true, unchanged: true },
      'The native IPC boundary must reject conflicting preference replacements',
    );
    const blockedPreferencePath = join(userData, 'desktop-tabs.json.tmp');
    mkdirSync(blockedPreferencePath);
    try {
      assert.deepEqual(
        await b.evaluate(async () => {
          const { useChatPreferencesStore } =
            await import('/src/store/chatPreferencesStore.ts');
          const { useToolStore } = await import('/src/store/toolStore.ts');
          const { default: canvas } = await import('/src/store/canvasStore.ts');
          const { useAcpProfilesStore } =
            await import('/src/store/acpProfilesStore.ts');
          const actions = [
            () => useChatPreferencesStore.getState().setRecentTurnCount(9),
            () =>
              useToolStore
                .getState()
                .setInputModePreference(
                  useToolStore.getState().inputModePreference === 'mouse'
                    ? 'finger'
                    : 'mouse',
                ),
            () => canvas.getState().toggleMinimap(),
            () =>
              useAcpProfilesStore
                .getState()
                .rememberConversationAgent('failed-profile'),
          ];
          const before = [
            useChatPreferencesStore.getState().recentTurnCount,
            useToolStore.getState().inputModePreference,
            canvas.getState().minimapEnabled,
            useAcpProfilesStore.getState().recentConversationProfileId,
          ];
          const rejected = actions.map((action) => {
            try {
              action();
              return false;
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              return true;
            }
          });
          return {
            rejected,
            unchanged:
              JSON.stringify(before) ===
              JSON.stringify([
                useChatPreferencesStore.getState().recentTurnCount,
                useToolStore.getState().inputModePreference,
                canvas.getState().minimapEnabled,
                useAcpProfilesStore.getState().recentConversationProfileId,
              ]),
          };
        }),
        { rejected: [true, true, true, true], unchanged: true },
        'Real main-process persistence failures must not change renderer preferences',
      );
    } finally {
      rmdirSync(blockedPreferencePath);
    }
    assert.equal(
      await electron.evaluate(
        () => globalThis.tabsSmokePreferenceWrites.length,
      ),
      5,
      'Refreshing a stale notification must not echo another write',
    );
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      ipcMain.removeListener(
        'tabs:set-preference',
        globalThis.tabsSmokePreferenceListener,
      );
      delete globalThis.tabsSmokePreferenceListener;
      delete globalThis.tabsSmokePreferenceWrites;
    });
    await b.evaluate(() => {
      globalThis.tabsSmokeUnsubscribePreferences();
      delete globalThis.tabsSmokePreferenceNotifications;
      delete globalThis.tabsSmokeUnsubscribePreferences;
    });
  }
  let state = await shell.evaluate(() => window.electronBridge.tabs.getState());
  assert.equal(
    state.tabs.length,
    3,
    'Opening the same Space must not create another Tab',
  );
  const aId = state.tabs.find((tab) => tab.canvasId === spaces[0].canvasId).id;
  const bId = state.tabs.find((tab) => tab.canvasId === spaces[1].canvasId).id;
  await shell.getByRole('tab', { name: 'Tabs smoke B', exact: true }).click();
  const dismissLabel = await b.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return i18n.t('actions.dismiss');
  });
  const oldFeedback = b.getByRole('status').getByRole('button', {
    name: dismissLabel,
    exact: true,
  });
  while (await oldFeedback.count()) await oldFeedback.first().click();
  const titleRoute = '**/agent/threads/tabs-smoke-title/title**';
  let releaseTitle;
  let titleStarted = false;
  let titleRetry = false;
  const titleGate = new Promise((resolve) => {
    releaseTitle = resolve;
  });
  await b.route(titleRoute, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    titleStarted = true;
    if (!titleRetry) {
      await titleGate;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Delayed title write failed' }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ title: 'Delayed title', source: 'user' }),
      });
    }
  });
  let titleClose;
  try {
    await b.evaluate(async () => {
      const { renameConversationTitle } =
        await import('/src/store/conversationTitleStore.ts');
      const { default: canvas } = await import('/src/store/canvasStore.ts');
      const { usePreviewWorkspaceStore } =
        await import('/src/store/previewWorkspace/store.ts');
      const preview = usePreviewWorkspaceStore.getState();
      const tabId = preview.openPreviewTarget({
        kind: 'chat',
        canvasId: canvas.getState().canvasId,
        threadId: 'tabs-smoke-title',
      });
      globalThis.tabsSmokeTitleRename = renameConversationTitle(
        canvas.getState().canvasId,
        'tabs-smoke-title',
        'Delayed title',
        false,
      ).then(
        () => null,
        (error) => error.message,
      );
      preview.closeTab(tabId);
      if (usePreviewWorkspaceStore.getState().workspace.tabs[tabId])
        throw new Error('Inner Chat should remain closable during title write');
    });
    await waitFor(() => titleStarted, 'holding a conversation title write');
    let titleCloseSettled = false;
    titleClose = shell
      .evaluate((id) => window.electronBridge.tabs.close(id), bId)
      .then((result) => {
        titleCloseSettled = true;
        return result;
      });
    await b
      .locator('div.bg-surface.absolute.inset-0')
      .filter({ hasText: 'Saving Space' })
      .waitFor({ state: 'visible' });
    assert.equal(
      titleCloseSettled,
      false,
      'A pending title rename must hold the native close barrier',
    );
    assert.equal(b.isClosed(), false);
    releaseTitle();
    const titleRefused = await titleClose;
    assert.equal(titleRefused.ok, false);
    assert.match(titleRefused.error, /Delayed title write failed/);
    assert.equal(
      b.isClosed(),
      false,
      'A title failure must keep its renderer available for explicit retry',
    );
    assert.equal(await b.evaluate(() => document.body.inert), false);
    assert.equal(
      (await shell.evaluate((id) => window.electronBridge.tabs.reload(id), bId))
        .ok,
      false,
      'Reload must also reject the unresolved title failure',
    );
    await shell.getByRole('tab', { name: 'Tabs smoke B', exact: true }).click();
    const retryTitleLabel = await b.evaluate(async () => {
      const { i18n } = await import('/src/i18n/index.ts');
      return i18n.t('chat.retryTitleSave');
    });
    const titleFeedback = b.getByRole('status').filter({
      hasText: 'Delayed title write failed',
    });
    if (process.env.HUABU_TABS_SCREENSHOT) {
      await titleFeedback
        .last()
        .getByRole('button', {
          name: retryTitleLabel,
          exact: true,
        })
        .waitFor({ state: 'visible' });
      await waitFor(
        () =>
          titleFeedback
            .last()
            .evaluate((element) => getComputedStyle(element).opacity === '1'),
        'title recovery feedback animation',
      );
      await b.screenshot({
        path: process.env.HUABU_TABS_SCREENSHOT.replace(
          /\.png$/,
          '-title-retry.png',
        ),
      });
    }
    await titleFeedback
      .last()
      .getByRole('button', { name: retryTitleLabel, exact: true })
      .click();
    await waitFor(
      async () =>
        b.evaluate(async () => {
          const { useConversationTitleStore, conversationTitleKey } =
            await import('/src/store/conversationTitleStore.ts');
          const { default: canvas } = await import('/src/store/canvasStore.ts');
          const entry =
            useConversationTitleStore.getState().entries[
              conversationTitleKey(
                canvas.getState().canvasId,
                'tabs-smoke-title',
              )
            ];
          return !entry.renaming && !!entry.failedTitle;
        }),
      'failed title retry retaining recovery',
    );
    await titleFeedback
      .last()
      .getByRole('button', { name: retryTitleLabel, exact: true })
      .waitFor();
    titleRetry = true;
    await titleFeedback
      .last()
      .getByRole('button', { name: retryTitleLabel, exact: true })
      .click();
    await waitFor(
      async () =>
        b.evaluate(async () => {
          const { useConversationTitleStore, conversationTitleKey } =
            await import('/src/store/conversationTitleStore.ts');
          const { default: canvas } = await import('/src/store/canvasStore.ts');
          return !useConversationTitleStore.getState().entries[
            conversationTitleKey(canvas.getState().canvasId, 'tabs-smoke-title')
          ]?.error;
        }),
      'successful title retry from desktop save-error UI',
    );
    assert.deepEqual(
      await b.evaluate(async () => {
        const {
          conversationTitleKey,
          useConversationTitleStore,
          drainConversationTitleWrites,
        } = await import('/src/store/conversationTitleStore.ts');
        const { default: canvas } = await import('/src/store/canvasStore.ts');
        const canvasId = canvas.getState().canvasId;
        await drainConversationTitleWrites();
        const { usePreviewWorkspaceStore } =
          await import('/src/store/previewWorkspace/store.ts');
        if (
          Object.values(
            usePreviewWorkspaceStore.getState().workspace.tabs,
          ).some(
            (tab) =>
              tab.target.kind === 'chat' &&
              tab.target.threadId === 'tabs-smoke-title',
          )
        )
          throw new Error('Title recovery must not reopen the closed Chat');
        const entry =
          useConversationTitleStore.getState().entries[
            conversationTitleKey(canvasId, 'tabs-smoke-title')
          ];
        await globalThis.tabsSmokeTitleRename;
        delete globalThis.tabsSmokeTitleRename;
        return { title: entry.value.title, error: entry.error ?? null };
      }),
      { title: 'Delayed title', error: null },
    );
    console.log(
      'Closed Chat title failure retained desktop retry access and recovered after another failed retry',
    );
    await shell.getByRole('tab', { name: 'Tabs smoke A', exact: true }).click();
  } finally {
    releaseTitle();
    await titleClose;
    if (!b.isClosed()) await b.unroute(titleRoute);
  }
  await a.evaluate(async () => {
    const { default: store } = await import('/src/store/canvasStore.ts');
    store.setState({ versionConflict: true });
  });
  const refused = await shell.evaluate(
    (id) => window.electronBridge.tabs.close(id),
    aId,
  );
  assert.equal(
    refused.ok,
    false,
    'An unresolved save conflict must keep the Tab open',
  );
  assert.equal(a.isClosed(), false);
  await b.evaluate(async () => {
    const { default: canvas, saveCanvasForSubmission } =
      await import('/src/store/canvasStore.ts');
    canvas.getState().addNode({
      id: 'tabs-smoke-quit-note',
      nodeType: 'note',
      data: { label: 'Quit barrier', content: 'Before quit' },
      placementPoint: { x: 200, y: 200 },
    });
    await saveCanvasForSubmission(canvas.getState().canvasId);
  });
  for (const firstAction of ['quit', 'close']) {
    const expectedContent = `Saved before ${firstAction}`;
    let releaseQuitSave;
    let quitSaveStarted = false;
    const quitSaveGate = new Promise((resolve) => {
      releaseQuitSave = resolve;
    });
    await b.route('**/nodes/tabs-smoke-quit-note/content', async (route) => {
      if (route.request().method() === 'PUT') {
        quitSaveStarted = true;
        await quitSaveGate;
      }
      await route.continue();
    });
    await b.evaluate(async (content) => {
      const { default: canvas } = await import('/src/store/canvasStore.ts');
      canvas.getState().updateNodeData('tabs-smoke-quit-note', { content });
    }, expectedContent);
    await electron.evaluate(({ dialog }) => {
      globalThis.tabsSmokeShowErrorBox = dialog.showErrorBox;
      globalThis.tabsSmokeQuitErrors = [];
      dialog.showErrorBox = (title, message) =>
        globalThis.tabsSmokeQuitErrors.push({ title, message });
    });
    try {
      assert.equal(
        await electron.evaluate(({ app, BrowserWindow }, action) => {
          const event = {
            prevented: false,
            preventDefault() {
              this.prevented = true;
            },
          };
          if (action === 'quit') app.emit('before-quit', event);
          else {
            const win = BrowserWindow.getAllWindows().find((entry) =>
              entry.webContents.getURL().includes('/_desktop'),
            );
            win.emit('close', event);
          }
          return event.prevented;
        }, firstAction),
        true,
        `Initial ${firstAction} must wait for saves`,
      );
      await waitFor(() => quitSaveStarted, 'holding a save during quit');
      const repeated = await electron.evaluate(({ app, BrowserWindow }) => {
        const quit = {
          prevented: false,
          preventDefault() {
            this.prevented = true;
          },
        };
        const close = {
          prevented: false,
          preventDefault() {
            this.prevented = true;
          },
        };
        app.emit('before-quit', quit);
        const win = BrowserWindow.getAllWindows().find((entry) =>
          entry.webContents.getURL().includes('/_desktop'),
        );
        win.emit('close', close);
        return {
          quitPrevented: quit.prevented,
          closePrevented: close.prevented,
        };
      });
      assert.deepEqual(repeated, { quitPrevented: true, closePrevented: true });
      assert.equal(a.isClosed(), false);
      assert.equal(b.isClosed(), false);
      const beforeDelete = await a.evaluate(async () => {
        const { default: canvas } = await import('/src/store/canvasStore.ts');
        return canvas.getState().nodes.map((node) => node.id);
      });
      await a.keyboard.press('Delete');
      const frozen = await a.evaluate(async () => {
        const { default: canvas } = await import('/src/store/canvasStore.ts');
        let clicked = false;
        const portalButton = document.createElement('button');
        portalButton.addEventListener('click', () => {
          clicked = true;
        });
        document.body.appendChild(portalButton);
        portalButton.click();
        portalButton.remove();
        return {
          inert: document.body.inert,
          clicked,
          ids: canvas.getState().nodes.map((node) => node.id),
        };
      });
      assert.deepEqual(frozen, {
        inert: true,
        clicked: false,
        ids: beforeDelete,
      });
    } finally {
      releaseQuitSave();
      await waitFor(
        () =>
          electron.evaluate(() => globalThis.tabsSmokeQuitErrors.length > 0),
        'rejecting quit without destroying pages after a failed save',
      );
      await electron.evaluate(({ dialog }) => {
        dialog.showErrorBox = globalThis.tabsSmokeShowErrorBox;
        delete globalThis.tabsSmokeShowErrorBox;
        delete globalThis.tabsSmokeQuitErrors;
      });
      await b.unroute('**/nodes/tabs-smoke-quit-note/content');
    }
    await waitFor(
      () => a.evaluate(() => !document.body.inert),
      'resuming input after quit was rejected',
    );
    assert.equal(
      (
        await request(
          `/canvas/${spaces[1].canvasId}/nodes/tabs-smoke-quit-note/content`,
        )
      ).content,
      expectedContent,
    );
    console.log(
      `Repeated quit/window close retained the save barrier (${firstAction} first)`,
    );
  }
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  await a.route('**/nodes/tabs-smoke-note/content', async (route) => {
    if (route.request().method() === 'PUT') await saveGate;
    await route.continue();
  });
  await a.evaluate(async () => {
    const { default: store } = await import('/src/store/canvasStore.ts');
    store.setState({ versionConflict: false });
    store.getState().updateNodeData('tabs-smoke-note', {
      content: '# Smoke Note\nSaved on close',
    });
  });
  const closing = shell.evaluate(
    (id) => window.electronBridge.tabs.close(id),
    aId,
  );
  let savingPresentation;
  try {
    const overlay = a
      .locator('div.bg-surface.absolute.inset-0')
      .filter({ hasText: 'Saving Space' });
    await overlay.waitFor({ state: 'visible' });
    await electron.evaluate(({ app, dialog }) => {
      globalThis.tabsSmokeShowErrorBox = dialog.showErrorBox;
      globalThis.tabsSmokeQuitErrors = [];
      dialog.showErrorBox = (title, message) =>
        globalThis.tabsSmokeQuitErrors.push({ title, message });
      app.emit('before-quit', { preventDefault() {} });
    });
    try {
      await waitFor(
        () =>
          electron.evaluate(() => globalThis.tabsSmokeQuitErrors.length > 0),
        'rejecting quit while a Tab close owns the save barrier',
      );
      assert.equal(
        (await shell.evaluate(() => window.electronBridge.tabs.getState()))
          .busy,
        true,
        'A rejected quit must not release a Tab close save barrier',
      );
      assert.equal(
        await a.evaluate(() => document.body.inert),
        true,
        'A rejected quit must not unfreeze the Tab being saved',
      );
    } finally {
      await electron.evaluate(({ dialog }) => {
        dialog.showErrorBox = globalThis.tabsSmokeShowErrorBox;
        delete globalThis.tabsSmokeShowErrorBox;
        delete globalThis.tabsSmokeQuitErrors;
      });
    }
    savingPresentation = await overlay.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('Cannot measure saving overlay opacity');
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const bounds = element.getBoundingClientRect();
      return {
        alpha: context.getImageData(0, 0, 1, 1).data[3],
        coversPage:
          bounds.left === 0 &&
          bounds.top === 0 &&
          bounds.width === window.innerWidth &&
          bounds.height === window.innerHeight,
      };
    });
  } finally {
    releaseSave();
  }
  const closed = await closing;
  assert.equal(
    savingPresentation.alpha,
    255,
    'Saving must fully cover underlying loading text',
  );
  assert.equal(
    savingPresentation.coversPage,
    true,
    'Saving must cover the entire content page',
  );
  assert.equal(closed.ok, true, JSON.stringify(closed));
  console.log('Close save acknowledged');
  const saved = await request(
    `/canvas/${spaces[0].canvasId}/nodes/tabs-smoke-note/content`,
  );
  assert.equal(saved.content, '# Smoke Note\nSaved on close');
  const reopened = await open(shell, spaces[0].canvasId);
  assert.equal(
    await reopened.evaluate(async () => {
      const { default: store } = await import('/src/store/canvasStore.ts');
      return store
        .getState()
        .nodes.some((node) => node.id === 'tabs-smoke-note');
    }),
    true,
  );
  for (const space of spaces.slice(2)) await open(shell, space.canvasId);
  state = await shell.evaluate(() => window.electronBridge.tabs.getState());
  assert.equal(state.tabs.length, 6);
  const metrics = await electron.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      type: metric.type,
      workingSetKB: metric.memory.workingSetSize,
    })),
  );
  if (process.env.HUABU_TABS_SCREENSHOT) {
    const active = await content(spaces[4].canvasId);
    await active.screenshot({
      path: process.env.HUABU_TABS_SCREENSHOT.replace(/\.png$/, '-content.png'),
    });
    const png = await electron.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((entry) =>
        entry.webContents.getURL().includes('/_desktop'),
      );
      return Array.from((await win.capturePage()).toPNG());
    });
    writeFileSync(process.env.HUABU_TABS_SCREENSHOT, Buffer.from(png));
  }
  assert.deepEqual(
    await electron.evaluate(() => globalThis.tabsSmokeUnexpectedErrors),
    [],
    'Unexpected native errors before restart must fail the smoke test',
  );
  await closeElectron();
  shell = await launch();
  const restored = await shell.evaluate(() =>
    window.electronBridge.tabs.getState(),
  );
  assert.deepEqual(
    restored.tabs.map((tab) => tab.canvasId),
    state.tabs.map((tab) => tab.canvasId),
  );
  assert.equal(
    restored.tabs.find((tab) => tab.id === restored.activeId).canvasId,
    spaces[4].canvasId,
  );
  const restoredSpace = await content(spaces[4].canvasId);
  assert.deepEqual(
    await restoredSpace.evaluate(async () => {
      const { useChatPreferencesStore } =
        await import('/src/store/chatPreferencesStore.ts');
      const { i18n } = await import('/src/i18n/index.ts');
      const { getDefaultAgentBinding } =
        await import('/src/store/acpProfilesStore.ts');
      return {
        recentTurnCount: useChatPreferencesStore.getState().recentTurnCount,
        binding: getDefaultAgentBinding(),
        language: i18n.language,
        replica: localStorage.getItem('huabu-chat-preferences'),
      };
    }),
    {
      recentTurnCount: 7,
      binding: { kind: 'internal' },
      language: 'en',
      replica: null,
    },
    'Restart must hydrate in-memory preferences from main, without renderer replicas',
  );
  const loaded = await electron.evaluate(
    ({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((entry) => entry.getURL().includes('/canvas/')).length,
  );
  assert.equal(loaded, 1, 'Restoration must load only the active Space');
  await shell.evaluate(() =>
    window.electronBridge.tabs.open({ canvasId: null }),
  );
  const restoredHome = await waitFor(
    () =>
      electron
        .context()
        .pages()
        .find((page) => page.url().includes('/spaces')),
    'returning to Home',
  );
  const restoredSwitcherLabel = await restoredHome.evaluate(async () => {
    const { i18n } = await import('/src/i18n/index.ts');
    return i18n.t('workspace.switcher');
  });
  await shell
    .getByRole('button', { name: restoredSwitcherLabel, exact: true })
    .click();
  await restoredHome.locator('a[role="menuitem"][href="/setup"]').click();
  await restoredHome.waitForURL('**/setup');
  await restoredHome
    .locator('input[type="text"]')
    .waitFor({ state: 'visible' });
  const beforeSelection = await shell.evaluate(() =>
    window.electronBridge.tabs.getState(),
  );
  assert.equal(
    beforeSelection.workspaceId,
    restored.workspaceId,
    'Opening the Home switch page must not activate another Workspace',
  );
  assert.deepEqual(
    beforeSelection.tabs.map((tab) => tab.canvasId),
    restored.tabs.map((tab) => tab.canvasId),
    'Opening the Home switch page must retain the existing Space Tabs',
  );
  await shell
    .getByRole('button', { name: restoredSwitcherLabel, exact: true })
    .click();
  await restoredHome
    .getByRole('menuitem')
    .filter({ hasText: nextWorkspace })
    .click();
  const switched = await waitFor(async () => {
    const state = await shell.evaluate(() =>
      window.electronBridge.tabs.getState(),
    );
    return state.workspaceId &&
      state.workspaceId !== restored.workspaceId &&
      !state.busy
      ? state
      : null;
  }, 'switching Workspace through the dropdown');
  assert.equal(
    switched.tabs.length,
    1,
    'Workspace activation must remove old Space pages',
  );
  assert.notEqual(switched.workspaceId, restored.workspaceId);
  await restoredHome.waitForURL('**/spaces');
  assert.deepEqual(
    await electron.evaluate(() => globalThis.tabsSmokeUnexpectedErrors),
    [],
    'Unexpected native errors must fail the smoke test rather than block it',
  );
  const shutdownSpace = await request('/canvas', 'POST', {
    title: 'Shutdown recovery',
  });
  await open(shell, shutdownSpace.canvasId);
  const transition = await restoredHome.evaluate(() =>
    window.electronBridge.tabs.beginWorkspaceChange(),
  );
  assert.equal(transition.ok, true);
  assert.equal(
    (await shell.evaluate(() => window.electronBridge.tabs.getState())).busy,
    true,
  );
  await electron.evaluate(({ webContents }) => {
    const home = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().endsWith('/spaces'));
    if (!home) throw new Error('Missing Home transition owner');
    home.forcefullyCrashRenderer();
  });
  await waitFor(async () => {
    const state = await shell.evaluate(() =>
      window.electronBridge.tabs.getState(),
    );
    return !state.busy && state.tabs.find((tab) => tab.id === 'home')?.error;
  }, 'releasing the abandoned Workspace transition');
  const abandoned = await shell.evaluate(() =>
    window.electronBridge.tabs.getState(),
  );
  assert.equal(abandoned.workspaceId, null);
  assert.deepEqual(
    abandoned.tabs.map((tab) => tab.canvasId),
    [null],
  );
  assert.equal(
    (
      await electron.evaluate(() =>
        globalThis.tabsSmokeUnexpectedErrors.splice(0),
      )
    ).length,
    1,
  );
  const reloaded = await shell.evaluate(() =>
    window.electronBridge.tabs.reload('home'),
  );
  assert.equal(reloaded.ok, true);
  await waitFor(async () => {
    const state = await shell.evaluate(() =>
      window.electronBridge.tabs.getState(),
    );
    return (
      !state.busy &&
      state.workspaceId === switched.workspaceId &&
      state.tabs.some((tab) => tab.canvasId === shutdownSpace.canvasId)
    );
  }, 'confirming Server identity and restoring saved Tabs after Home recovery');
  console.log(
    'Home recovered an abandoned Workspace transition without guessing identity',
  );
  let healthy = await open(shell, shutdownSpace.canvasId);
  await healthy.evaluate(async () => {
    const { writeApplicationPreference } =
      await import('/src/utils/desktopStorage.ts');
    writeApplicationPreference('huabu.minimapEnabled', 'true');
  });
  const closingPreferenceSpace = await shell.evaluate(async (canvasId) => {
    const state = await window.electronBridge.tabs.getState();
    const tab = state.tabs.find((entry) => entry.canvasId === canvasId);
    if (!tab) throw new Error('Missing preference test Space');
    return window.electronBridge.tabs.close(tab.id);
  }, shutdownSpace.canvasId);
  assert.equal(closingPreferenceSpace.ok, true);
  await electron.evaluate(async ({ webContents }) => {
    const home = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().endsWith('/spaces'));
    if (!home) throw new Error('Missing recovered Home renderer');
    await home.executeJavaScript(`import('/src/utils/desktopStorage.ts').then(
      ({ writeApplicationPreference }) => writeApplicationPreference('huabu.minimapEnabled', null)
    )`);
  });
  healthy = await open(shell, shutdownSpace.canvasId);
  assert.deepEqual(
    await healthy.evaluate(async () => {
      const { default: canvas } = await import('/src/store/canvasStore.ts');
      const { readApplicationPreference } =
        await import('/src/utils/desktopStorage.ts');
      return {
        stored: readApplicationPreference('huabu.minimapEnabled'),
        enabled: canvas.getState().minimapEnabled,
        replica: localStorage.getItem('huabu.minimapEnabled'),
      };
    }),
    { stored: null, enabled: false, replica: null },
    'Reopening a closed partition must use main defaults for deleted preferences',
  );
  await healthy.evaluate(async () => {
    const { default: canvas } = await import('/src/store/canvasStore.ts');
    canvas.getState().addNode({
      id: 'tabs-smoke-shutdown-note',
      nodeType: 'note',
      data: {
        label: 'Shutdown recovery',
        content: 'Saved despite Home failure',
      },
      placementPoint: { x: 100, y: 100 },
    });
  });
  await electron.evaluate(({ webContents }) => {
    const home = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().endsWith('/spaces'));
    if (!home) throw new Error('Missing Home renderer');
    home.forcefullyCrashRenderer();
  });
  await waitFor(
    async () =>
      (
        await shell.evaluate(() => window.electronBridge.tabs.getState())
      ).tabs.find((tab) => tab.id === 'home')?.error,
    'detecting failed Home',
  );
  assert.equal(
    (
      await electron.evaluate(() =>
        globalThis.tabsSmokeUnexpectedErrors.splice(0),
      )
    ).length,
    1,
    'The intentional Home crash must produce one native failure notification',
  );
  await electron.evaluate(({ app, dialog }) => {
    globalThis.tabsSmokeShutdownDialog = null;
    dialog.showMessageBox = async (_win, options) => {
      globalThis.tabsSmokeShutdownDialog = options;
      return { response: 0, checkboxChecked: false };
    };
    app.emit('before-quit', { preventDefault() {} });
  });
  await waitFor(
    async () =>
      (await electron.evaluate(() => globalThis.tabsSmokeShutdownDialog)) &&
      !(await shell.evaluate(() => window.electronBridge.tabs.getState())).busy,
    'cancelling unavailable-Home shutdown',
  );
  await waitFor(
    () => healthy.evaluate(() => !document.body.inert),
    'resuming the healthy Space',
  );
  assert.equal(healthy.isClosed(), false);
  assert.equal(
    (
      await request(
        `/canvas/${shutdownSpace.canvasId}/nodes/tabs-smoke-shutdown-note/content`,
      )
    ).content,
    'Saved despite Home failure',
  );
  assert.deepEqual(
    await electron.evaluate(() => globalThis.tabsSmokeUnexpectedErrors),
    [],
  );
  await electron.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  await closeElectron();
  console.log(
    'Unavailable Home shutdown was cancelled safely, then explicitly confirmed',
  );
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        spaces: 5,
        warmSwitchMs: Math.round(switchMs),
        metrics,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  try {
    await closeElectron();
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode === null
          ? new Promise((resolve) => child.once('exit', resolve))
          : Promise.resolve(),
      ),
    );
    rmSync(temporary, { recursive: true, force: true });
    if (userData && userData.includes(instance))
      rmSync(userData, { recursive: true, force: true });
  }
}
