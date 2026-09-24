// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator } from '@playwright/test';

test('shared menus keep default metrics, states and behaviors without toolbar overrides', async ({
  page,
}) => {
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountMenuStylesFixture } = await load(
      '/e2e/fixtures/menu-styles.tsx',
    );
    mountMenuStylesFixture();
  });
  const checkRow = async (row: Locator) => {
    await expect(row).toHaveCSS('font-size', '13px');
    await expect(row).toHaveCSS('line-height', '20px');
    await expect(row).toHaveCSS('font-weight', '400');
    await expect(row).toHaveCSS('padding', '6px 8px');
    await expect(row).toHaveCSS('border-radius', '6px');
    await expect(row).toHaveCSS('min-height', '32px');
    const panel = row.locator('xpath=ancestor::*[@data-floating-chrome][1]');
    await expect(panel).toHaveCSS('padding', '6px 4px');
    await expect(panel).toHaveCSS('border-radius', '8px');
    for (const icon of await row.locator('svg').all()) {
      await expect(icon).toHaveCSS('width', '14px');
      await expect(icon).toHaveCSS('height', '14px');
    }
  };
  await page.getByRole('button', { name: 'Select sample' }).click();
  const selected = page.getByRole('option', { name: /First option/ });
  await checkRow(selected);
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  const label = page.getByText('New destination', { exact: true });
  await expect(label).toHaveCSS('font-size', '12px');
  await expect(label).toHaveCSS('line-height', '18px');
  await expect(label).toHaveCSS('text-align', 'left');
  await expect(label).toHaveCSS('text-transform', 'none');
  await selected
    .locator('xpath=ancestor::*[@data-floating-chrome][1]')
    .screenshot({
      path: test.info().outputPath('shared-select.png'),
    });
  await expect(
    page.getByRole('option', { name: 'Disabled option' }),
  ).toBeDisabled();
  const second = page.getByRole('option', { name: 'Second option' });
  expect(await selected.evaluate((el) => getComputedStyle(el).color)).toBe(
    await second.evaluate((el) => getComputedStyle(el).color),
  );
  await second.click();
  await expect(page.getByRole('button', { name: 'Select sample' })).toHaveText(
    'Second option',
  );
  await page
    .getByRole('button', { name: 'Second option', exact: true })
    .click();
  await expect(page.locator('[data-menu-result]')).toHaveText('second');
  await page.getByRole('button', { name: 'Split sample' }).click();
  const split = page.getByRole('option', { name: /Second option/ });
  await checkRow(split);
  await expect(split).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('option', { name: 'First option', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select sample' })).toHaveText(
    'First option',
  );

  await page.getByRole('button', { name: 'Menu sample' }).click();
  const action = page.getByRole('menuitem', { name: 'Action Ctrl+2' });
  await checkRow(action);
  await checkRow(page.getByRole('menuitem', { name: 'Link', exact: true }));
  await expect(
    page.getByRole('menuitem', { name: 'Link', exact: true }),
  ).toHaveAttribute('href', '/#destination');
  await page.keyboard.press('Tab');
  await action.focus();
  expect(
    await action.evaluate((el) => getComputedStyle(el).boxShadow),
  ).not.toBe('none');
  await action.press('Enter');
  await expect(page.locator('[data-menu-result]')).toHaveText('action');
  await expect(
    page.getByRole('menuitem', { name: 'Disabled action' }),
  ).toBeDisabled();
  const danger = page.getByRole('menuitem', { name: 'Delete', exact: true });
  expect(await danger.evaluate((el) => getComputedStyle(el).color)).not.toBe(
    await action.evaluate((el) => getComputedStyle(el).color),
  );
  await page.getByRole('menuitem', { name: 'Submenu' }).hover();
  await checkRow(page.getByRole('menuitem', { name: 'Nested action' }));
  await page.screenshot({
    path: test.info().outputPath('shared-action-menu.png'),
  });
  await page.getByRole('menuitem', { name: 'Nested action' }).click();
  await expect(page.locator('[data-menu-result]')).toHaveText('nested');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('menuitem', { name: 'Nested action' }),
  ).toHaveCount(0);
  await expect(action).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Submenu' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Menu sample' })).toBeFocused();
  await page.getByRole('button', { name: 'Menu sample' }).click();
  await action.focus();
  await page.getByRole('button', { name: 'Select sample' }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Select sample' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 320, height: 800 });
  for (const name of ['Select sample', 'Split sample']) {
    await page.getByRole('button', { name, exact: true }).click();
    const long = page.getByRole('option', { name: /^LongUnbrokenLabel/ });
    await checkRow(long);
    const panel = long.locator('xpath=ancestor::*[@data-floating-chrome][1]');
    expect(
      await panel.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.left >= 11 &&
          rect.right <= innerWidth - 11 &&
          el.scrollWidth <= el.clientWidth
        );
      }),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
  }
});
