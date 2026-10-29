// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import en from '../src/i18n/resources/en/common.json' with { type: 'json' };

import type { ElectronLocalAgentState } from '../src/hooks/useElectron';
import type {
  AcpAgentCliInfo,
  AgentProfileView,
  ConnectedAgentletDevice,
} from '@huabu/shared';

const windowsId = 'c717d73c-7188-44ca-a6bd-67455f4cd3e8';
const longAlias =
  'GitHub Copilot (ChristydeMacBook-Air.local: darwin arm64) - workspace code review';

test('editing does not flash unsupported warnings before capabilities arrive', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let releaseDetection!: () => void;
  const detection = new Promise<void>((resolve) => {
    releaseDetection = resolve;
  });
  await page.route('**/api/acp/profiles', (route) =>
    route.fulfill({
      json: {
        profiles: [
          {
            id: 'reviewer',
            alias: 'Reviewer',
            agentletId: 'mac',
            workingDirPath: '/work',
            launch: { kind: 'acp-harness', harnessId: 'copilot' },
          },
        ],
        selectableProfileIds: ['reviewer'],
        connectedDevices: [
          {
            agentletId: 'mac',
            displayName: 'My Mac',
            version: '1.0',
            connectedAt: '2026-01-01T00:00:00.000Z',
            profileCount: 1,
          },
        ],
        agentlet: null,
      },
    }),
  );
  await page.route('**/api/acp/agent-cli?*', async (route) => {
    await detection;
    await route.fulfill({
      json: {
        agents: [
          {
            id: 'copilot',
            displayName: 'Copilot',
            status: 'ready',
            installHint: '',
            capabilities: { autoApprove: true, customLaunchCommand: false },
          },
        ],
      },
    });
  });
  try {
    await page.goto('/playground/components');
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { openSettingsModalFixture } = await load(
        '/e2e/fixtures/settings-components.tsx',
      );
      openSettingsModalFixture();
    });
    const dialog = page.getByRole('dialog', {
      name: en.settings.title,
      exact: true,
    });
    await dialog
      .getByRole('button', { name: en.settings.devicesAndAgents, exact: true })
      .click();
    await dialog
      .getByRole('button', { name: 'Edit “Reviewer”', exact: true })
      .click();
    const name = dialog.getByRole('textbox', {
      name: en.settings.displayName,
      exact: true,
    });
    const approval = dialog.getByRole('switch', {
      name: en.settings.autoApproveAllToolCalls,
    });
    await expect(name).toBeVisible();
    await expect(approval).toBeDisabled();
    await expect(
      dialog.getByText(en.settings.profileApprovalUnsupported, { exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText(en.settings.profileExecutionEditingUnavailable, {
        exact: true,
      }),
    ).toHaveCount(0);
    await name.fill('Draft while loading');
    const before = await approval.boundingBox();
    releaseDetection();
    await expect(approval).toBeEnabled();
    await expect(name).toHaveValue('Draft while loading');
    await expect(
      dialog.getByText(en.settings.profileApprovalUnsupported, { exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText(en.settings.profileExecutionEditingUnavailable, {
        exact: true,
      }),
    ).toHaveCount(0);
    expect(await approval.boundingBox()).toEqual(before);
  } finally {
    releaseDetection();
  }
});

test('local connection actions and offline device groups remain stable', async ({
  page,
}, testInfo) => {
  const localDevice: ConnectedAgentletDevice = {
    agentletId: 'local-mac',
    displayName: 'My Mac',
    hostname: 'mac',
    version: '1.0',
    connectedAt: '2026-01-01T00:00:00.000Z',
    profileCount: 1,
  };
  const remoteDevice = {
    ...localDevice,
    agentletId: 'remote-win',
    displayName: 'Windows workstation',
    hostname: 'windows',
  };
  const profiles: AgentProfileView[] = [
    {
      id: 'local-agent',
      alias: 'Local reviewer',
      agentletId: localDevice.agentletId,
      workingDirPath: '/work',
      launch: { kind: 'acp-command', command: 'review' },
    },
    {
      id: 'remote-agent',
      alias: 'Remote reviewer',
      agentletId: remoteDevice.agentletId,
      workingDirPath: 'C:\\work',
      launch: { kind: 'acp-command', command: 'review' },
    },
  ];
  let enabled = true;
  const changes: boolean[] = [];
  await page.route('**/__e2e/local-agent', async (route) => {
    enabled = route.request().postDataJSON().enabled;
    changes.push(enabled);
    await route.fulfill({
      json: {
        enabled,
        agentletId: localDevice.agentletId,
        device: localDevice,
        status: enabled ? 'connected' : 'disabled',
        error: null,
      } satisfies ElectronLocalAgentState,
    });
  });
  await page.route('**/api/acp/profiles', (route) =>
    route.fulfill({
      json: {
        profiles,
        selectableProfileIds: enabled ? ['local-agent'] : [],
        connectedDevices: enabled ? [localDevice] : [],
        knownDevices: [localDevice, remoteDevice],
        agentlet: null,
      },
    }),
  );
  await page.goto('/playground/components');
  await page.evaluate(async (device) => {
    let state: ElectronLocalAgentState = {
      enabled: true,
      agentletId: device.agentletId,
      device,
      status: 'connected',
      error: null,
    };
    const listeners = new Set<(next: ElectronLocalAgentState) => void>();
    window.electronBridge = {
      isElectron: true,
      isRemoteServer: true,
      platform: 'darwin',
      titleBarHeight: 0,
      versions: { node: '', chrome: '', electron: '' },
      localAgent: {
        getState: async () => state,
        setEnabled: async (enabled) => {
          const response = await fetch('/__e2e/local-agent', {
            method: 'POST',
            body: JSON.stringify({ enabled }),
          });
          if (!response.ok) throw new Error('Fixture connection failed');
          state = await response.json();
          for (const listener of listeners) listener(state);
          return state;
        },
        onState: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    };
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { openSettingsModalFixture } = await load(
      '/e2e/fixtures/settings-components.tsx',
    );
    openSettingsModalFixture();
  }, localDevice);
  const dialog = page.getByRole('dialog', {
    name: en.settings.title,
    exact: true,
  });
  await dialog
    .getByRole('button', { name: en.settings.devicesAndAgents, exact: true })
    .click();
  const local = dialog.locator('[data-device-id="local-mac"]');
  const remote = dialog.locator('[data-device-id="remote-win"]');
  await expect(
    local.getByText('Local reviewer', { exact: true }),
  ).toBeVisible();
  await expect(remote.getByRole('status')).toHaveText(
    en.settings.localAgentDisabled,
  );
  await expect(
    remote.getByRole('button', {
      name: en.settings.localAgentConnect,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    remote.getByRole('button', { name: en.settings.addAgent, exact: true }),
  ).toHaveCount(0);
  await expect(
    remote.getByRole('button', { name: 'Edit “Remote reviewer”' }),
  ).toBeVisible();
  await expect(
    local.getByRole('button', {
      name: en.settings.localAgentDisconnect,
      exact: true,
    }),
  ).toHaveCount(0);
  await local.getByRole('button', { name: 'My Mac actions' }).click();
  const disconnect = page.getByRole('menuitem', {
    name: en.settings.localAgentDisconnect,
    exact: true,
  });
  await expect(disconnect).toBeVisible();
  await dialog.screenshot({
    path: testInfo.outputPath('local-connected-menu.png'),
  });
  await disconnect.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(
    local.getByRole('button', {
      name: en.settings.localAgentConnect,
      exact: true,
    }),
  ).toBeVisible();
  await expect(local.getByRole('status')).toHaveCount(0);
  await expect(
    local.getByText('Local reviewer', { exact: true }),
  ).toBeVisible();
  await expect(
    local.getByRole('button', { name: en.settings.addAgent, exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(en.settings.agentUnavailable, { exact: true }),
  ).toHaveCount(0);
  for (const width of [1280, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      local.getByRole('button', {
        name: en.settings.localAgentConnect,
        exact: true,
      }),
    ).toBeInViewport();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const gap = await remote.evaluate((element) => {
      const previous = element.previousElementSibling;
      if (!previous) throw new Error('Missing local device');
      return (
        element.getBoundingClientRect().top -
        previous.getBoundingClientRect().bottom
      );
    });
    expect(gap).toBe(12);
    await page.mouse.move(0, 0);
    await dialog.screenshot({
      path: testInfo.outputPath(`offline-device-groups-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const fold = local.getByRole('button', { name: /My Mac This device/ });
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await local
    .getByRole('button', { name: en.settings.localAgentConnect, exact: true })
    .click();
  await expect(
    local.getByRole('button', { name: en.settings.addAgent, exact: true }),
  ).toBeVisible();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(remote.getByRole('status')).toHaveText(
    en.settings.localAgentDisabled,
  );
  expect(changes).toEqual([false, true]);
});

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? 'touch actions' : 'pointer actions', () => {
    test.use({ hasTouch });
    test('device groups and progressive creation preserve identity, drafts and explicit submission', async ({
      page,
    }, testInfo) => {
      const devices: ConnectedAgentletDevice[] = [
        {
          agentletId: 'mac-uuid',
          displayName: 'My Mac',
          hostname: 'mac',
          platform: 'darwin',
          arch: 'arm64',
          version: '1.0.0',
          connectedAt: '2026-01-01T00:00:00Z',
          profileCount: 3,
        },
        {
          agentletId: windowsId,
          displayName: 'Windows workstation',
          hostname: 'win',
          platform: 'win32',
          arch: 'x64',
          version: '1.0.1',
          connectedAt: '2026-01-01T00:00:00Z',
          profileCount: 0,
        },
      ];
      const profiles: AgentProfileView[] = [
        {
          id: 'long-name',
          alias: longAlias,
          agentletId: 'mac-uuid',
          workingDirPath: '/work',
          launch: { kind: 'acp-harness', harnessId: 'codex' },
        },
        {
          id: 'copilot-1',
          alias: 'copilot',
          agentletId: 'mac-uuid',
          workingDirPath: '/work',
          launch: { kind: 'acp-harness', harnessId: 'copilot' },
        },
        {
          id: 'claude-1',
          alias: 'Code review',
          agentletId: 'mac-uuid',
          workingDirPath: '/work',
          launch: { kind: 'acp-harness', harnessId: 'claude' },
        },
      ];
      let ready = false;
      let probes = 0;
      let writes = 0;
      let mutations = 0;
      await page.route('**/api/acp/agentlets/*/discover', async (route) => {
        mutations++;
        await route.fulfill({
          status: 500,
          json: { message: 'Unexpected provisioning' },
        });
      });
      await page.route('**/api/acp/profiles', async (route) => {
        if (route.request().method() === 'POST') {
          writes++;
          const input = route.request().postDataJSON();
          expect(input.agentletId).toBe(windowsId);
          expect(input.alias).toBe('Windows reviewer');
          expect(input.workingDirPath).toBe('C:\\work\\review');
          expect(input.launch).toEqual({
            kind: 'acp-harness',
            harnessId: 'claude',
            options: { autoApprove: false },
          });
          const profile = { ...input, id: 'created-profile' };
          profiles.push(profile);
          await route.fulfill({ json: profile });
        } else
          await route.fulfill({
            json: {
              profiles,
              selectableProfileIds: profiles.map((profile) => profile.id),
              connectedDevices: devices,
              agentlet: null,
            },
          });
      });
      await page.route('**/api/acp/agent-cli?*', async (route) => {
        probes++;
        expect(
          new URL(route.request().url()).searchParams.get('agentletId'),
        ).toBe(windowsId);
        const agents: AcpAgentCliInfo[] = [
          'copilot',
          'claude',
          'gemini',
          'codex',
          'qwen',
          'kimi',
          'opencode',
          'cursor',
          'codebuddy',
          'hermes',
        ].map((id) => ({
          id,
          displayName: id === 'claude' ? 'Claude' : id,
          status:
            id === 'copilot' || (id === 'claude' && ready)
              ? 'ready'
              : id === 'claude'
                ? 'adapter-missing'
                : 'not-found',
          capabilities: { autoApprove: true, customLaunchCommand: false },
          installHint: `Install ${id} on this device`,
        }));
        await route.fulfill({ json: { agents } });
      });
      await page.goto('/playground/components');
      await page.evaluate(async () => {
        const load = (path: string) => import(/* @vite-ignore */ path);
        const { openSettingsModalFixture } = await load(
          '/e2e/fixtures/settings-components.tsx',
        );
        openSettingsModalFixture();
      });
      const dialog = page.getByRole('dialog', {
        name: en.settings.title,
        exact: true,
      });
      await dialog
        .getByRole('button', {
          name: en.settings.devicesAndAgents,
          exact: true,
        })
        .click();
      const mac = dialog.locator('[data-device-id="mac-uuid"]');
      const windows = dialog.locator(`[data-device-id="${windowsId}"]`);
      await expect(mac.getByText('Code review', { exact: true })).toBeVisible();
      await expect(mac.getByText('claude', { exact: true })).toBeVisible();
      await expect(mac.getByText('copilot', { exact: true })).toHaveCount(1);
      expect(probes).toBe(0);
      const menu = mac.getByRole('button', {
        name: 'Edit “Code review”',
        exact: true,
      });
      await page.mouse.move(0, 0);
      await expect(menu).toHaveCSS('opacity', '1');
      const idleMenuColor = await menu.evaluate(
        (element) => getComputedStyle(element).color,
      );
      await menu.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(menu).toHaveCSS('opacity', '1');
      await expect(menu).not.toHaveCSS('color', idleMenuColor);
      const deleteButton = mac.getByRole('button', {
        name: 'Delete “Code review”',
        exact: true,
      });
      await expect(deleteButton).toBeVisible();
      await expect(deleteButton).not.toHaveAttribute('aria-haspopup');
      await expect(menu).not.toHaveAttribute('aria-haspopup');
      const profileRow = menu.locator(
        'xpath=ancestor::div[contains(@class,"group/profile")]',
      );
      await expect(profileRow).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      await mac.getByText('Code review', { exact: true }).hover();
      await expect(menu).toHaveCSS('opacity', '1');
      await expect(profileRow).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      for (const width of [1280, 480, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const alias = mac.getByText(longAlias, { exact: true });
        await expect(alias).toHaveCSS('white-space', 'nowrap');
        await expect(alias).toHaveCSS('text-overflow', 'ellipsis');
        await expect(alias).toHaveAttribute('title', longAlias);
        expect(
          await alias.evaluate(
            (element) => element.scrollWidth > element.clientWidth,
          ),
        ).toBe(true);
        const rowBounds = await profileRow.boundingBox();
        expect(rowBounds?.height).toBe(40);
        const centers = await profileRow.evaluate((element) => {
          const center = (target: Element) => {
            const rect = target.getBoundingClientRect();
            return rect.y + rect.height / 2;
          };
          return [
            center(element.querySelector('svg')!),
            ...Array.from(element.querySelectorAll('span[title]'), center),
          ];
        });
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(0.5);
        const profileRight = await deleteButton.evaluate(
          (element) => element.getBoundingClientRect().right,
        );
        const deviceRight = await mac
          .getByRole('button', { name: 'My Mac actions' })
          .evaluate((element) => element.getBoundingClientRect().right);
        expect(profileRight).toBe(deviceRight);
        expect(
          await dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await dialog.screenshot({
          path: testInfo.outputPath(`overview-refined-${width}.png`),
          animations: 'disabled',
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      if (hasTouch) {
        await menu.focus();
        await page.keyboard.press('Tab');
      } else {
        await deleteButton.hover();
      }
      await expect(deleteButton).not.toHaveCSS('color', idleMenuColor);
      await expect(page.getByRole('tooltip')).toHaveText(en.actions.delete);
      await deleteButton.click();
      const confirmation = page.getByRole('dialog', {
        name: en.settings.deleteProfile,
        exact: true,
      });
      await expect(confirmation).toBeVisible();
      await confirmation
        .getByRole('button', { name: en.actions.cancel, exact: true })
        .click();
      await expect(confirmation).toHaveCount(0);
      await expect(deleteButton).toBeFocused();
      const deviceToggle = mac.getByRole('button', {
        name: 'My Mac',
        exact: true,
      });
      await deviceToggle.hover();
      await expect(deviceToggle).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      await deviceToggle.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(deviceToggle).toBeFocused();
      await expect(deviceToggle).toHaveCSS('outline-style', 'solid');
      await windows
        .getByRole('button', { name: 'Windows workstation', exact: true })
        .click();
      await expect(
        windows.getByRole('button', {
          name: en.settings.addAgent,
          exact: true,
        }),
      ).toBeVisible();
      await dialog.screenshot({ path: testInfo.outputPath('overview.png') });
      await windows
        .getByRole('button', { name: 'Windows workstation actions' })
        .click();
      const info = page.getByRole('group', {
        name: en.settings.deviceInformation,
        exact: true,
      });
      await expect(
        info.getByText('c717d73c…d3e8', { exact: true }),
      ).toBeVisible();
      await expect(
        info.getByText(en.settings.connectionProgramVersion),
      ).toBeVisible();
      await page
        .context()
        .grantPermissions(['clipboard-write', 'clipboard-read']);
      const copyId = info.getByRole('menuitem', {
        name: en.settings.copyDeviceId,
      });
      const copyIcon = copyId.locator('svg');
      await page.mouse.move(0, 0);
      await expect(copyIcon).toHaveCSS('opacity', hasTouch ? '1' : '0');
      const idleBounds = await copyId.boundingBox();
      const idRight = await copyId
        .locator('code')
        .evaluate((element) => element.getBoundingClientRect().right);
      const versionRight = await info
        .getByText('1.0.1', { exact: true })
        .evaluate((element) => element.getBoundingClientRect().right);
      expect(idRight).toBe(versionRight);
      await expect(copyIcon).toHaveCSS('position', 'absolute');
      await page.getByRole('menu').screenshot({
        path: testInfo.outputPath('device-menu.png'),
        animations: 'disabled',
      });
      await info.getByText(en.settings.deviceId, { exact: true }).hover();
      await expect(copyIcon).toHaveCSS('opacity', '1');
      expect(await copyId.boundingBox()).toEqual(idleBounds);
      expect(
        await copyIcon.evaluate(
          (element) => element.getBoundingClientRect().right,
        ),
      ).toBe(idRight);
      await page.getByRole('menu').screenshot({
        path: testInfo.outputPath('device-menu-hover.png'),
        animations: 'disabled',
      });
      await page.mouse.move(0, 0);
      await page.keyboard.press('End');
      await expect(copyId).toBeFocused();
      await expect(copyIcon).toHaveCSS('opacity', '1');
      expect(await copyId.boundingBox()).toEqual(idleBounds);
      await expect(page.getByRole('tooltip')).toHaveText(windowsId);
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        windowsId,
      );
      await page.keyboard.press('Escape');
      await expect(info).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await windows
        .getByRole('button', { name: en.settings.addAgent, exact: true })
        .click();
      await expect(
        dialog.getByRole('heading', {
          name: en.settings.newAgentProfile,
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog.locator('button[aria-pressed]')).toHaveCount(11);
      await expect(
        dialog.getByText('Windows workstation', { exact: true }),
      ).toBeVisible();
      await dialog.screenshot({ path: testInfo.outputPath('choose.png') });
      const missing = dialog.getByRole('button', {
        name: /gemini.*Not detected/,
      });
      await expect(missing).toBeEnabled();
      const missingRow = missing.locator('..');
      await expect(missingRow).toHaveCSS('border-bottom-style', 'solid');
      await expect(missingRow).toHaveCSS('border-bottom-width', '1px');
      await expect(missing).toHaveCSS('cursor', 'pointer');
      const missingStatus = missing.getByText(en.settings.agentNotDetected, {
        exact: true,
      });
      await page.mouse.move(0, 0);
      await expect(missingStatus).toBeVisible();
      await expect(missingStatus).toHaveClass(/text-fg-muted/);
      await expect(
        dialog.getByText(en.settings.agentConfigurable, { exact: true }),
      ).toHaveClass(/text-success/);
      await expect(
        dialog.getByText(en.settings.agentAdapterRequired, { exact: true }),
      ).toHaveClass(/text-fg-default/);
      const optionRows = dialog.locator('button[aria-pressed]');
      await expect(optionRows.locator('svg.lucide-chevron-right')).toHaveCount(
        11,
      );
      const arrowPositions: number[] = [];
      for (const row of await optionRows.all()) {
        const arrow = row.locator('svg.lucide-chevron-right');
        await expect(arrow).toBeVisible();
        await expect(arrow).toHaveCSS('opacity', '1');
        await expect(arrow).toHaveAttribute('aria-hidden', 'true');
        await expect(arrow).toHaveClass(/text-fg-muted/);
        arrowPositions.push(
          await arrow.evaluate(
            (element) => element.getBoundingClientRect().right,
          ),
        );
      }
      expect(new Set(arrowPositions).size).toBe(1);
      await expect(missing.locator('svg')).toHaveCount(1);
      await missing.hover();
      await expect(missing).not.toHaveAttribute('aria-describedby');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await missing.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(missing).toBeFocused();
      await expect(missing).toHaveCSS('outline-style', 'solid');
      await expect(missingStatus).toBeVisible();
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(
        dialog.getByText('Install gemini on this device', { exact: true }),
      ).toBeVisible();
      expect(writes).toBe(0);
      expect(mutations).toBe(0);
      await dialog
        .getByRole('button', { name: en.settings.changeAgent, exact: true })
        .click();
      await expect(missing).toBeFocused();
      await expect(missing).toHaveAttribute('aria-pressed', 'true');
      for (const [width, dark, locale] of [
        [1280, false, 'zh-CN'],
        [480, true, 'zh-CN'],
        [320, false, 'en'],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          async ({ dark, locale }) => {
            document.documentElement.classList.toggle('dark', dark);
            const load = (path: string) => import(/* @vite-ignore */ path);
            const { i18n } = await load('/src/i18n/index.ts');
            await i18n.changeLanguage(locale);
          },
          { dark, locale },
        );
        const localizedDialog = page.locator(
          '[role="dialog"][aria-modal="true"]',
        );
        await expect(
          localizedDialog.locator('button[aria-pressed]'),
        ).toHaveCount(11);
        const statusContrasts = await localizedDialog
          .locator('button[aria-pressed] span.text-xs')
          .evaluateAll((statuses) => {
            const context = document.createElement('canvas').getContext('2d', {
              willReadFrequently: true,
            });
            if (!context) throw new Error('Missing contrast sample');
            const luminance = (color: string) => {
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              const rgb = context.getImageData(0, 0, 1, 1).data;
              return [0.2126, 0.7152, 0.0722].reduce((total, weight, i) => {
                const channel = rgb[i] / 255;
                return (
                  total +
                  weight *
                    (channel <= 0.04045
                      ? channel / 12.92
                      : ((channel + 0.055) / 1.055) ** 2.4)
                );
              }, 0);
            };
            return statuses.map((status) => {
              const style = getComputedStyle(status);
              const foreground = luminance(style.color);
              const background = luminance(
                style.getPropertyValue('--bg-surface'),
              );
              return (
                (Math.max(foreground, background) + 0.05) /
                (Math.min(foreground, background) + 0.05)
              );
            });
          });
        expect(statusContrasts).toHaveLength(10);
        for (const contrast of statusContrasts)
          expect(contrast).toBeGreaterThanOrEqual(4.5);
        expect(
          await localizedDialog.evaluate(
            (el) => el.scrollWidth <= el.clientWidth,
          ),
        ).toBe(true);
        await localizedDialog.screenshot({
          path: testInfo.outputPath(`choose-${width}-${locale}.png`),
          animations: 'disabled',
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      const probesBeforeRecheck = probes;
      await dialog
        .getByRole('button', { name: /Claude.*Connection component required/ })
        .click();
      await expect(
        dialog.getByText('Install claude on this device', { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', {
          name: en.settings.createProfile,
          exact: true,
        }),
      ).toBeDisabled();
      await dialog.screenshot({ path: testInfo.outputPath('install.png') });
      ready = true;
      await dialog
        .getByRole('button', { name: en.settings.recheckAgent, exact: true })
        .click();
      await dialog
        .getByRole('textbox', { name: en.settings.displayName, exact: true })
        .fill('Windows reviewer');
      await dialog
        .getByRole('textbox', {
          name: en.settings.workingDirectory,
          exact: true,
        })
        .fill('C:\\work\\review');
      await dialog
        .getByRole('button', { name: en.settings.changeAgent, exact: true })
        .click();
      await expect(
        dialog.getByRole('button', { name: /Claude.*Ready to configure/ }),
      ).toHaveAttribute('aria-pressed', 'true');
      await dialog
        .getByRole('button', {
          name: en.settings.customCommand,
          exact: true,
        })
        .click();
      await expect(
        dialog.getByRole('textbox', {
          name: en.settings.launchCommand,
          exact: true,
        }),
      ).toBeVisible();
      await dialog
        .getByRole('button', { name: en.settings.changeAgent, exact: true })
        .click();
      await dialog
        .getByRole('button', { name: /Claude.*Ready to configure/ })
        .click();
      await expect(
        dialog.getByRole('textbox', {
          name: en.settings.displayName,
          exact: true,
        }),
      ).toHaveValue('Windows reviewer');
      await expect(
        dialog.getByRole('textbox', {
          name: en.settings.workingDirectory,
          exact: true,
        }),
      ).toHaveValue('C:\\work\\review');
      expect(probes).toBe(probesBeforeRecheck + 1);
      expect(writes).toBe(0);
      expect(mutations).toBe(0);
      for (const [width, dark] of [
        [1280, false],
        [480, true],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle('dark', dark),
          dark,
        );
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await dialog.screenshot({
          path: testInfo.outputPath(`configure-${width}.png`),
          animations: 'disabled',
        });
      }
      await dialog
        .getByRole('button', { name: en.settings.createProfile, exact: true })
        .click();
      await expect(
        windows.getByText('Windows reviewer', { exact: true }),
      ).toBeVisible();
      expect(writes).toBe(1);
    });
  });
}
