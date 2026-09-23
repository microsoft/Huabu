// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

for (const language of ['zh-CN', 'en']) {
  test(`edge toolbar stays compact with readable ${language} values and menu previews`, async ({
    page,
  }) => {
    page.on('pageerror', (error) => {
      throw error;
    });
    await page.goto('/playground/node-toolbars');
    await expect(page.locator('.nt-toolbar')).toHaveCount(12);
    await page.evaluate(async (locale) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { mountEdgeToolbar } = await load('/e2e/fixtures/edge-toolbar.tsx');
      await mountEdgeToolbar(locale);
    }, language);

    const toolbar = page.locator('.edge-context-toolbar');
    const controls = toolbar.locator('.edge-toolbar-value');
    await expect(toolbar).toBeVisible();
    await expect(controls).toHaveCount(4);
    const initialWidth = await toolbar.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    expect(initialWidth).toBeLessThan(330);
    await toolbar.screenshot({
      path: test.info().outputPath(`edge-toolbar-${language}-default.png`),
    });
    for (const control of await controls.all()) {
      expect(
        await control.evaluate((el) => el.getBoundingClientRect().height),
      ).toBe(32);
      await expect(control.locator('span')).not.toBeEmpty();
      await expect(control.locator('svg').first()).toBeHidden();
      await expect(control.locator('svg').last()).toBeVisible();
      await control.click();
      const items = page.getByRole('menuitem');
      await expect(items.first().locator('svg').first()).toBeVisible();
      const next = items.nth(1);
      const label = await next.innerText();
      await next.click();
      await expect(control).toHaveText(label);
      await expect(page.getByRole('menuitem')).toHaveCount(0);
    }
    // A shorter localized value should shrink its trigger, not leave a fixed slot.
    if (language === 'zh-CN') {
      expect(
        await toolbar.evaluate((el) => el.getBoundingClientRect().width),
      ).toBeLessThan(initialWidth);
    }
    await controls.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(controls.first()).toBeFocused();

    await page.setViewportSize({ width: 320, height: 800 });
    await expect
      .poll(async () =>
        toolbar.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return (
            rect.left >= 7 &&
            rect.right <= innerWidth - 7 &&
            el.scrollWidth <= el.clientWidth
          );
        }),
      )
      .toBe(true);
    for (const control of await controls.all()) {
      expect(
        await control.evaluate((el) => el.getBoundingClientRect().height),
      ).toBe(32);
    }
    await page.screenshot({
      path: test.info().outputPath(`edge-toolbar-${language}.png`),
    });
  });
}
