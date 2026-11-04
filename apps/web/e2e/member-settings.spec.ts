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

test('member settings use the Built-In tab and show popup failures without leaving the app', async ({
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
      name: en.settings.agentSettings,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', {
      name: en.settings.devicesAndAgents,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: en.settings.people, exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(en.settings.chatModel, { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('member-settings.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('member-settings-mobile.png'),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
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
  await page.screenshot({ path: testInfo.outputPath('people-settings.png') });
});
