// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

test.use({ hasTouch: false });

for (const theme of ['light', 'dark']) {
  for (const width of [320, 1024]) {
    test(`dropdown menus preserve scroll, focus and submenu activation at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 480 });
      await page.goto('/playground/node-toolbars');
      await page.evaluate(async (theme) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        const load = (path: string) => import(/* @vite-ignore */ path);
        const { mountDropdownMenuFixture } = await load(
          '/e2e/fixtures/dropdown-menu.tsx',
        );
        mountDropdownMenuFixture();
      }, theme);

      for (const mode of ['coordinate', 'anchored']) {
        const trigger = page.getByRole('button', { name: `${mode} actions` });
        await trigger.press('ArrowUp');
        const menu = page.getByRole('menu');
        const last = page.getByRole('menuitem', {
          name: 'Item 40',
          exact: true,
        });
        await expect(last).toBeFocused();
        expect(
          await menu.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const focused = document.activeElement;
            const scroll = element.firstElementChild;
            if (!focused || !scroll) {
              throw new Error('Missing menu focus or scroll container');
            }
            const last = focused.getBoundingClientRect();
            return (
              rect.top >= 11 &&
              rect.bottom <= innerHeight - 11 &&
              last.top >= rect.top &&
              last.bottom <= rect.bottom &&
              scroll.scrollHeight > scroll.clientHeight
            );
          }),
        ).toBe(true);
        await page.screenshot({
          path: test.info().outputPath(`long-${mode}-${theme}-${width}.png`),
        });
        await last.press('Enter');
        await expect(menu).toHaveCount(0);
        await expect(trigger).toBeFocused();

        await trigger.press('ArrowDown');
        const submenuTrigger = page.getByRole('menuitem', {
          name: 'More actions',
        });
        for (const activation of ['Enter', 'Space', 'click']) {
          await page.mouse.move(width - 1, 479);
          await submenuTrigger.hover();
          const child = page.getByRole('menuitem', { name: 'Nested action' });
          await expect(child).toBeVisible();
          if (activation === 'click') await submenuTrigger.click();
          else await submenuTrigger.press(activation);
          await expect(child).toBeFocused();
          expect(
            await child.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                rect.bottom <= innerHeight
              );
            }),
          ).toBe(true);
          if (activation === 'click') {
            await page.screenshot({
              path: test
                .info()
                .outputPath(`submenu-${mode}-${theme}-${width}.png`),
            });
          }

          await child.press('Escape');
          await expect(submenuTrigger).toBeFocused();
          await expect(child).toHaveCount(0);
        }
        await page.screenshot({
          path: test.info().outputPath(`${mode}-${theme}-${width}.png`),
        });
        await submenuTrigger.press('Tab');
        await expect(page.getByRole('menu')).toHaveCount(0);
        await expect(trigger).not.toBeFocused();
      }

      const fontTrigger = page.locator('.node-toolbar-font-trigger');
      await fontTrigger.press('ArrowDown');
      await page
        .getByRole('menuitem', { name: '24', exact: true })
        .press('Enter');
      await expect(fontTrigger).toBeFocused();
      await expect(
        page.getByRole('spinbutton', { name: 'Font size', exact: true }),
      ).toHaveValue('24');

      await page.locator('[data-filter-sample] button').last().click();
      const pdf = page.getByRole('menuitemcheckbox', { name: /PDF/ });
      await expect(pdf).toBeChecked();
      await pdf.press('Space');
      await expect(pdf).not.toBeChecked();
      await expect(pdf).toBeFocused();
      await pdf.press('Escape');

      await page.getByRole('button', { name: 'coordinate actions' }).click();
      await page.getByRole('button', { name: 'After menus' }).click();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'After menus' }),
      ).toBeFocused();

      await page.getByRole('button', { name: 'Dialog actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit name' }).press('Enter');
      await expect(page.getByRole('textbox', { name: 'Name' })).toBeFocused();
    });
  }
}

test.describe('synthesized touch', () => {
  test.use({ hasTouch: true });

  test('tap opens and enters a submenu without toggling it closed', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto('/playground/node-toolbars');
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { mountDropdownMenuFixture } = await load(
        '/e2e/fixtures/dropdown-menu.tsx',
      );
      mountDropdownMenuFixture();
    });
    await page.getByRole('button', { name: 'coordinate actions' }).tap();
    await page.getByRole('menuitem', { name: 'More actions' }).tap();
    const child = page.getByRole('menuitem', { name: 'Nested action' });
    await expect(child).toBeVisible();
    await expect(child).toBeFocused();
    await child.tap();
    await expect(page.getByRole('menu')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('menuitem', { name: 'More actions' }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});
