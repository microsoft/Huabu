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
  await page.route('**/api/people/admission', (route) =>
    route.fulfill({ json: { automatic: false, providers: ['entra'] } }),
  );
  await page.route('**/api/people', (route) =>
    route.fulfill({
      json: [
        {
          principal: admin.principal,
          member: false,
          admin: true,
          joinedAutomatically: false,
          blocked: false,
          workspaces: [],
        },
        {
          principal: member.principal,
          member: true,
          admin: false,
          joinedAutomatically: false,
          blocked: false,
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
    dialog.getByRole('switch', { name: `${en.people.serviceAccess}: Carol` }),
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

test('People lists everyone and resets devices when the admission setting cannot load', async ({
  page,
}, testInfo) => {
  const admin = {
    ...member,
    principal: { principalId: 'admin', kind: 'user', displayName: 'Admin' },
    owner: true,
  };
  await page.route('**/api/identity', (route) =>
    route.fulfill({ json: admin }),
  );
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/people/admission', (route) =>
    route.fulfill({ status: 500, json: { message: 'Internal Server Error' } }),
  );
  await page.route('**/api/people', (route) =>
    route.fulfill({
      json: [
        {
          principal: admin.principal,
          member: false,
          admin: true,
          joinedAutomatically: false,
          blocked: false,
          workspaces: [],
        },
        {
          principal: { principalId: 'ivan', kind: 'user', displayName: 'Ivan' },
          member: false,
          admin: false,
          joinedAutomatically: false,
          // The server could not read the record either.
          blocked: null,
          workspaces: [],
        },
      ],
    }),
  );
  await page.route('**/api/people/ivan/agent-credentials/reset', (route) =>
    route.fulfill({ status: 204 }),
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
  await expect(dialog.getByText(en.people.admission.loadFailed)).toBeVisible();
  await expect(
    dialog.getByRole('switch', { name: en.people.admission.title }),
  ).toHaveCount(0);
  const ivan = dialog.getByRole('listitem').filter({ hasText: 'Ivan' });
  await expect(
    ivan.getByText(en.people.status.noAccess, { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('people-admission-unavailable.png'),
  });

  const reset = page.waitForRequest(
    '**/api/people/ivan/agent-credentials/reset',
  );
  await ivan
    .getByRole('button', { name: en.people.resetDevices, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: en.people.resetDevices, exact: true })
    .getByRole('button', { name: en.people.resetDevices, exact: true })
    .click();
  await reset;
});

test('People keeps each person whole and their access switch beside or below them', async ({
  page,
}, testInfo) => {
  const admin = {
    ...member,
    principal: {
      principalId: 'admin',
      kind: 'user',
      displayName: 'Casey Jo Whitaker',
      email: 'casey.whitaker@contoso.example',
    },
    owner: true,
  };
  const morgan = {
    principalId: 'morgan',
    kind: 'user',
    displayName: 'Morgan Alexandra Chen',
    email: 'morgan.alexandra.chen@fabrikam.example',
  };
  await page.route('**/api/identity', (route) =>
    route.fulfill({ json: admin }),
  );
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ json: [{ workspaceId: 'default', name: 'Default' }] }),
  );
  await page.route('**/api/people/admission', (route) =>
    route.fulfill({ json: { automatic: false, providers: ['entra'] } }),
  );
  await page.route('**/api/people', (route) =>
    route.fulfill({
      json: [
        {
          principal: admin.principal,
          member: false,
          admin: true,
          joinedAutomatically: false,
          blocked: false,
          workspaces: [],
        },
        {
          principal: morgan,
          member: false,
          admin: false,
          joinedAutomatically: false,
          blocked: false,
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
  const name = dialog.getByText(morgan.displayName, { exact: true });
  const email = dialog.getByText(morgan.email, { exact: true });
  const toggle = dialog.getByRole('switch', {
    name: `${en.people.serviceAccess}: ${morgan.displayName}`,
  });
  await expect(name).toBeVisible();
  /** True when the element shows all of its text, with nothing cut off. */
  const whole = (locator: typeof name) =>
    locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  for (const [width, height, stacked] of [
    [1440, 900, false],
    [390, 844, true],
    [320, 700, true],
  ] as const) {
    await page.setViewportSize({ width, height });
    await toggle.scrollIntoViewIfNeeded();
    // The name and email an administrator decides on are never truncated.
    expect(await whole(name), `name at ${width}px`).toBe(true);
    expect(await whole(email), `email at ${width}px`).toBe(true);
    const emailBox = (await email.boundingBox())!;
    const toggleBox = (await toggle.boundingBox())!;
    // In a narrow list the switch moves below the person it controls; in a
    // wide one it stays beside them.
    if (stacked)
      expect(toggleBox.y, `switch at ${width}px`).toBeGreaterThanOrEqual(
        emailBox.y + emailBox.height - 1,
      );
    else
      expect(toggleBox.y, `switch at ${width}px`).toBeLessThan(
        emailBox.y + emailBox.height,
      );
    await page.screenshot({
      path: testInfo.outputPath(`people-layout-${width}.png`),
    });
  }
});

test('a slow session check shows its notice above any toast', async ({
  page,
}, testInfo) => {
  let hold: Promise<void> | null = null;
  await page.route('**/api/identity', async (route) => {
    await hold;
    await route.fulfill({ json: member });
  });
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { toast } = await load('/src/components/Common/Toast.tsx');
    toast(
      'A persistent toast whose text runs long enough to cross the top of the page',
      { duration: 0 },
    );
  });
  await expect(
    page.getByText('A persistent toast', { exact: false }),
  ).toBeVisible();
  let release!: () => void;
  hold = new Promise<void>((resolve) => (release = resolve));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const notice = page
    .getByRole('status')
    .filter({ hasText: en.auth.verifyingSession });
  await expect(notice).toBeVisible();
  // The notice is the topmost thing where it is drawn, not hidden by the toast.
  const box = (await notice.boundingBox())!;
  const onTop = await notice.evaluate(
    (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(onTop).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('verifying-over-toast.png'),
  });
  release();
  await expect(notice).toHaveCount(0);
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
