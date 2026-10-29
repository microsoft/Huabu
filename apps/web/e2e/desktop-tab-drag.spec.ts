// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import type { DesktopTabsSnapshot } from '@huabu/shared/desktop-tabs';

test.use({ hasTouch: false });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let state: DesktopTabsSnapshot = {
      activeId: 'a',
      workspaceId: 'workspace',
      busy: false,
      canChangeWorkspace: false,
      tabs: ['home', 'a', 'b', 'c'].map((id) => ({
        id,
        canvasId: id === 'home' ? null : id,
        title: id.toUpperCase(),
        loading: false,
        running: false,
        unread: false,
        error: null,
      })),
    };
    const listeners = new Set<(value: DesktopTabsSnapshot) => void>();
    window.electronBridge = {
      isElectron: true,
      isRemoteServer: false,
      platform: 'darwin',
      titleBarHeight: 36,
      versions: { electron: '', chrome: '', node: '' },
      tabs: {
        context: { role: 'shell', canvasId: null, workspaceId: null },
        getState: async () => state,
        onState: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        command: async (command) => {
          if (typeof command !== 'object' || command.type !== 'move-tab')
            return { ok: false, error: 'Unexpected command in drag test' };
          await new Promise((resolve) => setTimeout(resolve, 150));
          const next = state.tabs.slice();
          const from = next.findIndex((tab) => tab.id === command.id);
          const [tab] = next.splice(from, 1);
          next.splice(command.index, 0, tab);
          state = { ...state, tabs: next };
          listeners.forEach((listener) => listener(state));
          return { ok: true };
        },
        activate: async (target) => {
          if (typeof target === 'string' || target.focus !== 'shell')
            return { ok: false, error: 'Dragging must not activate a Tab' };
          state = { ...state, activeId: target.id };
          listeners.forEach((listener) => listener(state));
          return { ok: true };
        },
        close: async () => ({ ok: true }),
        reload: async () => ({ ok: true }),
        open: async () => ({ ok: true }),
        getPreference: () => ({ ok: true, value: null }),
        storageSnapshot: () => ({ ok: true, values: {} }),
        setPreference: () => ({ ok: true }),
        onPreference: () => () => {},
        onHomeMenu: () => () => {},
        onNavigate: () => () => {},
        onPrepareClose: () => () => {},
        onClosePrepared: () => () => {},
        onResume: () => () => {},
        ready: () => {},
        report: () => {},
        keepPrepareCloseAlive: () => {},
        finishPrepareClose: () => {},
        workspaceReady: async () => ({ ok: true }),
        beginWorkspaceChange: async () => ({ ok: true }),
        endWorkspaceChange: async () => ({ ok: true }),
      },
    };
  });
  await page.goto('/_desktop');
  await expect(page.getByRole('tab', { name: 'A', exact: true })).toBeVisible();
});

test('animates neighbours, keeps Home fixed, and settles without snapping back during IPC', async ({
  page,
}) => {
  const a = page.getByRole('tab', { name: 'A', exact: true });
  const b = page.getByRole('tab', { name: 'B', exact: true });
  const start = await a.boundingBox();
  const end = await b.boundingBox();
  expect(start && end).toBeTruthy();
  if (!start || !end) throw new Error('Missing Tab geometry');
  const homeBounds = await page.getByRole('tab').first().boundingBox();
  const y = start.y + start.height / 2;
  await page.mouse.move(start.x + start.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 6, y);
  const overlay = page.getByTestId('desktop-tab-drag-overlay');
  await expect(overlay).toBeVisible();
  await page.mouse.move(end.x + end.width / 2, y, { steps: 10 });
  await expect
    .poll(() =>
      b.evaluate((button) => {
        if (!button.parentElement) throw new Error('Missing Tab segment');
        const style = getComputedStyle(button.parentElement);
        return (
          style.transform !== 'none' &&
          new DOMMatrixReadOnly(style.transform).m41 < -10 &&
          style.transitionProperty.includes('transform')
        );
      }),
    )
    .toBe(true);
  expect(await page.getByRole('tab').first().boundingBox()).toEqual(homeBounds);
  await expect(overlay).toHaveText('A');
  const overlayBounds = await overlay.boundingBox();
  expect(overlayBounds?.y).toBeCloseTo(start.y, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(b.locator('..')).toHaveCSS('transition-property', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.up();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole('tab').nth(1)).toHaveText('B');
  await expect(a).toBeEnabled();
  await expect(page.getByRole('tab').nth(1)).toHaveText('B');
  await expect(a).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Escape and window blur cancel the pointer gesture without changing order', async ({
  page,
}) => {
  for (const reason of ['escape', 'blur']) {
    const a = page.getByRole('tab', { name: 'A', exact: true });
    const rect = await a.boundingBox();
    if (!rect) throw new Error('Missing Tab geometry');
    await page.mouse.move(rect.x + 10, rect.y + 16);
    await page.mouse.down();
    await page.mouse.move(rect.x + 80, rect.y + 16, { steps: 5 });
    await expect(page.getByTestId('desktop-tab-drag-overlay')).toBeVisible();
    if (reason === 'escape') await page.keyboard.press('Escape');
    else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await expect(page.getByTestId('desktop-tab-drag-overlay')).toHaveCount(0);
    await expect(page.getByRole('tab').nth(1)).toHaveText('A');
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});

for (const rejected of [false, true]) {
  test(`keyboard focus survives ${rejected ? 'rejected' : 'acknowledged'} moves and supports subsequent shortcuts`, async ({
    page,
  }) => {
    if (rejected) {
      await page.evaluate(() => {
        const tabs = window.electronBridge?.tabs;
        if (!tabs) throw new Error('Missing Tab bridge');
        const command = tabs.command;
        tabs.command = async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          tabs.command = command;
          return { ok: false, error: 'Move rejected' };
        };
      });
    }
    const a = page.getByRole('tab', { name: 'A', exact: true });
    await a.focus();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect(a).toBeEnabled();
    await expect(page.getByRole('tab').nth(rejected ? 1 : 2)).toHaveText('A');
    if (rejected)
      await expect(page.getByRole('alert')).toHaveText('Move rejected');
    await expect(a).toBeFocused();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect(page.getByRole('tab').nth(rejected ? 2 : 3)).toHaveText('A');
    await expect(a).toBeEnabled();
    await expect(a).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    const previous = page.getByRole('tab', {
      name: rejected ? 'B' : 'C',
      exact: true,
    });
    await expect(previous).toBeFocused();
    await expect(previous).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
