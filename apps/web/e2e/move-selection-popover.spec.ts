// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import en from '../src/i18n/resources/en/common.json' with { type: 'json' };
import zhCN from '../src/i18n/resources/zh-CN/common.json' with { type: 'json' };

test('production move anchor survives Ctrl, Cmd and Shift modifier combinations', async ({
  page,
}) => {
  await page.route('**/api/canvas', (route) =>
    route.fulfill({
      json: { canvases: [{ canvasId: 'destination', title: 'Destination' }] },
    }),
  );
  await page.goto('/playground/node-toolbars');
  await expect(page.locator('.nt-toolbar')).toHaveCount(12);
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountMoveSelectionToolbar } = await load(
      '/e2e/fixtures/move-selection-toolbar.tsx',
    );
    await mountMoveSelectionToolbar();
  });
  const toolbar = page.locator('.node-floating-toolbar');
  const trigger = toolbar.getByRole('button', { name: 'More', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('menuitem', { name: en.moveSelection.action }).click();
  const panel = page.getByRole('dialog', { name: en.moveSelection.title });
  await expect(panel).toBeVisible();
  await panel
    .getByRole('button', { name: en.moveSelection.selectDestination })
    .click();
  await page
    .getByRole('option', { name: en.moveSelection.createNewDestination })
    .click();
  const input = panel.getByRole('textbox', {
    name: en.moveSelection.newSpaceName,
  });
  await input.fill('New destination');
  const initial = await panel.boundingBox();
  if (!initial) throw new Error('Missing move panel bounds');
  expect(initial.x).toBeGreaterThan(100);
  expect(initial.y).toBeGreaterThan(100);
  const anchor = await trigger.elementHandle();
  if (!anchor) throw new Error('Missing move panel anchor');
  for (const modifier of ['Control', 'Meta']) {
    await page.keyboard.down(modifier);
    for (const withShift of [false, true]) {
      if (withShift) await page.keyboard.down('Shift');
      await expect(toolbar).toBeVisible();
      expect(await anchor.evaluate((el) => el.isConnected)).toBe(true);
      await expect(input).toBeFocused();
      const box = await panel.boundingBox();
      if (!box)
        throw new Error('Move panel disappeared while modifiers were held');
      expect(Math.abs(box.x - initial.x)).toBeLessThan(1);
      expect(Math.abs(box.y - initial.y)).toBeLessThan(1);
      if (withShift) await page.keyboard.up('Shift');
    }
    await page.keyboard.up(modifier);
  }
  await input.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.locator('.react-flow__node').focus();
  await page.keyboard.down('Control');
  await expect(toolbar).toHaveCount(0);
  await page.keyboard.up('Control');
  await expect(toolbar).toBeVisible();
});

for (const consumePointer of [false, true]) {
  test(`canvas press closes the move panel and clears selection (capture consumed: ${consumePointer})`, async ({
    page,
  }) => {
    await page.route('**/api/canvas', (route) =>
      route.fulfill({
        json: { canvases: [{ canvasId: 'destination', title: 'Destination' }] },
      }),
    );
    await page.goto('/playground/node-toolbars');
    await expect(page.locator('.nt-toolbar')).toHaveCount(12);
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { mountMoveSelectionToolbar } = await load(
        '/e2e/fixtures/move-selection-toolbar.tsx',
      );
      await mountMoveSelectionToolbar();
    });
    const toolbar = page.locator('.node-floating-toolbar');
    await toolbar.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: en.moveSelection.action }).click();
    const panel = page.getByRole('dialog', { name: en.moveSelection.title });
    await expect(panel).toBeVisible();
    await panel
      .getByRole('button', { name: en.moveSelection.selectDestination })
      .click();
    await expect(
      page.getByRole('option', { name: 'Destination', exact: true }),
    ).toBeVisible();
    const pane = page.locator('.react-flow__pane');
    if (consumePointer) {
      await pane.evaluate((element) => {
        element.addEventListener(
          'pointerdown',
          (event) => {
            event.stopPropagation();
            event.stopImmediatePropagation();
          },
          { capture: true },
        );
      });
    }
    const bounds = await pane.boundingBox();
    if (!bounds) throw new Error('Missing canvas pane bounds');
    await page.mouse.move(bounds.x + 100, bounds.y + 650);
    await page.mouse.down();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.mouse.up();
    await expect(toolbar).toHaveCount(0);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  });
}

for (const [language, strings] of [
  ['en', en],
  ['zh-CN', zhCN],
] as const) {
  test(`move popover uses matching controls and nested dismissal in ${language}`, async ({
    page,
  }) => {
    await page.addInitScript((locale) => {
      localStorage.setItem('huabu.language', locale);
    }, language);
    await page.goto('/playground/node-toolbars');
    const trigger = page
      .getByRole('group', { name: 'Note 工具栏', exact: true })
      .getByRole('button', { name: '更多', exact: true });
    const panel = page.getByRole('dialog', {
      name: strings.moveSelection.title,
    });
    const selector = panel.getByRole('button', {
      name: strings.moveSelection.selectDestination,
    });
    const input = panel.getByRole('textbox', {
      name: strings.moveSelection.newSpaceName,
    });
    const open = async () => {
      await trigger.click();
      await page
        .getByRole('menuitem', { name: '移至其他 Space', exact: true })
        .click();
      await expect(panel).toBeVisible();
      await expect(selector).toBeFocused();
    };

    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await open();
      await expect(panel).not.toHaveAttribute('aria-modal', 'true');
      await expect(panel).not.toContainText(strings.moveSelection.frameNotice);
      await selector.click();
      const newSpace = page.getByRole('option', {
        name: strings.moveSelection.createNewDestination,
      });
      await expect(newSpace).toBeVisible();
      expect(
        await newSpace.evaluate((el) =>
          el.previousElementSibling?.getAttribute('role'),
        ),
      ).toBe('separator');
      await expect(
        page.getByText(language === 'en' ? 'New destination' : '新目标', {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(newSpace).toHaveCSS('font-size', '13px');
      await newSpace.focus();
      await page.keyboard.press('Escape');
      await expect(newSpace).toHaveCount(0);
      await expect(selector).toBeFocused();
      await expect(panel).toBeVisible();

      await selector.click();
      await newSpace.click();
      await expect(input).toBeFocused();
      const controls = panel.locator('button, input[type="text"]');
      expect(
        await controls.evaluateAll((elements) =>
          elements.map((el) => ({
            height: el.getBoundingClientRect().height,
            fontSize: getComputedStyle(el).fontSize,
          })),
        ),
      ).toEqual(
        Array.from({ length: 4 }, () => ({ height: 32, fontSize: '13px' })),
      );
      await expect
        .poll(() =>
          panel.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.left >= 11 &&
              rect.right <= innerWidth - 11 &&
              rect.top >= 11 &&
              rect.bottom <= innerHeight - 11 &&
              el.scrollWidth <= el.clientWidth
            );
          }),
        )
        .toBe(true);
      const surface = panel.locator('..');
      await expect(surface).toHaveCSS('padding', '12px');
      await expect(panel).toHaveCSS('gap', '12px');
      await expect(panel).toHaveCSS('line-height', '20px');
      await expect(panel.getByRole('heading').locator('..')).toHaveCSS(
        'gap',
        '4px',
      );
      for (const description of await panel.locator('p').all()) {
        await expect(description).toHaveCSS('font-size', '12px');
        await expect(description).toHaveCSS('line-height', '18px');
      }
      const fieldGap = await input.evaluate((el) => {
        const selector = el.parentElement?.querySelector('button');
        if (!selector) throw new Error('Missing grouped destination selector');
        return (
          el.getBoundingClientRect().top -
          selector.getBoundingClientRect().bottom
        );
      });
      expect(fieldGap).toBe(8);
      const notice = panel.getByText(strings.moveSelection.boundaryNotice, {
        exact: true,
      });
      const actions = notice.locator('..').getByRole('button');
      await expect(actions).toHaveCount(2);
      await expect(notice.locator('..')).toHaveCSS('gap', '8px');
      await expect(
        panel.getByRole('button', {
          name: strings.moveSelection.confirm,
          exact: true,
        }),
      ).toBeDisabled();
      await input.fill('   ');
      await expect(
        panel.getByRole('button', {
          name: strings.moveSelection.confirm,
          exact: true,
        }),
      ).toBeDisabled();
      await input.fill('New destination');
      await expect(
        panel.getByRole('button', {
          name: strings.moveSelection.confirm,
          exact: true,
        }),
      ).toBeEnabled();
      await surface.screenshot({
        path: test.info().outputPath(`move-${language}-${width}.png`),
      });
      await input.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }

    await open();
    await selector.click();
    await page
      .getByRole('option', { name: strings.moveSelection.createNewDestination })
      .click();
    await input.fill('Created Space');
    await input.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: '样例目标：Created Space' }),
    ).toBeVisible();

    await open();
    await expect(input).toHaveCount(0);
    await panel.getByRole('checkbox').uncheck();
    await page
      .getByRole('heading', { name: 'Node toolbars', exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await open();
    await expect(panel.getByRole('checkbox')).toBeChecked();
  });
}
