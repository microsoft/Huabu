// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import en from '../src/i18n/resources/en/common.json' with { type: 'json' };

const member = {
  provider: 'bubble',
  principal: { principalId: 'carol', kind: 'user', displayName: 'Carol' },
  member: true,
  owner: false,
};

test('members configure their own devices and Built-In settings and recover from popup failures', async ({
  page,
}, testInfo) => {
  let expired = false;
  await page.route('**/api/identity', (route) =>
    route.fulfill({ status: expired ? 401 : 200, json: expired ? {} : member }),
  );
  await page.route('**/bubble/v1/auth/authenticators', (route) =>
    route.fulfill({
      json: {
        authenticators: [
          {
            driver: 'entra',
            interactive: true,
            issuer: 'https://login.example',
            authorizationUrl: 'https://login.example/authorize',
            clientId: 'spa',
            scopes: [],
          },
        ],
      },
    }),
  );
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { useSettingsUiStore } = await load('/src/store/settingsUiStore.ts');
    useSettingsUiStore.getState().open('agent');
  });
  const dialog = page.getByRole('dialog', {
    name: en.settings.title,
    exact: true,
  });
  await expect(
    dialog.getByRole('heading', {
      name: en.settings.devicesAndAgents,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', {
      name: en.settings.devicesAndAgents,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: en.settings.people, exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: en.settings.addDevice, exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('member-settings.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('member-settings-mobile.png'),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await dialog
    .getByRole('button', { name: en.settings.addDevice, exact: true })
    .click();
  await expect(
    dialog.getByRole('button', {
      name: en.settings.agentletCommandCopy,
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('member-connect-device.png'),
  });
  let resets = 0;
  await page.route('**/api/acp/connection-credentials/reset', (route) => {
    resets++;
    return route.fulfill({ status: 204 });
  });
  await dialog
    .getByRole('button', {
      name: en.settings.agentletOtherConnectionOptions,
      exact: true,
    })
    .click();
  const resetOwn = dialog.getByRole('button', {
    name: en.settings.resetDeviceCredentials,
    exact: true,
  });
  await resetOwn.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('member-reset-devices.png'),
  });
  await resetOwn.click();
  const confirmReset = page.getByRole('dialog', {
    name: en.settings.resetDeviceCredentials,
    exact: true,
  });
  await expect(
    confirmReset.getByText(en.settings.resetDeviceCredentialsConfirm),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('member-reset-devices-confirm.png'),
  });
  await confirmReset
    .getByRole('button', {
      name: en.settings.resetDeviceCredentials,
      exact: true,
    })
    .click();
  await expect(confirmReset).toHaveCount(0);
  expect(resets).toBe(1);
  await dialog
    .getByRole('button', { name: en.settings.agentSettings, exact: true })
    .click();
  await dialog
    .getByRole('button', { name: en.settings.builtInPi, exact: true })
    .click();
  await dialog
    .getByRole('button', { name: en.settings.builtInPiConfigure, exact: true })
    .click();
  await expect(
    dialog.getByText(en.settings.chatModel, { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('member-built-in.png') });
  await dialog
    .getByRole('button', { name: en.actions.close, exact: true })
    .click();
  const previousFocus = page.locator('button:visible').first();
  await previousFocus.focus();
  expired = true;
  await page.evaluate(async () => {
    window.open = () => null;
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { AUTH_REQUIRED_EVENT } = await load('/src/api/_client.ts');
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  });
  const signIn = page.getByRole('button', {
    name: /Continue with Microsoft Entra ID/,
  });
  await expect(signIn).toBeVisible();
  await expect(signIn).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    await expect(signIn).toBeFocused();
  }
  await expect(page.locator('[inert]').first()).toHaveAttribute('inert', '');
  await signIn.click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The browser blocked the sign-in window' }),
  ).toBeVisible();
  await expect(signIn).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('popup-error.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('popup-error-mobile.png'),
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: testInfo.outputPath('popup-error-mobile-dark.png'),
  });
  expired = false;
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { AUTH_REQUIRED_EVENT } = await load('/src/api/_client.ts');
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  });
  await expect(signIn).toHaveCount(0);
  await expect(previousFocus).toBeFocused();
});

test('Bubble administrators see People in the current Settings navigation', async ({
  page,
}, testInfo) => {
  const admin = {
    ...member,
    principal: {
      principalId: 'admin',
      kind: 'user',
      displayName: 'Administrator',
    },
    owner: true,
  };
  await page.route('**/api/identity', (route) =>
    route.fulfill({ json: admin }),
  );
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: [{ workspaceId: 'carol-workspace', name: "Carol's Workspace" }],
    }),
  );
  await page.route('**/api/people', (route) =>
    route.fulfill({
      json: [
        {
          principal: admin.principal,
          member: false,
          admin: true,
          workspaces: [],
        },
        {
          principal: member.principal,
          member: true,
          admin: false,
          workspaces: [],
        },
      ],
    }),
  );
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { useSettingsUiStore } = await load('/src/store/settingsUiStore.ts');
    useSettingsUiStore.getState().open('people');
  });
  const dialog = page.getByRole('dialog', {
    name: en.settings.title,
    exact: true,
  });
  await expect(
    dialog.getByRole('heading', { name: en.settings.people, exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('Carol', { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole('switch', { name: `${en.people.access}: Carol` }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('button', {
      name: en.settings.devicesAndAgents,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: en.people.resetDevices, exact: true }),
  ).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('people-settings.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('people-settings-mobile.png'),
  });
});

test('Bubble users open a Server folder as a Workspace where Workspaces are folders', async ({
  page,
}, testInfo) => {
  await page.route('**/api/identity', (route) =>
    route.fulfill({ json: member }),
  );
  const workspace = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    name: "Carol's Workspace",
    path: '/srv/huabu/data/people/carol',
    active: true,
  };
  const opened: unknown[] = [];
  await page.route('**/api/workspace', (route) =>
    route.fulfill({
      json: {
        mode: 'free',
        configured: true,
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        name: workspace.name,
        worldCanvasId: 'world',
        capabilities: {
          canChangeWorkspace: true,
          nativePicker: false,
          namedWorkspaces: true,
          folderWorkspaces: true,
          canCreateSpaces: true,
        },
      },
    }),
  );
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() === 'POST') {
      opened.push(route.request().postDataJSON());
      return route.fulfill({ status: 500, json: { message: 'Stop here' } });
    }
    return route.fulfill({ json: [workspace] });
  });
  await page.goto('/setup');
  const folder = page.getByLabel(en.workspace.openFolder, { exact: true });
  await expect(folder).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('setup-folders.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('setup-folders-mobile.png'),
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: testInfo.outputPath('setup-folders-mobile-dark.png'),
  });
  await folder.fill('/srv/notes');
  await folder.press('Enter');
  await expect.poll(() => opened).toEqual([{ path: '/srv/notes' }]);
});
