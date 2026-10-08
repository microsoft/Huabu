// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

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
  test(`Ink toolbar keeps source count and Agent identity separate in ${locale}`, async ({
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

    for (const width of [1100, 320]) {
      await page.setViewportSize({ width, height: 768 });
      await expect
        .poll(() =>
          trigger.evaluate((button) => {
            const toolbar = button.closest('.ink-context-toolbar');
            const source = toolbar?.querySelector('span[aria-label]');
            const send = toolbar?.querySelector('.canvas-context-submit');
            if (!toolbar || !source || !send) return false;
            const bounds = toolbar.getBoundingClientRect();
            const rect = button.getBoundingClientRect();
            const children = [...button.children].map((child) =>
              child.getBoundingClientRect(),
            );
            const label = children[1];
            return (
              bounds.left >= 7 &&
              bounds.right <= innerWidth - 7 &&
              toolbar.scrollWidth <= toolbar.clientWidth &&
              source.getBoundingClientRect().right + 4 <= rect.left &&
              rect.right + 4 <= send.getBoundingClientRect().left &&
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
