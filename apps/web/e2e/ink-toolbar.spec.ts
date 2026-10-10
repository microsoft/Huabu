// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

test('Ink submission spinner stays centered throughout rotation and respects reduced motion', async ({
  page,
}) => {
  await page.route(
    '**/api/canvas/ink-layout-fixture/recent-conversation',
    (route) => route.fulfill({ json: { conversation: null } }),
  );
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountInkToolbar } = await load('/e2e/fixtures/ink-toolbar.tsx');
    await mountInkToolbar('en');
    // Hold the catalogue refresh so the real toolbar stays in preparation.
    const { useAcpProfilesStore } = await load(
      '/src/store/acpProfilesStore.ts',
    );
    useAcpProfilesStore.setState({ refresh: () => new Promise(() => {}) });
  });
  const send = page.locator('.ink-context-toolbar .canvas-context-submit');
  const picker = page.locator('.ink-agent-destination-trigger');
  await expect(send).toBeEnabled();
  const idleBox = await send.boundingBox();
  await send.click();
  await expect(send).toHaveAttribute('aria-busy', 'true');
  await expect(send).toBeDisabled();
  await expect(picker).toBeDisabled();
  await expect(picker.locator('.text-warning')).toHaveCount(0);
  const spinner = send.locator('[data-loading-spinner]');
  await expect(spinner).toBeVisible();
  await expect(send.locator('.lucide-square')).toHaveCount(0);
  expect(await send.boundingBox()).toEqual(idleBox);

  const samples = await spinner.evaluate(async (element) => {
    const rotating = element.firstElementChild;
    const svg = element.querySelector('svg');
    const button = element.closest('button');
    if (!rotating || !svg || !button)
      throw new Error('Spinner structure missing');
    const animation = rotating.getAnimations()[0];
    if (!animation) throw new Error('Spinner animation missing');
    animation.pause();
    const center = (rect: DOMRect) => ({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
    const buttonCenter = center(button.getBoundingClientRect());
    const result = [];
    for (const time of [0, 125, 250, 375, 500, 625, 750, 875]) {
      animation.currentTime = time;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      result.push({
        buttonCenter,
        wrapper: center(rotating.getBoundingClientRect()),
        icon: center(svg.getBoundingClientRect()),
        transform: getComputedStyle(rotating).transform,
      });
    }
    return result;
  });
  expect(new Set(samples.map((sample) => sample.transform)).size).toBe(8);
  for (const sample of samples) {
    for (const center of [sample.wrapper, sample.icon]) {
      expect(Math.abs(center.x - sample.buttonCenter.x)).toBeLessThan(0.1);
      expect(Math.abs(center.y - sample.buttonCenter.y)).toBeLessThan(0.1);
    }
  }
  await page.screenshot({ path: test.info().outputPath('ink-submitting.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(spinner.locator(':scope > span')).toHaveCSS(
    'animation-name',
    'none',
  );
  await expect(send).toHaveAttribute('aria-label', 'Sending ink request');
});

test('Ink supports read-only Chat in new and recent destinations alongside external bindings', async ({
  page,
}) => {
  await page.route(
    '**/api/canvas/ink-layout-fixture/recent-conversation',
    (route) =>
      route.fulfill({
        json: {
          conversation: {
            nodeId: 'ink-conversation-0',
            threadId: 'ink-thread-0',
          },
        },
      }),
  );
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountInkToolbar } = await load('/e2e/fixtures/ink-toolbar.tsx');
    await mountInkToolbar('en', 2, [
      { binding: { kind: 'internal' }, mode: 'ask' },
      {
        binding: {
          kind: 'external',
          profileId: 'ink-layout-profile',
          alias: 'Copilot',
        },
        mode: 'ask',
      },
    ]);
  });
  const trigger = page.locator('.ink-agent-destination-trigger');
  await expect(trigger).toContainText('Conversation 1');
  const send = page.locator('.ink-context-toolbar .canvas-context-submit');
  await expect(send).toBeEnabled();
  await trigger.tap();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: /Conversation 1/ }),
  ).toBeEnabled();
  await expect(
    menu.getByRole('menuitem', { name: /Conversation 2/ }),
  ).toBeEnabled();
  const newGroup = menu.getByRole('group', { name: 'New conversation' });
  await expect(newGroup.getByRole('menuitem', { name: /^Chat/ })).toBeEnabled();
  await expect(
    newGroup.getByRole('menuitem', { name: /^Agent/ }),
  ).toBeEnabled();
  await menu.getByRole('menuitem', { name: /Conversation 2/ }).tap();
  await expect(trigger).toContainText('Conversation 2');
  await expect(send).toBeEnabled();
});

for (const pointerOpen of ['click', 'tap'] as const) {
  test(`${pointerOpen}-opened destination menu supports immediate keyboard navigation and focus return`, async ({
    page,
  }) => {
    await page.route(
      '**/api/canvas/ink-layout-fixture/recent-conversation',
      (route) => route.fulfill({ json: { conversation: null } }),
    );
    await page.goto('/playground/node-toolbars');
    await expect(page.locator('.nt-toolbar')).toHaveCount(12);
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { mountInkToolbar } = await load('/e2e/fixtures/ink-toolbar.tsx');
      await mountInkToolbar('en', 2);
    });
    const toolbar = page.locator('.ink-context-toolbar');
    const trigger = toolbar.locator('.ink-agent-destination-trigger');
    const previousFocus = toolbar.getByRole('button', {
      name: 'More',
    });
    await previousFocus.focus();
    await expect(previousFocus).toBeFocused();
    await trigger[pointerOpen]();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const newGroup = menu.getByRole('group', { name: 'New conversation' });
    const externalHeading = newGroup.getByText('External Agents', {
      exact: true,
    });
    await expect(externalHeading).toBeVisible();
    await expect(externalHeading).toHaveCSS('text-transform', 'none');
    await expect(externalHeading.locator('..')).toHaveCSS(
      'padding-left',
      '12px',
    );
    await expect(
      externalHeading.locator('..').locator('.bg-edge-default'),
    ).toHaveCount(0);
    await menu.screenshot({
      path: test.info().outputPath(`agent-menu-hierarchy-${pointerOpen}.png`),
    });
    await expect
      .poll(() =>
        trigger.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      )
      .toBe('rgba(0, 0, 0, 0)');
    await trigger[pointerOpen]();
    await expect(menu).toHaveCount(0);
    await trigger[pointerOpen]();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(
      menu.getByRole('menuitem', { name: /Conversation 2/ }),
    ).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(
      menu.getByRole('menuitem', { name: /Conversation 1/ }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('Conversation 1');
    await trigger.evaluate((element) => element.blur());
    await page.mouse.move(0, 0);
    await trigger.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Choose Agent session');
    await expect(trigger).toHaveAttribute(
      'aria-label',
      /Continue Conversation 1/,
    );
    await trigger[pointerOpen]();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('Conversation 1');
  });
}

test('canceling a replacement Lasso restores its manual conversation destination', async ({
  page,
}) => {
  let reads = 0;
  await page.route(
    '**/api/canvas/ink-layout-fixture/recent-conversation',
    (route) => {
      reads++;
      return route.fulfill({
        json: {
          conversation: {
            nodeId: 'ink-conversation-0',
            threadId: 'ink-thread-0',
          },
        },
      });
    },
  );
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountInkToolbar } = await load('/e2e/fixtures/ink-toolbar.tsx');
    await mountInkToolbar('en', 2);
  });
  const trigger = page.locator('.ink-agent-destination-trigger');
  await expect(trigger).toContainText('Conversation 1');
  await trigger.tap();
  await page.getByRole('menuitem', { name: /Conversation 2/ }).tap();
  await expect(trigger).toContainText('Conversation 2');
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { cancelReplacementInkSelection } = await load(
      '/e2e/fixtures/ink-toolbar.tsx',
    );
    await cancelReplacementInkSelection();
  });
  await expect(trigger).toContainText('Conversation 2');
  await expect(
    page.locator('.ink-context-toolbar .canvas-context-submit'),
  ).toBeEnabled();
  expect(reads).toBe(1);
});

test('conversation default reads server recency only for a fresh Lasso', async ({
  page,
}) => {
  let conversation: { nodeId: string; threadId: string } | null = null;
  let reads = 0;
  await page.route(
    '**/api/canvas/ink-layout-fixture/recent-conversation',
    (route) => {
      reads++;
      return route.fulfill({ json: { conversation } });
    },
  );
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountInkToolbar } = await load('/e2e/fixtures/ink-toolbar.tsx');
    await mountInkToolbar('en', 2);
  });
  const trigger = page.locator('.ink-agent-destination-trigger');
  const send = page.locator('.ink-context-toolbar .canvas-context-submit');
  await expect(trigger).toHaveText('Choose conversation');
  await expect(send).toBeDisabled();
  await trigger.tap();
  await page.getByRole('menuitem', { name: /Conversation 1/ }).tap();
  await expect(trigger).toContainText('Conversation 1');
  await expect(send).toBeEnabled();
  conversation = { nodeId: 'ink-conversation-1', threadId: 'ink-thread-1' };
  await trigger.tap();
  await page.keyboard.press('Escape');
  await expect(trigger).toContainText('Conversation 1');
  expect(reads).toBe(1);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { renewInkSelection } = await load('/e2e/fixtures/ink-toolbar.tsx');
    await renewInkSelection();
  });
  await expect(trigger).toContainText('Conversation 2');
  await expect(send).toBeEnabled();
  expect(reads).toBe(2);
});

for (const locale of ['zh-CN', 'en']) {
  test(`Ink toolbar respects a resizing canvas boundary in a wide ${locale} viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 768 });
    await page.route(
      '**/api/canvas/ink-layout-fixture/recent-conversation',
      (route) => route.fulfill({ json: { conversation: null } }),
    );
    await page.goto('/playground/node-toolbars');
    await expect(page.locator('.nt-toolbar')).toHaveCount(12);
    await page.evaluate(async (language) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { mountInkToolbar } = await load('/e2e/fixtures/ink-toolbar.tsx');
      await mountInkToolbar(language);
    }, locale);
    const canvasHost = page.locator('[data-ink-toolbar-canvas]');
    const toolbar = page.locator('.ink-context-toolbar');
    await expect(toolbar).toBeVisible();
    for (const width of [800, 320, 280, 800]) {
      await canvasHost.evaluate((host, width) => {
        host.style.left = '120px';
        host.style.right = 'auto';
        host.style.width = `${width}px`;
      }, width);
      await expect
        .poll(() =>
          toolbar.evaluate((element) => {
            const canvas = document.querySelector(
              '[data-ink-toolbar-canvas] .react-flow',
            );
            const edit = element.querySelector('.ink-edit-group');
            const agent = element.querySelector('.ink-agent-group');
            const send = element.querySelector('.canvas-context-submit');
            if (!canvas || !edit || !agent || !send)
              throw new Error('Missing toolbar fixture');
            const boundary = canvas.getBoundingClientRect();
            const bounds = element.getBoundingClientRect();
            const editBounds = edit.getBoundingClientRect();
            const agentBounds = agent.getBoundingClientRect();
            const sendBounds = send.getBoundingClientRect();
            return (
              bounds.left >= boundary.left + 7 &&
              bounds.right <= boundary.right - 7 &&
              element.scrollWidth <= element.clientWidth &&
              sendBounds.right <= agentBounds.right &&
              sendBounds.right <= boundary.right - 7 &&
              (boundary.width <= 320
                ? editBounds.bottom + 7 <= agentBounds.top
                : editBounds.top === agentBounds.top)
            );
          }),
        )
        .toBe(true);
    }
  });

  test(`Ink toolbar keeps Ink and Agent identity separate in ${locale}`, async ({
    page,
  }) => {
    await page.route(
      '**/api/canvas/ink-layout-fixture/recent-conversation',
      (route) => route.fulfill({ json: { conversation: null } }),
    );
    await page.goto('/playground/node-toolbars');
    await expect(page.locator('.nt-toolbar')).toHaveCount(12);
    await page.evaluate(async (language) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { mountInkToolbar } = await load('/e2e/fixtures/ink-toolbar.tsx');
      await mountInkToolbar(language);
    }, locale);

    const toolbar = page.locator('.ink-context-toolbar');
    const trigger = toolbar.locator('.ink-agent-destination-trigger');
    await expect(trigger).toContainText('GitHub Copilot');
    await expect(toolbar.locator('.node-toolbar-color')).toBeVisible();
    await expect(toolbar.locator('.lucide-pencil')).toBeVisible();
    await trigger.hover();
    await expect(page.getByRole('tooltip')).toHaveText(
      locale === 'zh-CN' ? '选择会话' : 'Choose Agent session',
    );

    for (const width of [1100, 320, 359, 360, 375, 390, 414, 768]) {
      await page.setViewportSize({ width, height: 768 });
      await expect
        .poll(() =>
          trigger.evaluate((button) => {
            const toolbar = button.closest('.ink-context-toolbar');
            const edit = toolbar?.querySelector('.ink-edit-group');
            const agent = toolbar?.querySelector('.ink-agent-group');
            const send = toolbar?.querySelector('.canvas-context-submit');
            if (!toolbar || !edit || !agent || !send) return false;
            const bounds = toolbar.getBoundingClientRect();
            const editBounds = edit.getBoundingClientRect();
            const agentBounds = agent.getBoundingClientRect();
            const rect = button.getBoundingClientRect();
            const children = [...button.children].map((child) =>
              child.getBoundingClientRect(),
            );
            const label = children[1];
            return (
              bounds.left >= 7 &&
              bounds.right <= innerWidth - 7 &&
              toolbar.scrollWidth <= toolbar.clientWidth &&
              (editBounds.right + 4 <= agentBounds.left ||
                editBounds.bottom + 4 <= agentBounds.top) &&
              rect.left >= agentBounds.left &&
              send.getBoundingClientRect().right <= agentBounds.right &&
              send.getBoundingClientRect().right <= innerWidth - 7 &&
              rect.right <= send.getBoundingClientRect().left &&
              label.width >= 40 &&
              children.every(
                (child, index) =>
                  child.left >= rect.left &&
                  child.right <= rect.right &&
                  (index === 0 || child.left >= children[index - 1].right),
              )
            );
          }),
        )
        .toBe(true);
      await toolbar.screenshot({
        path: test.info().outputPath(`ink-toolbar-${locale}-${width}.png`),
      });
      await trigger.tap();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByRole('menu').getByRole('group')).toHaveCount(1);
      await expect
        .poll(() =>
          page.getByRole('menu').evaluate((menu) => {
            const panel = menu.parentElement;
            const toolbar = document.querySelector('.ink-context-toolbar');
            if (!panel || !toolbar) return 0;
            return (
              panel.getBoundingClientRect().top -
              toolbar.getBoundingClientRect().bottom
            );
          }),
        )
        .toBeGreaterThanOrEqual(8);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(trigger).toBeVisible();
    }
  });
}
