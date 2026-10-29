// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import en from '../src/i18n/resources/en/common.json' with { type: 'json' };

import type {
  DeploymentReadinessResponse,
  ExternalAgentRuntimeConfig,
  ServiceConfig,
  ServiceConfigUpdate,
} from '@huabu/shared';

test.use({ hasTouch: false });

test('device names can be edited without a permanent transport warning', async ({
  page,
}, testInfo) => {
  let displayName = 'Windows workstation';
  let rejectSave = true;
  await page.route('**/api/acp/profiles', (route) =>
    route.fulfill({
      json: {
        profiles: [],
        selectableProfileIds: [],
        connectedDevices: [
          {
            agentletId: 'windows-device',
            displayName,
            hostname: 'desktop',
            platform: 'win32',
            arch: 'x64',
            version: '1.0.0',
            connectedAt: '2026-01-01T00:00:00.000Z',
            profileCount: 0,
          },
        ],
        agentlet: { online: true, restartAttempt: 0 },
      },
    }),
  );
  await page.route('**/api/acp/devices/windows-device', async (route) => {
    expect(route.request().method()).toBe('PATCH');
    if (rejectSave) {
      rejectSave = false;
      await route.fulfill({
        status: 503,
        json: { message: 'Device unavailable. Try again.' },
      });
      return;
    }
    displayName = route.request().postDataJSON().displayName;
    await route.fulfill({ json: { displayName } });
  });
  await page.route('**/api/deployment/readiness', (route) =>
    route.fulfill({
      json: {
        bind: { host: '0.0.0.0', scope: 'network' },
        access: { allowedHostsConfigured: true, basicAuthConfigured: true },
        owner: { policy: 'loopback-or-basic-auth', allowedForRequest: true },
        credentials: { writable: true, reason: 'available' },
        transport: { status: 'operator-unverified' },
        issues: [],
      } satisfies DeploymentReadinessResponse,
    }),
  );
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openSettingsModalFixture } = await load(
      '/e2e/fixtures/settings-components.tsx',
    );
    openSettingsModalFixture();
  });
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: en.settings.devicesAndAgents, exact: true })
    .click();
  await expect(
    dialog.getByText('Windows workstation', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/operator-managed transport/)).toHaveCount(0);
  const actions = dialog.getByRole('button', { name: / actions$/ });
  await actions.click();
  const rename = page.getByRole('menuitem', { name: en.settings.renameDevice });
  await rename.click();
  const input = dialog.getByRole('textbox', { name: en.settings.deviceName });
  await expect(input).toBeFocused();
  await input.fill('Office PC');
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText(
    'Device unavailable. Try again.',
  );
  await expect(input).toHaveValue('Office PC');
  await dialog.screenshot({
    path: testInfo.outputPath('device-rename-error.png'),
  });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Office PC', { exact: true })).toBeVisible();
  await expect(actions).toBeFocused();
  await actions.click();
  await rename.click();
  const longName = 'Workstation'.repeat(10);
  await input.fill(longName);
  await input.press('Enter');
  const row = dialog.locator('.setting-row').filter({ hasText: longName });
  for (const dark of [false, true]) {
    await page.setViewportSize({ width: dark ? 900 : 1280, height: 800 });
    await page.evaluate(
      (value) => document.documentElement.classList.toggle('dark', value),
      dark,
    );
    expect(
      await row.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await dialog.screenshot({
      path: testInfo.outputPath(
        `device-settings-${dark ? 'dark' : 'light'}.png`,
      ),
    });
  }
  await page.context().grantPermissions(['clipboard-write', 'clipboard-read']);
  await page.route('**/api/acp/connection-command', (route) =>
    route.fulfill({
      json: {
        content: 'echo connection-test',
        source: 'environment',
        warnings: ['insecure'],
      },
    }),
  );
  await dialog
    .getByRole('button', { name: en.settings.addDevice, exact: true })
    .click();
  await dialog
    .getByRole('button', { name: en.settings.agentletCommandCopy, exact: true })
    .click();
  await expect(
    page.getByText(en.settings.agentletCommandCopied, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(/not encrypted|unencrypted|insecure/i),
  ).toHaveCount(0);
  await dialog.screenshot({
    path: testInfo.outputPath('device-connection-copy.png'),
  });
});

test('Services uses field saves and shared credential confirmation without a card footer', async ({
  page,
}) => {
  let saved: ServiceConfig = {
    manifest: {
      schema: 'huabu-service/v1',
      id: 'ink-ocr',
      version: '1.0.0',
      name: 'Handwriting Recognition',
      description: 'Recognize handwriting.',
      storage: { namespace: 'integration.azureVisionInkOcr' },
      package: { files: [] },
      configuration: [
        { id: 'endpoint', type: 'url', label: 'Endpoint', required: true },
        { id: 'apiKey', type: 'secret', label: 'API key', required: true },
      ],
    },
    values: {
      endpoint: 'https://old.cognitiveservices.azure.com',
      apiKey: null,
    },
    configuredFields: ['endpoint', 'apiKey'],
    configured: true,
  };
  const writes: ServiceConfigUpdate[] = [];
  let failNext = false;
  const readiness: DeploymentReadinessResponse = {
    bind: { host: '127.0.0.1', scope: 'loopback' },
    access: { allowedHostsConfigured: false, basicAuthConfigured: false },
    owner: { policy: 'loopback-or-basic-auth', allowedForRequest: true },
    credentials: { writable: true, reason: 'available' },
    transport: { status: 'operator-unverified' },
    issues: [],
  };
  await page.route('**/api/deployment/readiness', (route) =>
    route.fulfill({ json: readiness }),
  );
  await page.route('**/api/services', (route) =>
    route.fulfill({
      json: {
        services: [
          {
            id: 'ink-ocr',
            version: '1.0.0',
            name: 'Handwriting Recognition',
            description: 'Recognize handwriting.',
            configured: true,
            availableToExternalAgent: false,
          },
        ],
      },
    }),
  );
  await page.route('**/api/services/ink-ocr', async (route) => {
    if (route.request().method() === 'PUT') {
      const update: ServiceConfigUpdate = route.request().postDataJSON();
      writes.push(update);
      if (failNext) {
        failNext = false;
        await route.fulfill({
          status: 503,
          json: { code: 'unavailable', message: 'Save unavailable' },
        });
        return;
      }
      saved = {
        ...saved,
        values: { ...saved.values, ...update.values, apiKey: null },
        configuredFields:
          update.values.apiKey === null ? ['endpoint'] : saved.configuredFields,
        configured: update.values.apiKey !== null,
      };
    }
    await route.fulfill({ json: saved });
  });
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openSettingsModalFixture } = await load(
      '/e2e/fixtures/settings-components.tsx',
    );
    openSettingsModalFixture();
  });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Services', exact: true }).click();
  const service = dialog.getByTestId('service-sections');
  await expect(service.getByText('Configured', { exact: true })).toHaveCount(0);
  await expect(
    service.getByText(en.settings.serviceUi.pendingSetup, { exact: true }),
  ).toHaveCount(0);
  await service
    .getByRole('button', {
      name: 'Configure Handwriting Recognition (Azure AI Vision)',
      exact: true,
    })
    .click();
  await expect(
    service.getByRole('button', { name: 'Save', exact: true }),
  ).toHaveCount(0);
  await expect(
    service.getByRole('button', { name: 'Discard changes' }),
  ).toHaveCount(0);
  await expect(service.locator('input[type="password"]')).toHaveCount(0);
  const endpoint = service.getByRole('textbox', {
    name: 'Endpoint',
    exact: true,
  });
  await expect(endpoint).toBeEnabled();
  await endpoint.fill('https://new.cognitiveservices.azure.com');
  expect(writes).toHaveLength(0);
  await endpoint.press('Tab');
  await expect
    .poll(() => saved.values.endpoint)
    .toBe('https://new.cognitiveservices.azure.com');
  await expect(
    service.getByRole('button', { name: 'Update Key', exact: true }),
  ).toBeEnabled();
  await service
    .getByRole('button', { name: 'Update Key', exact: true })
    .click();
  const key = service.locator('input[type="password"]');
  await expect(key).toHaveValue('');
  await key.fill('example-test-key');
  await key.press('Tab');
  expect(writes).toHaveLength(1);
  failNext = true;
  await service.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(service.getByRole('alert')).toContainText('Save unavailable');
  await expect(key).toHaveValue('example-test-key');
  await service.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(key).toHaveCount(0);
  expect(writes).toHaveLength(3);
  await endpoint.fill('https://draft.cognitiveservices.azure.com');
  failNext = true;
  await endpoint.press('Tab');
  await expect(service.getByRole('alert')).toContainText('Save unavailable');
  await service
    .getByRole('button', { name: 'Update Key', exact: true })
    .click();
  await service
    .getByRole('button', { name: 'Remove key', exact: true })
    .click();
  await expect(
    service.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  expect(writes).toHaveLength(4);
  await service.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => writes).toHaveLength(5);
  expect(writes[4]).toEqual({ values: { apiKey: null } });
  await expect(endpoint).toHaveValue(
    'https://draft.cognitiveservices.azure.com',
  );
  await expect(service.getByRole('alert')).toContainText('Save unavailable');
  await expect(
    service.getByText(en.settings.serviceUi.pendingSetup, { exact: true }),
  ).toHaveCount(0);
  await service
    .getByRole('button', {
      name: 'Configure Handwriting Recognition (Azure AI Vision)',
      exact: true,
    })
    .click();
  await expect(
    service.getByText(en.settings.serviceUi.pendingSetup, { exact: true }),
  ).toBeVisible();
});

test('Agent sections keep their defaults and runtime fields preserve drafts across folding', async ({
  page,
}) => {
  let saved: ExternalAgentRuntimeConfig = {
    idleTimeoutSecs: 600,
    maxAgents: 10,
  };
  const writes: ExternalAgentRuntimeConfig[] = [];
  let reads = 0;
  let rejectNextSave = false;
  await page.route('**/api/acp/runtime-config', async (route) => {
    if (route.request().method() === 'PUT') {
      const next: ExternalAgentRuntimeConfig = route.request().postDataJSON();
      writes.push(next);
      if (rejectNextSave) {
        rejectNextSave = false;
        await route.fulfill({
          status: 503,
          json: { error: 'Runtime save rejected' },
        });
        return;
      }
      saved = next;
    } else if (route.request().method() === 'GET') {
      reads += 1;
    }
    await route.fulfill({ json: saved });
  });
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openSettingsModalFixture } = await load(
      '/e2e/fixtures/settings-components.tsx',
    );
    openSettingsModalFixture();
  });
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: en.settings.agentSettings, exact: true })
    .click();
  let readsAfterFirstExpansion = 0;
  for (const [name, expanded] of [
    ['Utility tasks', true],
    ['Conversation and changes', false],
    ['Advanced runtime settings', false],
    ['Built-In Pi', false],
  ] as const) {
    const heading = dialog.getByRole('button', { name, exact: true });
    await expect(heading).toHaveAttribute('aria-expanded', String(expanded));
    await expect(heading).toHaveCSS('min-height', '32px');
    const section = heading.locator('xpath=ancestor::section[1]');
    if (!expanded && name !== 'Built-In Pi') {
      await expect(section).toHaveCSS('margin-bottom', '8px');
      await expect(heading.locator('..')).toHaveCSS('margin-bottom', '0px');
    }
    expect(
      await heading.evaluate((el) => {
        const icon = el.querySelector('svg');
        const label = el.querySelector('span');
        if (!icon || !label)
          throw new Error('Missing disclosure icon or label');
        return (
          icon.getBoundingClientRect().right <=
          label.getBoundingClientRect().left
        );
      }),
    ).toBe(true);
    const target = await heading.boundingBox();
    if (!target) throw new Error(`Missing click target for ${name}`);
    await heading.click({
      position: { x: target.width - 4, y: target.height / 2 },
    });
    await expect(heading).toHaveAttribute('aria-expanded', String(!expanded));
    const id = await heading.getAttribute('aria-controls');
    if (!id) throw new Error(`Missing content association for ${name}`);
    const card = dialog.locator(`[id="${id}"]`);
    if (expanded) {
      await expect(card).toBeHidden();
      await heading.press('Tab');
      expect(
        await card.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(false);
    } else {
      await expect(card).toBeVisible();
      if (name === 'Advanced runtime settings') {
        await expect(
          card.getByRole('spinbutton', {
            name: en.settings.externalAgentMaxAgents,
          }),
        ).toBeEnabled();
        readsAfterFirstExpansion = reads;
      }
    }
    await heading.press('Enter');
    await expect(heading).toHaveAttribute('aria-expanded', String(expanded));
    await expect(card).toHaveCount(1);
  }
  const behavior = dialog.getByRole('button', {
    name: 'Conversation and changes',
    exact: true,
  });
  const runtime = dialog.getByRole('button', {
    name: 'Advanced runtime settings',
    exact: true,
  });
  const builtIn = dialog.getByRole('button', {
    name: 'Built-In Pi',
    exact: true,
  });
  const rectangles = await Promise.all(
    [behavior, runtime, builtIn].map((el) => el.boundingBox()),
  );
  const [behaviorRect, runtimeRect, builtInRect] = rectangles;
  if (!behaviorRect || !runtimeRect || !builtInRect)
    throw new Error('Missing collapsed headers');
  expect(runtimeRect.y - behaviorRect.y - behaviorRect.height).toBe(8);
  expect(builtInRect.y - runtimeRect.y - runtimeRect.height).toBe(8);
  await behavior.hover();
  await expect(behavior).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await behavior.focus();
  await expect(behavior).toHaveCSS('outline-width', '2px');
  expect(Math.abs(behaviorRect.width - runtimeRect.width)).toBeLessThan(1);
  await page.setViewportSize({ width: 480, height: 800 });
  for (const name of [
    'Utility tasks',
    'Conversation and changes',
    'Advanced runtime settings',
    'Built-In Pi',
  ]) {
    const heading = dialog.getByRole('button', { name, exact: true });
    expect(
      await heading.evaluate((el) => {
        const section = el.closest('section');
        if (!section) throw new Error('Missing section');
        const bounds = section.getBoundingClientRect();
        const target = el.getBoundingClientRect();
        return (
          target.height >= 32 &&
          target.left >= bounds.left &&
          target.right <= bounds.right + 1 &&
          el.scrollWidth <= el.clientWidth + 1
        );
      }),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await dialog
    .getByRole('button', { name: 'Advanced runtime settings' })
    .click();
  const input = dialog.getByRole('spinbutton', {
    name: en.settings.externalAgentMaxAgents,
  });
  const row = input.locator(
    'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," setting-row ")][1]',
  );
  await expect(input).toBeEnabled();
  expect(readsAfterFirstExpansion).toBeGreaterThan(0);
  expect(reads).toBe(readsAfterFirstExpansion);
  const timeoutSelect = dialog.getByRole('button', {
    name: en.settings.externalAgentIdleTimeout,
    exact: true,
  });
  await input.fill('');
  await timeoutSelect.click();
  await expect(page.getByRole('option').first()).toBeVisible();
  await timeoutSelect.press('Shift+Tab');
  await expect(runtime).toBeFocused();
  await runtime.press('Space');
  await expect(runtime).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(runtime).toBeFocused();
  await runtime.press('Space');
  await expect(timeoutSelect).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(input).toHaveValue('');
  await expect(row.getByRole('button')).toHaveCount(0);
  await input.fill('12');
  expect(writes).toHaveLength(0);
  await input.press('Tab');
  await expect
    .poll(() => writes)
    .toEqual([{ idleTimeoutSecs: 600, maxAgents: 12 }]);
  await expect(input).toBeEnabled();
  await input.fill('');
  await input.press('Tab');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(row.getByRole('alert')).toBeVisible();
  expect(writes).toHaveLength(1);
  rejectNextSave = true;
  await input.fill('18');
  await input.press('Enter');
  await expect(row.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('18');
  await row.getByRole('button', { name: 'Retry saving' }).click();
  await expect.poll(() => saved.maxAgents).toBe(18);
  await expect(row.getByRole('alert')).toHaveCount(0);
  await expect(row.getByRole('button')).toHaveCount(0);
  await input.focus();
  await input.press('Enter');
  await input.press('Tab');
  expect(writes).toHaveLength(3);

  await dialog
    .getByRole('button', {
      name: en.settings.externalAgentIdleTimeout,
      exact: true,
    })
    .click();
  await page.getByRole('option', { name: 'Custom', exact: true }).click();
  const minutes = dialog.getByRole('spinbutton', {
    name: 'Custom idle timeout in minutes',
  });
  const idleRow = minutes.locator(
    'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," setting-row ")][1]',
  );
  await expect(
    idleRow.getByRole('button', { name: 'Save changes' }),
  ).toHaveCount(0);
  await minutes.fill('25');
  expect(writes).toHaveLength(3);
  await minutes.press('Tab');
  await expect
    .poll(() => saved)
    .toEqual({ idleTimeoutSecs: 1500, maxAgents: 18 });
  await expect(minutes).toBeEnabled();
  await minutes.fill('1441');
  await minutes.press('Tab');
  await expect(minutes).toHaveAttribute('aria-invalid', 'true');
  await expect(idleRow.getByRole('alert')).toBeVisible();
  expect(writes).toHaveLength(4);
  await dialog
    .getByRole('button', { name: 'Advanced runtime settings', exact: true })
    .click();
  await expect(
    dialog.locator('input[aria-label="Custom idle timeout in minutes"]'),
  ).toHaveCount(1);
  await dialog
    .getByRole('button', { name: 'Advanced runtime settings', exact: true })
    .click();
  await expect(minutes).toHaveValue('1441');
  await expect(idleRow.getByRole('alert')).toBeVisible();
  expect(reads).toBe(readsAfterFirstExpansion);
  rejectNextSave = true;
  await minutes.fill('30');
  await minutes.press('Enter');
  await expect(idleRow.getByRole('alert')).toBeVisible();
  await expect(minutes).toHaveValue('30');
  await idleRow.getByRole('button', { name: 'Retry saving' }).click();
  await expect
    .poll(() => saved)
    .toEqual({ idleTimeoutSecs: 1800, maxAgents: 18 });
  await expect(idleRow.getByRole('alert')).toHaveCount(0);
  await expect(minutes).toHaveValue('30');
  await expect(minutes).toBeEnabled();
  await minutes.focus();
  await minutes.press('Enter');
  await minutes.press('Tab');
  expect(writes).toHaveLength(6);
});

test('actual Settings uses field selectors and uniformly spaced capability cards', async ({
  page,
}) => {
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openSettingsModalFixture } = await load(
      '/e2e/fixtures/settings-components.tsx',
    );
    openSettingsModalFixture();
  });
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'General', exact: true }),
  ).toBeVisible();
  const fields = dialog.locator('button:has(.lucide-chevrons-up-down)');
  await expect(fields).toHaveCount(2);
  for (const field of await fields.all()) {
    await expect(field).toHaveCSS('font-size', '13px');
    await expect(field).toHaveCSS('border-radius', '6px');
    await expect(field).toHaveCSS('height', '32px');
  }
  await dialog.getByRole('button', { name: 'Services', exact: true }).click();
  const services = dialog.getByTestId('service-sections');
  await expect(services.locator('section').first()).toBeVisible();
  await expect(services).toHaveCSS('row-gap', '12px');
  await expect
    .poll(() =>
      services.evaluate((el) => {
        const sections = el.querySelectorAll('section');
        return (
          sections[1].getBoundingClientRect().top -
          sections[0].getBoundingClientRect().bottom
        );
      }),
    )
    .toBe(12);
  await expect(services.locator('section > .divide-y').first()).toHaveCSS(
    'box-shadow',
    'none',
  );
  await services.locator('button[aria-expanded="false"]').first().click();
  await expect(services.locator('input').first()).toBeVisible();
  await expect(services.locator('input').first()).toHaveCSS(
    'font-size',
    '13px',
  );
  await expect(services.locator('input').first()).toHaveCSS('height', '32px');
});

test('production Settings owns field geometry without gallery overrides', async ({
  page,
}) => {
  await page.goto('/playground/components');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountSettingsComponentsFixture } = await load(
      '/e2e/fixtures/settings-components.tsx',
    );
    mountSettingsComponentsFixture();
  });
  const host = page.locator('#production-settings-fixture');
  const field = host.getByRole('button', { name: 'Field select', exact: true });
  const input = host.getByRole('textbox', { name: 'Endpoint', exact: true });
  for (const control of [
    field,
    input,
    host.getByRole('button', { name: 'Field action' }),
  ]) {
    await expect(control).toHaveCSS('height', '32px');
    await expect(control).toHaveCSS('font-size', '13px');
    await expect(control).toHaveCSS('border-radius', '6px');
  }
  await expect(input).toHaveCSS('padding', '5px 10px');
  await expect(field.locator('.lucide-chevrons-up-down')).toHaveCount(1);
  await expect(host.getByRole('button', { name: 'Default select' })).toHaveCSS(
    'border-radius',
    '4px',
  );
  await expect(host.getByRole('textbox', { name: 'Default input' })).toHaveCSS(
    'font-size',
    '12px',
  );
  const row = host.locator('.setting-row').first();
  await expect(row).toHaveCSS('padding', '12px 14px');
  await expect(row.locator('p').first()).toHaveCSS('font-size', '13px');
  await expect(row.getByText('Stable help text')).toHaveCSS(
    'font-size',
    '12px',
  );
  await expect(row.getByText('Stable help text')).toHaveCSS(
    'margin-top',
    '2px',
  );
  await expect(host.locator('section > .divide-y')).toHaveCSS(
    'border-radius',
    '10px',
  );
  await expect(host.locator('section > .divide-y')).toHaveCSS(
    'box-shadow',
    'none',
  );
  await expect(field).toHaveCSS(
    'color',
    await input.evaluate((el) => getComputedStyle(el).color),
  );
  await expect(
    host.getByRole('button', { name: 'Disabled field select' }),
  ).toBeDisabled();
  await field.click();
  await expect(
    page.getByRole('option', { name: 'Disabled option' }),
  ).toBeDisabled();
  await page.getByRole('option', { name: 'Second option' }).click();
  await expect(field).toHaveText('Second option');
  await expect(field).toBeFocused();
  await input.fill('https://example.test');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await field.click();
  await expect(
    page.getByRole('option', { name: 'First option' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(field).toHaveAttribute('aria-expanded', 'false');
  for (const width of [760, 440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => host.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
  }
  await expect(row).toHaveCSS('flex-direction', 'column');
  await expect(input).toHaveValue('https://example.test');
});
